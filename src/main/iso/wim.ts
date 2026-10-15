/**
 * 从 Windows 安装映像（install.wim / install.esd）里读出「这到底是什么版本」。
 *
 * 为什么必须这么做：Windows 的「启封包」版本（23H2、25H2）和它的基础版本
 * （22H2、24H2）共用同一套二进制 —— 安装盘里连 setup.exe 自己报的都是基础内核号。
 * 实测 Windows 11 25H2 的官方安装盘：setup.exe 写的是 10.0.26100.7920，
 * 而系统本体的真实版本是 26200.8037。也就是说，只看文件版本永远分不出 24H2 和 25H2。
 *
 * 真实版本只写在 install.wim / install.esd 内部的 XML 资源里（未压缩的 UTF-16LE），
 * 所以这里把它读出来。顺带还能拿到版次清单、映像数量和架构。
 *
 * WIM 头部里的资源表每项 24 字节：
 *   +0  u32  资源大小
 *   +8  u64  资源在 WIM 文件中的偏移
 * 三个资源依次为：偏移表(0x30) / XML(0x48) / 引导元数据(0x60)。
 * XML 资源紧贴文件末尾，并且是整份文件里唯一以 UTF-16 BOM + "<WIM>" 开头的东西，
 * 因此这里用「offset + size 正好等于文件长度」+ BOM 双重校验来确认没读错位置。
 *
 * 全部只读，不写任何东西。
 */

import type { ImageFs } from './reader'

/** 单个映像（安装时可选的一个版本） */
export interface WimImage {
  index: number
  /** 本地化显示名，如「Windows 11 专业中文版」 */
  displayName: string
  /** 内部版次标识，如 ProfessionalCountrySpecific */
  editionId: string
  /** 系统内核版本，如 26200 */
  build: number
  /** 内核补丁级别，如 8037 */
  spBuild: number
  /** 服务分支，如 ge_release */
  branch: string
  /** WIM 架构代号（9 = x64，12 = ARM64） */
  arch: number
}

export interface WimInfo {
  /** WIM 格式版本，如 1.13 / ESD */
  formatVersion: string
  /** 映像总数 */
  imageCount: number
  /** 映像清单（按索引顺序） */
  images: WimImage[]
}

/** XML 资源上限，防止损坏镜像让内存爆掉（真实媒体最大也就几十 KB） */
const MAX_XML_BYTES = 8 * 1024 * 1024

/** WIM 的架构代号 → 展示文案 */
const WIM_ARCH: Record<number, string> = {
  0: 'x86 (32 位)',
  1: 'MIPS',
  2: 'Alpha',
  3: 'PowerPC',
  5: 'ARM (32 位)',
  6: 'IA64',
  9: 'x86_64 (64 位)',
  12: 'ARM64'
}

export function wimArchLabel(code: number): string {
  return WIM_ARCH[code] ?? ''
}

/** XML 里的实体（版次名里有 ® 之类）还原成普通字符 */
function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return m ? decodeXml(m[1]).trim() : ''
}

/** 资源表项：大小在 +0，偏移在 +8 */
function resourceAt(head: Buffer, at: number, fileSize: number): { size: number; offset: number } | null {
  if (at + 16 > head.length) return null
  const size = head.readUInt32LE(at)
  const offset = Number(head.readBigUInt64LE(at + 8))
  if (!Number.isFinite(offset) || offset <= 0 || size <= 0 || size > MAX_XML_BYTES) return null
  if (offset + size > fileSize) return null
  return { size, offset }
}

/** 读出并解析 WIM 的 XML；读不到（不是 WIM、格式异常）返回 null */
export async function readWimInfo(fs: ImageFs, wimPath: string): Promise<WimInfo | null> {
  const fileSize = await fs.size(wimPath)
  if (!fileSize || fileSize < 0x1000) return null

  const head = await fs.head(wimPath, 0x80)
  if (!head || head.length < 0x70) return null
  if (head.toString('latin1', 0, 8) !== 'MSWIM\0\0\0') return null

  // XML 资源在 0x48；个别工具写出的槽位顺序不同，顺带试另外两个位置
  let text: string | null = null
  for (const at of [0x48, 0x30, 0x60]) {
    const r = resourceAt(head, at, fileSize)
    if (!r) continue
    const buf = await fs.read(wimPath, r.offset, r.size)
    if (!buf || buf.length < 16) continue
    // 未压缩的 UTF-16LE 以 BOM + "<WIM>" 开头；压缩过的（老格式）会在这里被排除
    if (buf[0] !== 0xff || buf[1] !== 0xfe) continue
    if (buf.toString('utf16le', 2, 12) !== '<WIM>') continue
    text = buf.toString('utf16le').replace(/^\uFEFF/, '')
    break
  }
  if (!text) return null

  const images: WimImage[] = []
  const blocks = text.match(/<IMAGE\s[^>]*>[\s\S]*?<\/IMAGE>/gi) ?? []
  for (const block of blocks) {
    const index = Number(/<IMAGE\s[^>]*INDEX="(\d+)"/i.exec(block)?.[1] ?? images.length + 1)
    images.push({
      index,
      displayName: tag(block, 'DISPLAYNAME') || tag(block, 'NAME'),
      editionId: tag(block, 'EDITIONID'),
      build: Number(tag(block, 'BUILD')) || 0,
      spBuild: Number(tag(block, 'SPBUILD')) || 0,
      branch: tag(block, 'BRANCH'),
      arch: Number(tag(block, 'ARCH')) || 0
    })
  }

  if (images.length === 0) return null

  const raw = head.readUInt32LE(0x0c)
  const formatVersion =
    raw === 0x00000e00 ? 'ESD' : `${raw >>> 16}.${(raw >>> 8) & 0xff}`

  return { formatVersion, imageCount: images.length, images }
}

/** 从映像清单里取架构（同一份媒体里的映像架构一致） */
export function wimArchOf(info: WimInfo | null): string {
  if (!info || info.images.length === 0) return ''
  return wimArchLabel(info.images[0].arch)
}
