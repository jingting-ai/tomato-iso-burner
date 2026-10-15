/**
 * 只读的极简 ISO 9660 读取器 —— 只为「看清镜像里装的是什么系统」服务。
 *
 * 它做三件事：
 *   1. 扫描第 16 扇区起的卷描述符，拿到卷标、根目录，以及 Joliet /
 *      Rock Ridge / El Torito / UDF 的存在性；
 *   2. 按路径查找文件、列目录（优先走 Joliet 树，以便拿到长文件名和中文名）；
 *   3. 读取小文件内容，用于 .disk/info、.treeinfo 这类纯文本线索。
 *
 * 全程只读，不写盘、不改动任何东西，也不需要管理员权限。
 */

import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

/** 卷描述符扫描起点：ISO 9660 规定主卷描述符从第 16 个逻辑扇区开始 */
const DESC_START_SECTOR = 16
/** 扫描多少个扇区（兼容 UDF 混合盘把 PVD 往后挪的情况） */
const DESC_SCAN_SECTORS = 16
/** 单个目录最多读取的字节数，防止损坏镜像把内存吃满 */
const MAX_DIR_BYTES = 8 * 1024 * 1024
/** 单个文本线索文件最多读取的字节数 */
export const MAX_TEXT_BYTES = 1024 * 1024

export interface IsoEntry {
  /** 条目名（已去掉 ISO9660 的 ";1" 版本后缀） */
  name: string
  /** 数据起始逻辑块号 */
  lba: number
  /** 字节长度（目录则是目录数据长度） */
  size: number
  isDir: boolean
}

/** 统一的目录条目（ISO9660 与 UDF 两套解析共用） */
export interface FsEntry {
  name: string
  isDir: boolean
}

/** 镜像文件系统读取器的统一接口 */
export interface ImageFs {
  /** 容器描述，如 "ISO 9660 + Joliet + UDF" */
  readonly container: string
  /** 卷标 */
  readonly volumeLabel: string
  /** 卷内是否含 El Torito 引导记录 */
  readonly hasElTorito: boolean
  /** 列目录（'' 表示根目录） */
  list(dirPath: string): Promise<FsEntry[]>
  exists(filePath: string): Promise<boolean>
  /** 文件字节长度（目录或不存在时返回 null） */
  size(filePath: string): Promise<number | null>
  /** 读取文件开头若干字节 */
  head(filePath: string, bytes: number): Promise<Buffer | null>
  /**
   * 读取文件的任意区段（offset 相对文件头，越界自动截断）。
   * install.wim 动辄 7GB，而我们要的信息只在文件末尾几 KB，必须能定点读。
   */
  read(filePath: string, offset: number, length: number): Promise<Buffer | null>
  /** 读取小文本文件内容 */
  text(filePath: string, maxBytes?: number): Promise<string | null>
  close(): Promise<void>
}

export interface IsoHeader {
  /** 主卷标（PVD 卷标识符，ASCII） */
  volumeId: string
  /** Joliet 卷标（可含中文） */
  jolietVolumeId: string
  /** 逻辑块大小，通常 2048 */
  blockSize: number
  /** 一卷有多少个逻辑块 */
  volumeBlocks: number
  hasJoliet: boolean
  hasRockRidge: boolean
  /** 存在 El Torito 引导记录卷描述符 */
  hasElTorito: boolean
  /** 存在 UDF 卷识别序列（BEA01 / NSR0x） */
  hasUdf: boolean
  root: IsoEntry
  jolietRoot: IsoEntry | null
}

export class NotIsoError extends Error {
  readonly hasUdf: boolean
  constructor(hasUdf: boolean) {
    super(hasUdf ? '这是 UDF 格式的光盘镜像，未找到 ISO 9660 卷描述符' : '未找到光盘文件系统，不是 ISO 9660 镜像')
    this.name = 'NotIsoError'
    this.hasUdf = hasUdf
  }
}

/* ----------------------------- 底层工具 ----------------------------- */

/** 把 buffer 从给定位置读满，返回实际读到的字节数 */
async function readFully(fh: FileHandle, buf: Buffer, pos: number): Promise<number> {
  let total = 0
  while (total < buf.length) {
    const { bytesRead } = await fh.read(buf, total, buf.length - total, pos + total)
    if (bytesRead <= 0) break
    total += bytesRead
  }
  return total
}

/** ISO9660 记录里的定长字符串：latin1 解码 + 去 NUL + 去首尾空白 */
function fixedStr(buf: Buffer, from: number, to: number): string {
  return buf.toString('latin1', from, to).replace(/\0/g, '').trim()
}

/**
 * 解码目录记录里的文件标识符。
 * ISO 9660 是 8.3 大写并带 ";1"；Joliet 是 UCS-2 大端，可含中文。
 */
function decodeName(raw: Buffer, ucs2: boolean): string {
  if (raw.length === 1 && (raw[0] === 0 || raw[0] === 1)) return raw[0] === 0 ? '.' : '..'

  let s: string
  if (ucs2) {
    const b = Buffer.from(raw)
    if (b.length % 2 === 1) return b.toString('latin1')
    b.swap16()
    s = b.toString('utf16le')
  } else {
    s = raw.toString('latin1')
  }

  const semi = s.indexOf(';')
  if (semi >= 0) s = s.slice(0, semi)
  if (s.length > 1 && s.endsWith('.')) s = s.replace(/\.+$/, '')
  return s
}

function parseRecord(buf: Buffer, off: number, ucs2: boolean): IsoEntry | null {
  if (off + 34 > buf.length) return null
  const len = buf[off]
  if (len < 34 || off + len > buf.length) return null
  const lba = buf.readUInt32LE(off + 2)
  const size = buf.readUInt32LE(off + 10)
  const flags = buf[off + 25]
  const nameLen = buf[off + 32]
  if (33 + nameLen > len) return null
  return {
    name: decodeName(buf.subarray(off + 33, off + 33 + nameLen), ucs2),
    lba,
    size,
    isDir: (flags & 0x02) !== 0
  }
}

/* ----------------------------- 主体 ----------------------------- */

export class IsoImage implements ImageFs {
  readonly header: IsoHeader
  private readonly fh: FileHandle
  private readonly ucs2: boolean
  private readonly cache = new Map<string, IsoEntry[]>()

  private constructor(fh: FileHandle, header: IsoHeader) {
    this.fh = fh
    this.header = header
    this.ucs2 = header.jolietRoot !== null
  }

  static async open(filePath: string): Promise<IsoImage> {
    let fh: FileHandle | null = null
    try {
      fh = await fsp.open(filePath, 'r')
      const desc = Buffer.alloc(2048 * DESC_SCAN_SECTORS)
      const got = await readFully(fh, desc, DESC_START_SECTOR * 2048)
      if (got < 2048) throw new NotIsoError(false)

      let pvd: Buffer | null = null
      let svd: Buffer | null = null
      let hasUdf = false
      let hasElTorito = false

      for (let off = 0; off + 2048 <= got; off += 2048) {
        const type = desc[off]
        const id = desc.toString('latin1', off + 1, off + 6)
        if (id === 'BEA01' || id === 'NSR02' || id === 'NSR03' || id === 'TEA01') {
          hasUdf = true
          continue
        }
        if (id !== 'CD001') continue
        if (type === 0) hasElTorito = true
        else if (type === 1 && !pvd) pvd = desc.subarray(off, off + 2048)
        else if (type === 2 && !svd) svd = desc.subarray(off, off + 2048)
        // 注意：type 255 是 ISO9660 的描述符序列终止符，但 UDF 的卷识别序列
        // （BEA01/NSR02/TEA01）通常紧跟在它后面，所以这里不能提前 break。
      }

      if (!pvd) throw new NotIsoError(hasUdf)

      const blockSize = pvd.readUInt16LE(128) || 2048
      const root = parseRecord(pvd, 156, false)
      if (!root) throw new NotIsoError(hasUdf)

      // Joliet 补充卷的转义序列必须是 %/@ 或 %/C 或 %/E
      let jolietRoot: IsoEntry | null = null
      if (svd && svd[88] === 0x25 && svd[89] === 0x2f) {
        jolietRoot = parseRecord(svd, 156, true)
      }

      // Rock Ridge：根目录记录带系统使用区时，检查其中是否有 RR/SP 签名
      let hasRockRidge = false
      const rootLen = pvd[156]
      if (rootLen > 34) {
        const su = pvd.toString('latin1', 156 + 34, Math.min(156 + rootLen, 2048))
        hasRockRidge = su.includes('RR') || su.includes('SP')
      }

      const header: IsoHeader = {
        volumeId: fixedStr(pvd, 40, 72),
        jolietVolumeId: svd ? fixedStr(svd, 40, 72) : '',
        blockSize,
        volumeBlocks: pvd.readUInt32LE(80),
        hasJoliet: jolietRoot !== null,
        hasRockRidge,
        hasElTorito,
        hasUdf,
        root,
        jolietRoot
      }

      return new IsoImage(fh, header)
    } catch (e) {
      if (fh) await fh.close().catch(() => undefined)
      throw e
    }
  }

  async close(): Promise<void> {
    await this.fh.close().catch(() => undefined)
  }

  get container(): string {
    const parts = ['ISO 9660']
    if (this.header.hasJoliet) parts.push('Joliet')
    if (this.header.hasRockRidge) parts.push('Rock Ridge')
    if (this.header.hasUdf) parts.push('UDF')
    return parts.join(' + ')
  }

  get volumeLabel(): string {
    return this.header.jolietVolumeId || this.header.volumeId || ''
  }

  get hasElTorito(): boolean {
    return this.header.hasElTorito
  }

  /** 真正被使用的根目录（优先 Joliet） */
  private get base(): IsoEntry {
    return this.header.jolietRoot ?? this.header.root
  }

  private async entriesOf(dir: IsoEntry): Promise<IsoEntry[]> {
    const key = `${dir.lba}:${dir.size}`
    const hit = this.cache.get(key)
    if (hit) return hit

    const want = Math.min(Math.max(dir.size, this.header.blockSize), MAX_DIR_BYTES)
    const buf = Buffer.alloc(want)
    const got = await readFully(this.fh, buf, dir.lba * this.header.blockSize)

    const out: IsoEntry[] = []
    let off = 0
    while (off + 34 <= got) {
      const len = buf[off]
      if (len === 0) {
        // 记录不跨扇区，遇到填充跳到下一个扇区
        const next = (Math.floor(off / 2048) + 1) * 2048
        if (next <= off) break
        off = next
        continue
      }
      if (len < 34 || off + len > got) break
      const e = parseRecord(buf, off, this.ucs2)
      if (e) out.push(e)
      off += len
    }

    this.cache.set(key, out)
    return out
  }

  /** 列目录（传 '' 表示根目录） */
  async list(dirPath: string): Promise<IsoEntry[]> {
    const dir = dirPath ? await this.lookup(dirPath) : this.base
    if (!dir || !dir.isDir) return []
    const ents = await this.entriesOf(dir)
    return ents.filter((e) => e.name !== '.' && e.name !== '..')
  }

  /** 按路径查找条目，路径分隔符 / 或 \ 均可，比较时忽略大小写 */
  async lookup(filePath: string): Promise<IsoEntry | null> {
    const parts = filePath.split(/[\\/]+/).filter((s) => s && s !== '.')
    let cur = this.base
    for (const part of parts) {
      const ents = await this.entriesOf(cur)
      const want = part.toUpperCase()
      const found = ents.find((e) => e.name.toUpperCase() === want)
      if (!found) return null
      cur = found
    }
    return cur
  }

  async exists(filePath: string): Promise<boolean> {
    return (await this.lookup(filePath)) !== null
  }

  /** 文件字节长度（目录或不存在时返回 null） */
  async size(filePath: string): Promise<number | null> {
    const e = await this.lookup(filePath)
    return !e || e.isDir ? null : e.size
  }

  /**
   * 读取文件的任意区段。
   * ISO 9660 的普通文件在卷上是连续存放的，所以直接按「起始块号 + 段内偏移」定位；
   * 极少数跨多个 extent 的巨型文件（ISO9660 单文件上限 4GB，Windows 媒体里的大文件
   * 都放在 UDF 侧）如果在这里读到错位内容，上层的内容校验会发现并放弃，不会误判。
   */
  async read(filePath: string, offset: number, length: number): Promise<Buffer | null> {
    const e = await this.lookup(filePath)
    if (!e || e.isDir) return null
    if (!Number.isFinite(offset) || offset < 0 || length <= 0 || offset >= e.size) {
      return Buffer.alloc(0)
    }
    const want = Math.min(length, e.size - offset)
    const buf = Buffer.alloc(want)
    const got = await readFully(this.fh, buf, e.lba * this.header.blockSize + offset)
    return buf.subarray(0, got)
  }

  /** 读取文件开头若干字节（目录返回 null） */
  async head(filePath: string, bytes: number): Promise<Buffer | null> {
    return await this.read(filePath, 0, bytes)
  }

  /** 读取小文本文件，失败返回 null */
  async text(filePath: string, maxBytes = MAX_TEXT_BYTES): Promise<string | null> {
    const buf = await this.head(filePath, Math.min(maxBytes, MAX_TEXT_BYTES))
    if (!buf) return null
    return buf.toString('utf8').replace(/^\uFEFF/, '')
  }
}
