/**
 * 极简 UDF 读取器（只读）。
 *
 * 为什么需要它：Windows 10/11 官方 ISO 是 ISO9660 + UDF 混合盘，但为了让
 * install.wim 突破 4GB 限制，真正的内容全部放在 UDF 分区里，ISO9660 部分只剩下
 * 一个 README.TXT。只解析 ISO9660 会看到一个空盘，所以必须能读 UDF。
 *
 * 解析链路：AVDP(256 扇区) → 主卷描述符序列 → 分区描述符 + 逻辑卷描述符
 * → 文件集描述符 → 根目录 ICB → 文件入口(FE/EFE) → 文件标识描述符(FID)。
 * 只实现识别镜像所需的最小子集，遇到超出范围的结构直接抛 NotUdfError 由上层兜底。
 */

import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { MAX_TEXT_BYTES, type FsEntry, type ImageFs } from './reader'

const SECTOR = 2048
const TAG_AVDP = 2
const TAG_PARTITION = 5
const TAG_LOGICAL_VOLUME = 6
const TAG_TERMINATOR = 8
const TAG_FSD = 256
const TAG_FID = 257
const TAG_FE = 261
const TAG_EFE = 266

export class NotUdfError extends Error {
  constructor(message = '未找到 UDF 卷结构') {
    super(message)
    this.name = 'NotUdfError'
  }
}

/** 目录项：UDF 里每个条目都通过 ICB（文件入口）定位 */
interface UdfEntry extends FsEntry {
  /** 文件入口所在逻辑块号（相对分区起点） */
  icb: number
}

interface FileEntryInfo {
  fileType: number
  infoLength: number
  allocType: number
  ads: Buffer
}

async function readAt(fh: FileHandle, buf: Buffer, pos: number): Promise<number> {
  let total = 0
  while (total < buf.length) {
    const { bytesRead } = await fh.read(buf, total, buf.length - total, pos + total)
    if (bytesRead <= 0) break
    total += bytesRead
  }
  return total
}

/** 解码 UDF 的 OSTA 压缩 Unicode 文件名（首字节 8 = Latin-1，16 = UCS-2 大端） */
function decodeOstaName(b: Buffer): string {
  if (b.length === 0) return ''
  const id = b[0]
  const body = b.subarray(1)
  if (id === 16) {
    const n = body.length - (body.length % 2)
    const c = Buffer.from(body.subarray(0, n))
    c.swap16()
    return c.toString('utf16le').replace(/\u0000+$/, '')
  }
  return body.toString('latin1').replace(/\u0000+$/, '')
}

/** 解码 UDF 的 dstring（定长字符串，首位是压缩标识） */
function decodeDstring(b: Buffer): string {
  return decodeOstaName(b).replace(/\u0000/g, '').trim()
}

export class UdfImage implements ImageFs {
  private readonly fh: FileHandle
  private partStart = -1
  private rootIcb = -1
  private label = ''
  private elTorito = false
  private readonly feCache = new Map<number, FileEntryInfo>()
  private readonly dirCache = new Map<number, UdfEntry[]>()

  private constructor(fh: FileHandle) {
    this.fh = fh
  }

  static async open(filePath: string): Promise<UdfImage> {
    const fh = await fsp.open(filePath, 'r')
    try {
      const img = new UdfImage(fh)
      await img.init()
      return img
    } catch (e) {
      await fh.close().catch(() => undefined)
      throw e
    }
  }

  get container(): string {
    return 'UDF'
  }

  get volumeLabel(): string {
    return this.label
  }

  get hasElTorito(): boolean {
    return this.elTorito
  }

  private async readSector(absSector: number): Promise<Buffer> {
    const b = Buffer.alloc(SECTOR)
    const got = await readAt(this.fh, b, absSector * SECTOR)
    return b.subarray(0, got)
  }

  private async init(): Promise<void> {
    const st = await this.fh.stat()
    const total = Math.floor(st.size / SECTOR)

    // 规范要求锚点卷描述符指针位于 256 号扇区，部分工具只写在末尾，两个都试
    let avdp: Buffer | null = null
    for (const s of [256, total - 1, total - 257]) {
      if (s < 0 || s >= total) continue
      const b = await this.readSector(s)
      if (b.length >= 32 && b.readUInt16LE(0) === TAG_AVDP) {
        avdp = b
        break
      }
    }
    if (!avdp) throw new NotUdfError()

    const vdsLen = avdp.readUInt32LE(16)
    const vdsLoc = avdp.readUInt32LE(20)
    if (vdsLoc <= 0 || vdsLen <= 0) throw new NotUdfError()

    const count = Math.min(Math.ceil(vdsLen / SECTOR), 64)
    let lvd: Buffer | null = null
    for (let i = 0; i < count; i++) {
      const b = await this.readSector(vdsLoc + i)
      if (b.length < 512) break
      const tag = b.readUInt16LE(0)
      if (tag === TAG_PARTITION) this.partStart = b.readUInt32LE(188)
      else if (tag === TAG_LOGICAL_VOLUME) lvd = b
      else if (tag === TAG_TERMINATOR) break
    }
    if (!lvd || this.partStart < 0) throw new NotUdfError()

    this.label = decodeDstring(lvd.subarray(84, 212))

    // 逻辑卷描述符里的 Logical Volume Contents Use 指向文件集描述符。
    // 注意它的逻辑块号可以合法地是 0（oscdimg 生成的 Windows ISO 就是如此），
    // 所以这里只判负数，不能把 0 当成非法值。
    const fsdLb = lvd.readUInt32LE(252)
    const fsd = await this.readSector(this.partStart + fsdLb)
    if (fsd.readUInt16LE(0) !== TAG_FSD) throw new NotUdfError('文件集描述符标签异常')
    this.rootIcb = fsd.readUInt32LE(404)
    if (this.rootIcb < 0) throw new NotUdfError('根目录 ICB 非法')

    // ISO9660 侧是否带 El Torito 引导记录（UDF 本身不含引导概念）
    for (let s = 16; s < 32; s++) {
      const b = await this.readSector(s)
      if (b.length < 8) break
      if (b[0] === 0 && b.toString('latin1', 1, 6) === 'CD001') {
        this.elTorito = true
        break
      }
    }
  }

  /** 读取文件入口（可能横跨多个扇区） */
  private async fe(icb: number): Promise<FileEntryInfo> {
    const hit = this.feCache.get(icb)
    if (hit) return hit

    let raw = await this.readSector(this.partStart + icb)
    const tag = raw.readUInt16LE(0)
    if (tag !== TAG_FE && tag !== TAG_EFE) throw new NotUdfError(`文件入口标签异常：${tag}`)

    const isEfe = tag === TAG_EFE
    const adLen = raw.readUInt32LE(isEfe ? 212 : 172)
    // 分配描述符紧跟在扩展属性之后，所以要跳过 lengthOfExtendedAttributes
    const eaLen = raw.readUInt32LE(isEfe ? 208 : 168)
    const adStart = (isEfe ? 216 : 176) + eaLen

    const need = adStart + adLen
    if (need > raw.length) {
      const merged = Buffer.alloc(Math.ceil(need / SECTOR) * SECTOR)
      raw.copy(merged, 0)
      for (let i = 1; i * SECTOR < need; i++) {
        const nb = await this.readSector(this.partStart + icb + i)
        nb.copy(merged, i * SECTOR)
      }
      raw = merged
    }

    const info: FileEntryInfo = {
      fileType: raw[27],
      infoLength: Number(raw.readBigUInt64LE(56)),
      allocType: raw.readUInt16LE(34) & 0x07,
      ads: raw.subarray(adStart, Math.min(adStart + adLen, raw.length))
    }
    this.feCache.set(icb, info)
    return info
  }

  /**
   * 读取文件在 [offset, offset+length) 区段内的数据。
   * 按分配描述符链逐段定位，只读真正需要的那几 KB —— install.wim 有 7GB，
   * 但我们要的版本信息只在文件末尾，不能整份读进来。
   */
  private async readRange(info: FileEntryInfo, offset: number, length: number): Promise<Buffer> {
    const total = info.infoLength
    if (!Number.isFinite(offset) || offset < 0 || length <= 0 || offset >= total) {
      return Buffer.alloc(0)
    }
    const end = Math.min(total, offset + length)
    const out = Buffer.alloc(end - offset)

    // 内联数据（短文件直接写在文件入口里）
    if (info.allocType === 3) return info.ads.subarray(offset, end)
    if (info.allocType === 2) throw new NotUdfError('暂不支持 extended_ad 分配描述符')
    if (info.allocType !== 0 && info.allocType !== 1) throw new NotUdfError('未知的分配描述符类型')

    const step = info.allocType === 1 ? 16 : 8
    let pos = 0 // 当前段在文件内的起始偏移
    for (let off = 0; off + step <= info.ads.length && pos < end; off += step) {
      const len = info.ads.readUInt32LE(off) & 0x3fffffff
      const lb = info.ads.readUInt32LE(off + 4)
      if (len <= 0) break
      const segEnd = pos + len
      if (segEnd > offset && pos < end) {
        const from = Math.max(offset, pos) - pos
        const to = Math.min(end, segEnd) - pos
        const chunk = Buffer.alloc(to - from)
        const got = await readAt(this.fh, chunk, (this.partStart + lb) * SECTOR + from)
        chunk.subarray(0, got).copy(out, Math.max(offset, pos) - offset)
      }
      pos = segEnd
    }
    return out
  }

  /** 读出文件入口指向的全部数据（目录也走这里） */
  private async readData(info: FileEntryInfo): Promise<Buffer> {
    return await this.readRange(info, 0, info.infoLength)
  }

  private async entriesOf(icb: number): Promise<UdfEntry[]> {
    const hit = this.dirCache.get(icb)
    if (hit) return hit

    const info = await this.fe(icb)
    if (info.fileType !== 4) return []

    const data = await this.readData(info)
    const out: UdfEntry[] = []
    let off = 0
    while (off + 38 <= data.length) {
      if (data.readUInt16LE(off) !== TAG_FID) break
      const chara = data[off + 18]
      const lfi = data[off + 19]
      const icbLb = data.readUInt32LE(off + 24)
      const liu = data.readUInt16LE(off + 36)
      const nameStart = off + 38 + liu
      const nameEnd = nameStart + lfi
      if (nameEnd > data.length) break
      off += Math.ceil((38 + liu + lfi) / 4) * 4

      // bit3 = 上级目录条目，bit2 = 已删除
      if (lfi === 0 || (chara & 0x08) !== 0 || (chara & 0x04) !== 0) continue
      out.push({
        name: decodeOstaName(data.subarray(nameStart, nameEnd)),
        isDir: (chara & 0x02) !== 0,
        icb: icbLb
      })
    }
    this.dirCache.set(icb, out)
    return out
  }

  private async resolve(p: string): Promise<number | null> {
    const parts = p.split(/[\\/]+/).filter((s) => s && s !== '.')
    let icb = this.rootIcb
    for (const part of parts) {
      const ents = await this.entriesOf(icb)
      const want = part.toUpperCase()
      const found = ents.find((e) => e.name.toUpperCase() === want)
      if (!found) return null
      icb = found.icb
    }
    return icb
  }

  async list(dirPath: string): Promise<FsEntry[]> {
    const icb = dirPath ? await this.resolve(dirPath) : this.rootIcb
    if (icb === null) return []
    const info = await this.fe(icb)
    if (info.fileType !== 4) return []
    return this.entriesOf(icb)
  }

  async exists(filePath: string): Promise<boolean> {
    return (await this.resolve(filePath)) !== null
  }

  /** 文件字节长度（目录或不存在时返回 null） */
  async size(filePath: string): Promise<number | null> {
    const icb = await this.resolve(filePath)
    if (icb === null) return null
    const info = await this.fe(icb)
    return info.fileType === 4 ? null : info.infoLength
  }

  async head(filePath: string, bytes: number): Promise<Buffer | null> {
    return await this.read(filePath, 0, bytes)
  }

  /** 定点读取文件的任意区段，用于读 install.wim 末尾的版本信息 */
  async read(filePath: string, offset: number, length: number): Promise<Buffer | null> {
    const icb = await this.resolve(filePath)
    if (icb === null) return null
    const info = await this.fe(icb)
    if (info.fileType === 4) return null
    return await this.readRange(info, offset, length)
  }

  async text(filePath: string, maxBytes = MAX_TEXT_BYTES): Promise<string | null> {
    const buf = await this.head(filePath, Math.min(maxBytes, MAX_TEXT_BYTES))
    if (!buf) return null
    return buf.toString('utf8').replace(/^\uFEFF/, '')
  }

  async close(): Promise<void> {
    await this.fh.close().catch(() => undefined)
  }
}
