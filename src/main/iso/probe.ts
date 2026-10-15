/**
 * 镜像内容识别 —— 从镜像内部的特征文件推断「这里面是什么系统、哪个版本」。
 *
 * 判定顺序（先精确后宽泛）：
 *   Windows → DOS 系 → .treeinfo(RHEL 系) → .disk/info(Debian 系/国产系统)
 *   → Arch → openSUSE → Alpine → ESXi → macOS → 通用 Linux → 未知
 *
 * Windows 的版本判定还有一层讲究：安装盘里写的版本号不一定是真实版本。
 * 有些版本族共用同一个基础内核号（Windows 10 的 2004～22H2 全写 19041，
 * Windows 11 的 22H2 / 23H2 全写 22621），微软给它们打盘时 <BUILD> 一律写基础号，
 * 连 setup.exe 也只报这个号；真实版本只存在于映像内部的注册表里，盘上读不到。
 * 所以这里优先读 install.wim / install.esd 内部的 XML（见 iso/wim.ts），
 * 遇到「家族基础号」时再按修订号与媒体版次尽量收窄，实在分不出来就如实列出
 * 可能的版本 —— 宁可说不敢确定，也不给一个看着像真的的错答案。
 *
 * 全部读取都走只读的 IsoImage，不会碰目标磁盘，也不需要管理员权限。
 */

import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { IsoImage, NotIsoError, type ImageFs } from './reader'
import { UdfImage, NotUdfError } from './udf'
import { readWimInfo, wimArchOf } from './wim'
import type { ImageFamily, ImageProbeInfo } from '@shared/types'

/* ------------------------------ 类型 ------------------------------ */

interface Ctx {
  fs: ImageFs
  /** 镜像文件名（小写，不含路径） */
  fileName: string
  /** 根目录条目名集合（全大写），用于快速判断 */
  rootSet: Set<string>
}

interface Hit {
  osName: string
  family: ImageFamily
  version?: string
  arch?: string
  confidence: number
  evidence: string
  hint?: string
  details?: Array<{ label: string; value: string }>
}

type Rule = (ctx: Ctx) => Promise<Hit | null>

/* ---------------------------- 小工具 ---------------------------- */

const ARCH_RULES: Array<{ re: RegExp; label: string }> = [
  { re: /(x86_64|amd64|x64|win64)/i, label: 'x86_64 (64 位)' },
  { re: /\b(aarch64|arm64)\b/i, label: 'ARM64' },
  { re: /\b(armv7|armhf|armel)\b/i, label: 'ARM 32 位' },
  { re: /\b(riscv64)\b/i, label: 'RISC-V 64' },
  { re: /\b(ppc64le|ppc64el)\b/i, label: 'POWER 64 LE' },
  { re: /\b(loongarch64)\b/i, label: '龙芯 LoongArch64' },
  { re: /\b(s390x)\b/i, label: 'IBM s390x' },
  { re: /\b(i[3-6]86|ia32|x86|win32)\b/i, label: 'x86 (32 位)' }
]

function guessArch(...texts: Array<string | undefined | null>): string {
  const s = texts.filter(Boolean).join(' ')
  for (const r of ARCH_RULES) if (r.re.test(s)) return r.label
  return ''
}

function cleanVersion(v: string | undefined | null): string {
  if (!v) return ''
  return v.replace(/^[\s"'v]+/, '').trim()
}

function tuneDisplayName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/**
 * 文件名里的版本记号和识别结果对不上时，给一句话提醒。
 * 文件名可以随便改，镜像是改不了的 —— 「改名盘」在网盘分享里很常见。
 */
function filenameConflict(fileName: string, osName: string): string | undefined {
  const fileTokens = [...fileName.matchAll(RELEASE_TOKEN_ALL)].map((m) => m[1].toUpperCase())
  const nameTokens = [...osName.matchAll(RELEASE_TOKEN_ALL)].map((m) => m[1].toUpperCase())
  if (
    fileTokens.length > 0 &&
    nameTokens.length === 1 &&
    !nameTokens.some((t) => fileTokens.includes(t))
  ) {
    return `文件名里的 ${fileTokens.join(' / ')} 与镜像内容不符：这张盘实际是 ${osName}，请以镜像内容为准。`
  }
  const fileMajor = WINDOWS_MAJOR.exec(fileName)?.[0].replace(/\D/g, '')
  const nameMajor = WINDOWS_MAJOR.exec(osName)?.[0].replace(/\D/g, '')
  if (fileMajor && nameMajor && fileMajor !== nameMajor) {
    return `文件名写的是 Windows ${fileMajor}，镜像内容却是 ${osName}，请以镜像内容为准。`
  }
  return undefined
}

/* ---------------------------- Windows ---------------------------- */

/** 内核版本号 → 市场名称（销量版本） */
const WIN_RELEASES: Array<{ min: number; name: string }> = [
  { min: 26200, name: 'Windows 11 25H2' },
  { min: 26100, name: 'Windows 11 24H2' },
  { min: 22631, name: 'Windows 11 23H2' },
  { min: 22621, name: 'Windows 11 22H2' },
  { min: 22000, name: 'Windows 11 21H2' },
  { min: 19045, name: 'Windows 10 22H2' },
  { min: 19044, name: 'Windows 10 21H2' },
  { min: 19043, name: 'Windows 10 21H1' },
  { min: 19042, name: 'Windows 10 20H2' },
  { min: 19041, name: 'Windows 10 2004' },
  { min: 18363, name: 'Windows 10 1909' },
  { min: 18362, name: 'Windows 10 1903' },
  { min: 17763, name: 'Windows 10 1809' },
  { min: 17134, name: 'Windows 10 1803' },
  { min: 16299, name: 'Windows 10 1709' },
  { min: 15063, name: 'Windows 10 1703' },
  { min: 14393, name: 'Windows 10 1607' },
  { min: 10586, name: 'Windows 10 1511' },
  { min: 10240, name: 'Windows 10 1507' },
  { min: 9600, name: 'Windows 8.1' },
  { min: 9200, name: 'Windows 8' },
  { min: 7601, name: 'Windows 7 SP1' },
  { min: 7600, name: 'Windows 7' },
  { min: 6002, name: 'Windows Vista / Server 2008' },
  { min: 3790, name: 'Windows Server 2003' }
]

function winKernelVersion(build: number, spBuild = 0): string {
  const base =
    build >= 10240
      ? `10.0.${build}`
      : build >= 9200
        ? `6.3.${build}`
        : build >= 7600
          ? `6.1.${build}`
          : build >= 6000
            ? `6.0.${build}`
            : build >= 3790
              ? `5.2.${build}`
              : String(build)
  return spBuild > 0 ? `${base}.${spBuild}` : base
}

/** 版本表没覆盖到的新版本，也别只写一个 "Windows" */
function winFallbackName(build: number): string {
  if (build >= 22000) return `Windows 11（Build ${build}）`
  if (build >= 10240) return `Windows 10（Build ${build}）`
  return 'Windows'
}

/**
 * 「安装盘只写家族基础内核号」的系统族。
 *
 * 已核实的事实：
 *   · Windows 10：2004 / 20H2 / 21H1 / 21H2 / 22H2 的安装盘里全写 19041。
 *   · Windows 11：23H2 的官方盘写的是 22621（不是 22631）。
 *   · Windows 11：25H2 的官方盘写的是真实的 26200（这一代微软改成写实际版本了）。
 *
 * 所以家族基础号不能直接拿去查版本名 —— 那会把 22H2 的盘认成 2004。
 * 改用两条只依赖「单调递增」的信息收窄：
 *   ① 硬排除：修订号落在某版本服役区间之外 ⇒ 不可能是它（各版本的首发/终版修订号是公开固定的）
 *   ② 零售顺位：零售盘只会发行「当时最新」的那一版，取首发修订号 ≤ 盘上修订号 里最新的一个
 * 企业版媒体（VL，必带 Enterprise 系版次）不做 ②，只做 ①；剩下多解就如实列区间。
 */
interface FamilyRelease {
  /** 装好后 winver 显示的内核号 */
  build: number
  /** 市场名称，如 Windows 10 22H2 */
  name: string
  /** 该版本首发时的修订号 */
  startRev: number
  /** 该版本最后一个修订号（仍现役的填 Infinity） */
  lastRev: number
}

interface WinFamily {
  /** 家族成员的展示名，用于「分不出来」时向用户解释 */
  label: string
  /** 成员，按版本从旧到新排列 */
  releases: FamilyRelease[]
}

const WIN_FAMILIES: Record<number, WinFamily> = {
  // Windows 10（Vibranium，家族基础号 19041）—— 修订号取自微软更新记录
  19041: {
    label: 'Windows 10 的 2004 / 20H2 / 21H1 / 21H2 / 22H2',
    releases: [
      { build: 19041, name: 'Windows 10 2004', startRev: 1, lastRev: 1415 },
      { build: 19042, name: 'Windows 10 20H2', startRev: 572, lastRev: 1706 },
      { build: 19043, name: 'Windows 10 21H1', startRev: 928, lastRev: 2364 },
      { build: 19044, name: 'Windows 10 21H2', startRev: 1288, lastRev: Infinity },
      { build: 19045, name: 'Windows 10 22H2', startRev: 2130, lastRev: Infinity }
    ]
  },
  // Windows 11（22621 家族）
  22621: {
    label: 'Windows 11 的 22H2 / 23H2',
    releases: [
      { build: 22621, name: 'Windows 11 22H2', startRev: 521, lastRev: Infinity },
      { build: 22631, name: 'Windows 11 23H2', startRev: 2506, lastRev: Infinity }
    ]
  }
}

/** 没有家族数据、但同样「只凭这个号分不出来」的内核号 */
const AMBIGUOUS_BASE: Record<number, string> = {
  26100: 'Windows 11 24H2 / 25H2'
}

/** 企业版（VL）媒体必带的版次；零售盘不会有 */
const VOLUME_EDITION = /^(Enterprise|IoTEnterprise|Server)/i

/** 文件名里的版本记号（23H2 / 24H2 / 25H2 / 26H1 …），只在没别的线索时作参考 */
const RELEASE_TOKEN = /(2\dH[12]|20H2|2004|1909|1809|1803|1709)/i

/** 同上，但用来把文本里的版本记号全部找出来 */
const RELEASE_TOKEN_ALL = /(2\dH[12]|20H2|2004|1909|1809|1803|1709)/gi

/** 文本里的 Windows 主版本号（10 / 11） */
const WINDOWS_MAJOR = /win(?:dows)?[\s._-]*1[01]/i

/** 候选版本名 → 一行展示（去掉重复前缀：「Windows 10 21H2 / 22H2」） */
function familyRangeLabel(releases: FamilyRelease[]): string {
  const first = releases[0].name
  if (releases.length === 1) return first
  const last = releases[releases.length - 1].name

  // 找出名字前面相同的词，展示时只写一次
  const a = first.split(' ')
  const b = last.split(' ')
  const pre: string[] = []
  for (let i = 0; i < Math.min(a.length, b.length) - 1; i++) {
    if (a[i] !== b[i]) break
    pre.push(a[i])
  }
  const prefix = pre.length > 0 ? `${pre.join(' ')} ` : ''
  const head = first.slice(prefix.length)
  const tail = last.slice(prefix.length)
  return releases.length === 2 ? `${prefix}${head} / ${tail}` : `${prefix}${head} – ${tail}`
}

export interface FamilyGuess {
  /** 站得住的候选版本名（唯一确定时只有一个元素） */
  candidates: string[]
  /** 唯一确定时的内核号；仍有多个可能时为 0 */
  build: number
  /** 是否靠「零售顺位」定的（靠硬排除定的更可信） */
  viaRetail: boolean
  /** 一句话说明判定依据，直接写进界面 */
  why: string
}

/**
 * 家族基础号 + 修订号 → 这张盘最可能是哪个版本。
 * 导出是为了让 tools/probe-selftest.ts 能对这张表做离线自检。
 */
export function guessFamilyRelease(
  base: number,
  rev: number,
  isRetail: boolean
): FamilyGuess | null {
  const family = WIN_FAMILIES[base]
  if (!family) return null
  const { releases } = family

  // ① 硬排除：修订号超出某版本的服役区间，就不可能是它
  let cands =
    rev > 0 ? releases.filter((r) => rev >= r.startRev && rev <= r.lastRev) : releases.slice()
  if (cands.length === 0) cands = releases.slice() // 修订号异常（自制盘）时不做硬排除

  if (cands.length === 1) {
    return {
      candidates: [cands[0].name],
      build: cands[0].build,
      viaRetail: false,
      why: `修订号 ${rev} 只可能属于 ${cands[0].name}`
    }
  }

  // ② 零售顺位：零售盘只发行当时最新的一版
  if (isRetail && rev > 0) {
    const newest = cands.filter((r) => rev >= r.startRev).pop()
    if (newest) {
      return {
        candidates: [newest.name],
        build: newest.build,
        viaRetail: true,
        why: `零售盘只发行当时最新版：修订号 ${rev} ≥ ${newest.name} 首发 ${newest.startRev}`
      }
    }
  }

  return {
    candidates: [familyRangeLabel(cands)],
    build: 0,
    viaRetail: false,
    why: `安装盘只写家族基础号 ${base}，修订号 ${rev || '未知'} 无法唯一确定`
  }
}

/** 第三方维护盘常见名字 */
const PE_VARIANTS: Array<{ re: RegExp; name: string }> = [
  { re: /wepe/i, name: '微PE 工具箱（Windows PE 维护盘）' },
  { re: /usbos|easyu|优启通/i, name: '优启通 EasyU（Windows PE 维护盘）' },
  { re: /firpe/i, name: 'FirPE（Windows PE 维护盘）' },
  { re: /hotpe/i, name: 'HotPE（Windows PE 维护盘）' },
  { re: /ventoy/i, name: 'Ventoy 启动盘' },
  { re: /edgeless/i, name: 'Edgeless PE' },
  { re: /hiren/i, name: "Hiren's BootCD PE" }
]

/**
 * 从 PE 文件里读出 VS_VERSIONINFO 中的文件版本号（例如 10.0.26100.1742）。
 * 注意：这个版本号只反映「承载二进制的内核」，遇到启封包版本（23H2 / 25H2）
 * 会报成基础版本，所以它只能当后备线索，不能当判据。
 */
function readPeFileVersion(buf: Buffer): string | null {
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null
  const peOff = buf.readUInt32LE(0x3c)
  if (peOff + 24 > buf.length) return null
  if (buf.toString('latin1', peOff, peOff + 4) !== 'PE\u0000\u0000') return null

  const numSections = buf.readUInt16LE(peOff + 6)
  const optSize = buf.readUInt16LE(peOff + 20)
  const optOff = peOff + 24
  if (optOff + 2 > buf.length) return null

  // 资源表是数据目录的第 3 项（索引 2），PE32 与 PE32+ 的数据目录起始偏移不同
  const magic = buf.readUInt16LE(optOff)
  const ddOff = optOff + (magic === 0x20b ? 112 : 96)
  if (ddOff + 16 > buf.length) return null
  const rsrcRva = buf.readUInt32LE(ddOff + 16)
  if (!rsrcRva) return null

  const secOff = optOff + optSize
  let rsrcFileOff = -1
  let rsrcSize = 0
  for (let i = 0; i < numSections; i++) {
    const s = secOff + i * 40
    if (s + 40 > buf.length) break
    const vsize = buf.readUInt32LE(s + 8)
    const va = buf.readUInt32LE(s + 12)
    const rawSize = buf.readUInt32LE(s + 16)
    const rawPtr = buf.readUInt32LE(s + 20)
    const span = Math.max(vsize, rawSize)
    if (rsrcRva >= va && rsrcRva < va + span) {
      rsrcFileOff = rawPtr + (rsrcRva - va)
      rsrcSize = span
      break
    }
  }
  if (rsrcFileOff < 0 || rsrcFileOff >= buf.length) return null

  const end = Math.min(rsrcFileOff + rsrcSize, buf.length)
  const key = buf.indexOf(Buffer.from('VS_VERSION_INFO', 'utf16le'), rsrcFileOff)
  if (key < 0 || key >= end) return null

  // VS_FIXEDFILEINFO 的签名是 0xFEEF04BD，紧跟在键字符串之后
  const sig = buf.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]), key)
  if (sig < 0 || sig + 16 > buf.length) return null
  const ms = buf.readUInt32LE(sig + 8)
  const ls = buf.readUInt32LE(sig + 12)
  if (ms === 0 && ls === 0) return null
  return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`
}

/** 读取 Windows 安装程序的版本号 */
async function readWindowsSetupVersion(fs: ImageFs): Promise<string | null> {
  for (const p of ['sources/setup.exe', 'setup.exe']) {
    // 资源节一般靠文件前部，先读 1MB；不够再读 8MB
    for (const size of [1 << 20, 8 << 20]) {
      const buf = await fs.head(p, size).catch(() => null)
      if (!buf || buf.length === 0) break
      const v = readPeFileVersion(buf)
      if (v) return v
      if (buf.length < size) break
    }
  }
  return null
}

async function ruleWindows(ctx: Ctx): Promise<Hit | null> {
  const sources = await ctx.fs.list('sources')
  const names = new Set(sources.filter((e) => !e.isDir).map((e) => e.name.toUpperCase()))
  const installName = ['INSTALL.WIM', 'INSTALL.ESD', 'INSTALL.SWM', 'INSTALL2.WIM'].find((n) =>
    names.has(n)
  )
  const hasBootWim = names.has('BOOT.WIM')
  const [hasSetup, hasBootmgr] = await Promise.all([
    ctx.fs.exists('setup.exe'),
    ctx.fs.exists('bootmgr')
  ])

  const isInstaller = !!installName || (hasSetup && hasBootmgr)
  const isPe = !isInstaller && hasBootWim && hasBootmgr
  if (!isInstaller && !isPe) return null

  const details: Array<{ label: string; value: string }> = []

  if (isPe) {
    const variant = PE_VARIANTS.find((v) => v.re.test(ctx.fileName))
    if (hasBootWim) details.push({ label: '启动映像', value: 'sources/boot.wim' })
    return {
      osName: variant?.name ?? 'Windows PE 维护盘',
      family: 'windows',
      version: '',
      arch: guessArch(ctx.fileName),
      confidence: variant ? 0.85 : 0.7,
      evidence: 'sources/boot.wim + bootmgr',
      details
    }
  }

  let build = 0
  let spBuild = 0
  let branch = ''
  let buildArch = ''
  let setupVersion = ''
  let versionEvidence = ''
  let imageName = ''
  let imageCount = 0
  let imageEditions: string[] = []

  // ① 首选：install.wim / install.esd 内部的 XML —— 唯一能分清启封包版本的判据。
  //    安装盘里的 setup.exe、boot.wim（WinPE）报的都是基础内核号，
  //    只有系统映像自己写着真实版本（25H2 的 install.wim 里是 26200）。
  if (installName) {
    const wim = await readWimInfo(ctx.fs, `sources/${installName}`).catch(() => null)
    const first = wim?.images[0]
    if (wim && first && first.build > 0) {
      build = first.build
      spBuild = first.spBuild
      branch = first.branch
      buildArch = wimArchOf(wim)
      imageName = first.displayName
      imageCount = wim.imageCount
      imageEditions = wim.images.map((i) => i.editionId)
      versionEvidence = `sources/${installName} → 系统映像`
    }
  }

  // ② 其次：idwbinfo.txt（只有较老的媒体才写 BuildNumber）
  const idw = await ctx.fs.text('sources/idwbinfo.txt', 16 * 1024)
  if (idw) {
    if (build === 0) {
      const n = Number(/BuildNumber\s*=\s*(\d+)/i.exec(idw)?.[1] ?? 0) || 0
      if (n > 0) {
        build = n
        versionEvidence = `sources/idwbinfo.txt → BuildNumber ${n}`
      }
    }
    branch = branch || (/BuildBranch\s*=\s*(\S+)/i.exec(idw)?.[1] ?? '')
    buildArch = buildArch || (/BuildArch\s*=\s*(\S+)/i.exec(idw)?.[1] ?? '')
  }

  // ③ 最后：安装程序的版本资源
  let setupBuild = 0
  if (build === 0) {
    setupVersion = (await readWindowsSetupVersion(ctx.fs)) ?? ''
    setupBuild = Number(/^\d+\.\d+\.(\d+)\.\d+$/.exec(setupVersion)?.[1] ?? 0) || 0
  }

  // install.wim 头部记录了包含多少个映像（>4GB 的 install.wim 不会出现在 ISO9660 目录里）
  if (installName && imageCount === 0) {
    const head = await ctx.fs.head(`sources/${installName}`, 0xd0)
    if (head && head.length >= 0x30 && head.toString('latin1', 0, 8).startsWith('MSWIM')) {
      const count = head.readUInt32LE(0x2c)
      if (count > 0) imageCount = count
    }
  }

  let osName: string
  let version = ''
  let evidence: string
  let confidence: number
  let hint: string | undefined

  // 企业版（VL）媒体必带 Enterprise 系版次，零售盘不会有 —— 决定能不能用「零售顺位」
  const isRetail = imageEditions.length > 0 && !imageEditions.some((e) => VOLUME_EDITION.test(e))

  if (build > 0) {
    // 系统映像里的真实版本 —— 最可靠的一路
    const family = guessFamilyRelease(build, spBuild, isRetail)
    if (family) {
      // 这一族共用基础内核号，盘里写的不是真实版本，只能按修订号与版次收窄
      const single = family.build > 0
      osName = family.candidates[0]
      version = winKernelVersion(single ? family.build : build, spBuild)
      evidence = `${versionEvidence}：盘内写 ${winKernelVersion(build, spBuild)} · ${family.why}`
      confidence = single ? (family.viaRetail ? 0.85 : 0.92) : 0.6
      details.push({
        label: '盘内记录版本',
        value: `${winKernelVersion(build, spBuild)}（${build} 是家族共用基础号）`
      })
      if (!single) {
        hint =
          `${family.candidates[0]} 是共用基础内核号 ${build} 的版本族（${WIN_FAMILIES[build]?.label ?? ''}），` +
          '安装盘里也只写这个号 —— 真实版本只存在于映像内部的注册表，盘上读不到。' +
          '已按修订号排除不可能的版本，剩下这些仍无法唯一确定，装好后用 winver 可以确认。'
      }
    } else {
      osName = WIN_RELEASES.find((r) => build >= r.min)?.name ?? winFallbackName(build)
      version = winKernelVersion(build, spBuild)
      evidence = versionEvidence ? `${versionEvidence} ${version}` : `内核版本 ${version}`
      confidence = imageName ? 0.98 : 0.9
    }

    if (imageName) {
      details.push({
        label: '系统映像',
        value: imageCount > 1 ? `${imageName} 等 ${imageCount} 个版本` : imageName
      })
    }
    if (branch) details.push({ label: '服务分支', value: branch })
  } else if (setupBuild > 0) {
    // 只拿到安装程序版本：安装程序报的永远是家族基础号，同族版本在这里会退化成基础版本，
    // 所以如实说明「分不出来」，不要硬猜成同族里最老的那一版。
    const family = WIN_FAMILIES[setupBuild]
    const ambiguous = AMBIGUOUS_BASE[setupBuild]
    version = winKernelVersion(setupBuild)
    if (family) {
      osName = familyRangeLabel(family.releases)
      evidence =
        `安装程序（setup.exe）版本资源 → ${setupVersion} —— 这是家族基础号，${family.label} 共用它；` +
        `未能读出 ${installName ? `sources/${installName}` : '系统映像'} 内的真实版本`
      confidence = 0.55
      hint =
        `${family.label} 共用基础内核号 ${setupBuild}，安装盘里的安装程序也只报这个号。` +
        '只有读出系统映像（install.wim / install.esd）内的版本才能区分，本机这份没能读出来 —— ' +
        '装好后用 winver 可以确认。'
    } else if (ambiguous) {
      osName = ambiguous
      evidence =
        `安装程序版本 ${setupVersion} —— ${setupBuild} 这一内核号两个版本共用，仅凭它无法区分；` +
        `且未能读出 ${installName ? `sources/${installName}` : '系统映像'} 内的真实版本`
      confidence = 0.55
      hint =
        '这两个版本共用同一套系统内核，只有读取系统映像（install.wim / install.esd）内的版本才能区分。' +
        '本机这份镜像的内部版本没能读出来，建议装好后用 winver 确认，或换用官方原版镜像。'
    } else {
      osName =
        WIN_RELEASES.find((r) => setupBuild >= r.min)?.name ?? winFallbackName(setupBuild)
      evidence = `安装程序（setup.exe）版本资源 → ${setupVersion}`
      confidence = 0.9
    }
    details.push({ label: '安装程序版本', value: setupVersion })
    if (branch) details.push({ label: '服务分支', value: branch })
  } else {
    // 退化成文件名判断
    const fn = ctx.fileName
    const isThing = /win(?:dows)?[\s._-]*11/i.test(fn) ? '11' : /win(?:dows)?[\s._-]*10/i.test(fn) ? '10' : ''
    const rel = RELEASE_TOKEN.exec(fn)?.[1]
    osName = isThing ? `Windows ${isThing}${rel ? `（${rel.toUpperCase()}）` : ''}` : 'Windows 安装盘'
    evidence = '目录结构 + 文件名（未能读到版本文件）'
    confidence = isThing ? 0.6 : 0.45
  }

  // 文件名和镜像内容打架时提醒一句 —— 文件名可以随便改，镜像是改不了的
  const conflict = filenameConflict(ctx.fileName, osName)
  if (conflict) hint = hint ? `${hint} ${conflict}` : conflict

  return {
    osName,
    family: 'windows',
    version,
    arch: buildArch ? guessArch(buildArch, ctx.fileName) || buildArch : guessArch(ctx.fileName),
    confidence,
    evidence,
    hint,
    details
  }
}

/* ------------------------- DOS 系（FreeDOS / MS-DOS） ------------------------- */

async function ruleDos(ctx: Ctx): Promise<Hit | null> {
  const label = `${ctx.fs.volumeLabel} ${ctx.fileName}`.toUpperCase()

  if (
    /FREEDOS|FDSETUP|FDOS/.test(label) ||
    ctx.rootSet.has('FREEDOS') ||
    (ctx.rootSet.has('PACKAGES') && ctx.rootSet.has('ISOLINUX'))
  ) {
    const v = /(?:freedos|fdos)[\s._-]*(\d+\.\d+(?:\.\d+)?)/i.exec(label)?.[1]
    return {
      osName: v ? `FreeDOS ${v}` : 'FreeDOS',
      family: 'dos',
      version: v ?? '',
      arch: 'x86 (16/32 位)',
      confidence: /FREEDOS|FDSETUP/.test(label) ? 0.9 : 0.6,
      evidence: '卷标/文件名 + 目录结构（packages、isolinux）',
      details: [{ label: '说明', value: 'DOS 系系统，通常用于 BIOS 刷写与老工具运行' }]
    }
  }

  if (
    /MS[\s_-]?DOS/.test(label) ||
    ctx.rootSet.has('MSDOS.SYS') ||
    (ctx.rootSet.has('IO.SYS') && ctx.rootSet.has('COMMAND.COM'))
  ) {
    return {
      osName: 'MS-DOS',
      family: 'dos',
      version: '',
      arch: 'x86 (16 位)',
      confidence: 0.8,
      evidence: '目录中的 DOS 系统文件（IO.SYS / MSDOS.SYS）'
    }
  }

  return null
}

/* ------------------------- .treeinfo（RHEL 系 / openEuler） ------------------------- */

async function ruleTreeInfo(ctx: Ctx): Promise<Hit | null> {
  const t = await ctx.fs.text('.treeinfo', 64 * 1024)
  if (!t || !/\[general\]/i.test(t)) return null

  const pick = (k: string): string => {
    const m = new RegExp(`^\\s*${k}\\s*=\\s*(.+)$`, 'im').exec(t)
    return m ? m[1].trim() : ''
  }

  const family = pick('family')
  const name = pick('name')
  const version = cleanVersion(pick('version'))
  const arch = pick('arch')
  const label = family || name.replace(/[-_]?\d[\d.]*$/, '') || 'Linux'

  return {
    osName: tuneDisplayName(`${label}${version ? ` ${version}` : ''}`),
    family: 'linux',
    version,
    arch: guessArch(arch, ctx.fileName),
    confidence: 0.92,
    evidence: '.treeinfo',
    details: name ? [{ label: '产品标识', value: name }] : []
  }
}

/* ------------------------- .disk/info（Debian 系 / 国产系统） ------------------------- */

async function ruleDiskInfo(ctx: Ctx): Promise<Hit | null> {
  let text = await ctx.fs.text('.disk/info', 64 * 1024)
  let evidence = '镜像内的 .disk/info'

  if (!text) {
    const dd = await ctx.fs.text('README.diskdefines', 64 * 1024)
    const m = dd ? /^#define\s+DISKNAME\s+(.+)$/m.exec(dd) : null
    if (m) {
      text = m[1]
      evidence = '镜像内的 README.diskdefines'
    }
  }
  if (!text) return null

  const line = text.split('\n').map((s) => s.trim()).find(Boolean) ?? ''
  if (!line) return null

  const headline = line.split(/\s+-\s+/)[0]
  const osName = tuneDisplayName(headline)
  const version = /(\d+\.\d+(?:\.\d+)?)/.exec(headline)?.[1] ?? ''

  return {
    osName,
    family: 'linux',
    version,
    arch: guessArch(line, ctx.fileName),
    confidence: 0.9,
    evidence,
    details: [{ label: '镜像描述', value: tuneDisplayName(line) }]
  }
}

/* ------------------------- Arch Linux ------------------------- */

async function ruleArch(ctx: Ctx): Promise<Hit | null> {
  const label = `${ctx.fs.volumeLabel} ${ctx.fileName}`
  const m = /arch[\s_-]+(\d{4})[._-](\d{2})[._-](\d{2})/i.exec(label)
  if (m) {
    return {
      osName: `Arch Linux ${m[1]}.${m[2]}.${m[3]}`,
      family: 'linux',
      version: `${m[1]}.${m[2]}.${m[3]}`,
      arch: guessArch(label),
      confidence: 0.9,
      evidence: '卷标/文件名中的日期版本号'
    }
  }
  if (ctx.rootSet.has('ARCH') && (ctx.rootSet.has('LOADER') || ctx.rootSet.has('EFI'))) {
    return {
      osName: 'Arch Linux（滚动发布）',
      family: 'linux',
      version: '',
      arch: guessArch(ctx.fileName, [...ctx.rootSet].join(' ')),
      confidence: 0.75,
      evidence: '镜像根目录包含 arch/ 与 loader/'
    }
  }
  return null
}

/* ------------------------- openSUSE ------------------------- */

async function ruleSuse(ctx: Ctx): Promise<Hit | null> {
  const label = `${ctx.fs.volumeLabel} ${ctx.fileName}`
  if (!/opensuse|suse[\s_-]*(linux|enterprise)|sles/i.test(label)) return null
  const m = /(leap|tumbleweed)[\s_-]*([\d.]+)?/i.exec(label)
  const edition = m ? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase()}` : ''
  const version = cleanVersion(m?.[2])
  const isSles = /sles|suse[\s_-]*linux[\s_-]*enterprise/i.test(label)
  return {
    osName: tuneDisplayName(
      isSles ? `SUSE Linux Enterprise Server ${version}` : `openSUSE ${edition}${version ? ` ${version}` : ''}`
    ),
    family: 'linux',
    version,
    arch: guessArch(label),
    confidence: 0.85,
    evidence: '卷标/文件名'
  }
}

/* ------------------------- Alpine ------------------------- */

async function ruleAlpine(ctx: Ctx): Promise<Hit | null> {
  const label = `${ctx.fs.volumeLabel} ${ctx.fileName}`
  if (!/alpine/i.test(label) && !ctx.rootSet.has('.ALPINE-RELEASE') && !ctx.rootSet.has('APK')) return null
  const v = /alpine[\s._-]*(?:standard|extended|virtual|virt|mini)?[\s._-]*(\d+\.\d+(?:\.\d+)?)/i.exec(
    label
  )?.[1]
  const variant = /standard/i.test(label) ? 'Standard' : /extended/i.test(label) ? 'Extended' : /virt/i.test(label) ? 'Virtual' : ''
  return {
    osName: `Alpine Linux${variant ? ` ${variant}` : ''}${v ? ` ${v}` : ''}`,
    family: 'linux',
    version: v ?? '',
    arch: guessArch(label),
    confidence: 0.85,
    evidence: '卷标/文件名'
  }
}

/* ------------------------- VMware ESXi ------------------------- */

async function ruleEsxi(ctx: Ctx): Promise<Hit | null> {
  const hasV00 = [...ctx.rootSet].some((n) => /\.V\d\d$/.test(n))
  if (!(ctx.rootSet.has('BOOT.CFG') && hasV00)) return null
  const label = `${ctx.fs.volumeLabel} ${ctx.fileName}`
  const v = /(?:esxi|vmware[\s._-]*esxi)[\s._-]*(\d+(?:\.\d+)?[a-z]?\d*)/i.exec(label)?.[1]
  return {
    osName: `VMware ESXi ${v ?? ''}`.trim(),
    family: 'hypervisor',
    version: v ?? '',
    arch: 'x86_64 (64 位)',
    confidence: 0.85,
    evidence: '镜像根目录 boot.cfg + *.v00 模块'
  }
}

/* ------------------------- macOS ------------------------- */

async function ruleMac(ctx: Ctx): Promise<Hit | null> {
  const isMac =
    ctx.rootSet.has('INSTALLESD.DMG') ||
    ctx.rootSet.has('.IABOOTFILES') ||
    ctx.rootSet.has('BASESYSTEM.DMG') ||
    ctx.rootSet.has('INSTALL.MACOS')
  if (!isMac) return null
  const label = `${ctx.fs.volumeLabel} ${ctx.fileName}`
  const v = /(mac[\s_-]*os[\s_-]*x|macos)[\s._-]*(\d+[._]\d+(?:[._]\d+)?)/i.exec(label)?.[2]
  return {
    osName: v ? `macOS 安装镜像 ${v.replace(/_/g, '.')}` : 'macOS 安装镜像',
    family: 'macos',
    version: v ? v.replace(/_/g, '.') : '',
    arch: 'x86_64 / Apple Silicon',
    confidence: 0.8,
    evidence: '镜像根目录包含 InstallESD.dmg / .IABootFiles'
  }
}

/* ------------------------- 通用 Linux 兜底 ------------------------- */

async function ruleGenericLinux(ctx: Ctx): Promise<Hit | null> {
  const liveMarkers = ['ISOLINUX', 'CASPER', 'LIVE', 'DISTS', 'POOL', 'IMAGES', 'BOOT']
  const hitCount = liveMarkers.filter((m) => ctx.rootSet.has(m)).length
  if (hitCount < 2) return null
  return {
    osName: 'Linux 发行版（未识别具体版本）',
    family: 'linux',
    version: '',
    arch: guessArch(ctx.fileName, ctx.fs.volumeLabel),
    confidence: 0.4,
    evidence: '镜像为 Linux 光盘结构，但没有可读的版本标记文件',
    details: [{ label: '根目录特征', value: liveMarkers.filter((m) => ctx.rootSet.has(m)).join('、') }]
  }
}

const RULES: Rule[] = [
  ruleWindows,
  ruleDos,
  ruleTreeInfo,
  ruleDiskInfo,
  ruleArch,
  ruleSuse,
  ruleAlpine,
  ruleEsxi,
  ruleMac,
  ruleGenericLinux
]

/* ---------------------------- 引导方式 ---------------------------- */

const EFI_MARKERS: Array<[string, string]> = [
  ['efi/boot/bootx64.efi', 'UEFI (x64)'],
  ['efi/boot/bootia32.efi', 'UEFI (32 位 IA32)'],
  ['efi/boot/bootaa64.efi', 'UEFI (ARM64)'],
  ['efi/boot/bootarm.efi', 'UEFI (ARM 32)'],
  ['efi/microsoft/boot/bootmgfw.efi', 'UEFI (Windows 引导)'],
  ['boot/grub/efi.img', 'UEFI (El Torito 软盘镜像)'],
  ['images/efiboot.img', 'UEFI (El Torito 软盘镜像)'],
  ['efi.img', 'UEFI (El Torito 软盘镜像)']
]

async function detectBootModes(fs: ImageFs): Promise<string[]> {
  const modes: string[] = []
  for (const [p, label] of EFI_MARKERS) {
    if (await fs.exists(p)) modes.push(label)
  }
  const legacy =
    (await fs.exists('isolinux/isolinux.bin')) ||
    (await fs.exists('syslinux/isolinux.bin')) ||
    (await fs.exists('isolinux.bin')) ||
    (await fs.exists('boot/isolinux/isolinux.bin'))
  if (legacy) modes.push('BIOS (ISOLINUX)')
  if ((await fs.exists('bootmgr')) && (await fs.exists('boot/bcd'))) modes.push('BIOS (Windows 引导)')
  if (modes.length === 0 && fs.hasElTorito) modes.push('El Torito 引导（老式 BIOS）')
  return [...new Set(modes)]
}

/* ---------------------------- 主流程 ---------------------------- */

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '未知'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}

/**
 * 打开镜像并选出「内容最完整」的那棵树。
 * 优先 ISO9660；若 ISO9660 部分内容贫瘠且镜像带 UDF，则改用 UDF 树
 * —— Windows 官方 ISO 就是这种结构：ISO9660 里只剩一个 README.TXT。
 */
async function openImage(filePath: string): Promise<ImageFs> {
  let iso: IsoImage | null = null
  let isoErr: unknown = null
  try {
    iso = await IsoImage.open(filePath)
  } catch (e) {
    isoErr = e
  }

  if (iso) {
    if (iso.header.hasUdf) {
      const entries = await iso.list('').catch(() => [])
      if (entries.length < 6) {
        try {
          const udf = await UdfImage.open(filePath)
          await iso.close()
          return udf
        } catch {
          // UDF 解析失败就沿用 ISO9660 的结果
        }
      }
    }
    return iso
  }

  if (isoErr instanceof NotIsoError && isoErr.hasUdf) {
    return await UdfImage.open(filePath)
  }
  throw isoErr instanceof Error ? isoErr : new Error('无法打开镜像文件')
}

export async function probeImage(filePath: string): Promise<ImageProbeInfo> {
  const fileName = (filePath.split(/[\\/]/).pop() || filePath).toLowerCase()

  let fs: ImageFs
  try {
    fs = await openImage(filePath)
  } catch (e) {
    if (e instanceof NotIsoError) return await probeNonIso(filePath, fileName, e.hasUdf)
    if (e instanceof NotUdfError) return await probeNonIso(filePath, fileName, true)
    throw e
  }

  try {
    const rootEntries = await fs.list('')
    const rootSet = new Set(rootEntries.map((e) => e.name.toUpperCase()))
    const ctx: Ctx = { fs, fileName, rootSet }

    const bootModes = await detectBootModes(fs)

    let hit: Hit | null = null
    for (const rule of RULES) {
      hit = await rule(ctx)
      if (hit) break
    }

    const volumeLabel = fs.volumeLabel || '（无）'
    let size = 0
    try {
      size = (await fsp.stat(filePath)).size
    } catch {
      size = 0
    }

    const details: Array<{ label: string; value: string }> = [
      { label: '卷标', value: volumeLabel },
      { label: '镜像大小', value: fmtBytes(size) }
    ]
    if (hit?.details) details.push(...hit.details)

    if (!hit) {
      if (bootModes.length === 0) {
        // 既没有引导记录，也没有系统特征文件 —— 多半是数据盘 / 驱动盘
        hit = {
          osName: '非系统镜像（数据 / 驱动光盘）',
          family: 'unknown',
          confidence: 0.5,
          evidence: '未发现引导记录与系统特征文件'
        }
      } else {
        hit = {
          osName: '无法识别的光盘镜像',
          family: 'unknown',
          confidence: 0.2,
          evidence: '未命中任何已知的发行版特征文件'
        }
      }
      details.push({
        label: '根目录',
        value: rootEntries.slice(0, 12).map((e) => e.name).join('、') || '（空）'
      })
    }

    const resolved: Hit = hit

    return {
      container: fs.container,
      volumeLabel,
      family: resolved.family,
      osName: resolved.osName,
      version: resolved.version ?? '',
      arch: resolved.arch ?? '',
      bootable: bootModes.length > 0,
      bootModes,
      evidence: resolved.evidence,
      confidence: resolved.confidence,
      hint: resolved.hint,
      details
    }
  } finally {
    await fs.close()
  }
}

/* ------------------------- 非 ISO 容器（UDF / 磁盘镜像） ------------------------- */

async function readHead(filePath: string, bytes: number): Promise<Buffer | null> {
  let fh: FileHandle | null = null
  try {
    fh = await fsp.open(filePath, 'r')
    const buf = Buffer.alloc(bytes)
    let total = 0
    while (total < bytes) {
      const { bytesRead } = await fh.read(buf, total, bytes - total, total)
      if (bytesRead <= 0) break
      total += bytesRead
    }
    return buf.subarray(0, total)
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => undefined)
  }
}

const NAME_HINTS: Array<{ re: RegExp; name: string; family: ImageFamily }> = [
  { re: /win(dows)?[\s._-]*11/i, name: 'Windows 11', family: 'windows' },
  { re: /win(dows)?[\s._-]*10/i, name: 'Windows 10', family: 'windows' },
  { re: /ubuntu/i, name: 'Ubuntu', family: 'linux' },
  { re: /debian/i, name: 'Debian', family: 'linux' },
  { re: /fedora/i, name: 'Fedora', family: 'linux' },
  { re: /centos/i, name: 'CentOS', family: 'linux' },
  { re: /rocky/i, name: 'Rocky Linux', family: 'linux' },
  { re: /almalinux|alma/i, name: 'AlmaLinux', family: 'linux' },
  { re: /deepin/i, name: 'Deepin', family: 'linux' },
  { re: /kylin/i, name: '银河麒麟', family: 'linux' },
  { re: /uos|uniontech/i, name: '统信 UOS', family: 'linux' },
  { re: /arch/i, name: 'Arch Linux', family: 'linux' },
  { re: /opensuse|suse/i, name: 'openSUSE', family: 'linux' },
  { re: /alpine/i, name: 'Alpine Linux', family: 'linux' },
  { re: /esxi/i, name: 'VMware ESXi', family: 'hypervisor' }
]

async function probeNonIso(filePath: string, fileName: string, hasUdf: boolean): Promise<ImageProbeInfo> {
  const head = await readHead(filePath, 64 * 1024)
  const hint = NAME_HINTS.find((h) => h.re.test(fileName))

  const base = (
    container: string,
    osName: string,
    family: ImageFamily,
    evidence: string,
    confidence: number,
    details: Array<{ label: string; value: string }> = []
  ): ImageProbeInfo => ({
    container,
    volumeLabel: '（无）',
    family,
    osName,
    version: '',
    arch: guessArch(fileName),
    bootable: false,
    bootModes: [],
    evidence,
    confidence,
    details
  })

  if (fileName.endsWith('.dmg')) {
    return base('Apple 磁盘镜像 (.dmg)', hint?.name ? `${hint.name} 安装镜像` : 'Apple 磁盘镜像', hint?.family ?? 'macos', '文件扩展名 .dmg', 0.4)
  }

  if (!head || head.length === 0) {
    return base('未知', '无法读取镜像', 'unknown', '文件读取失败', 0)
  }

  const udfSig = head.length > 16 * 2048 + 5 ? head.toString('latin1', 16 * 2048 + 1, 16 * 2048 + 6) : ''
  if (hasUdf || udfSig.startsWith('BEA01') || udfSig.startsWith('NSR0')) {
    return base(
      'UDF 光盘镜像',
      hint?.name ? `${hint.name}（UDF 结构）` : 'UDF 光盘镜像',
      hint?.family ?? 'unknown',
      '检测到 UDF 卷识别序列，但缺少 ISO 9660 卷描述符',
      0.35
    )
  }

  const fat32 = head.length > 0x5a && head.toString('latin1', 0x52, 0x5a) === 'FAT32   '
  const fat16 = head.length > 0x3e && /^FAT(12|16)\s*$/.test(head.toString('latin1', 0x36, 0x3e))
  const ntfs = head.length > 11 && head.toString('latin1', 3, 11) === 'NTFS    '
  const exfat = head.length > 11 && head.toString('latin1', 3, 11) === 'EXFAT   '
  const isMbr = head.length > 512 && head[510] === 0x55 && head[511] === 0xaa
  const isGpt = head.length > 512 && head.toString('latin1', 512, 520) === 'EFI PART'

  if (fat32 || fat16) {
    return base(
      '磁盘镜像（含 FAT 文件系统）',
      hint?.name ? `${hint.name}（FAT 磁盘镜像）` : 'FAT 磁盘镜像',
      hint?.family ?? 'unknown',
      '镜像开头是 FAT 引导扇区',
      0.4
    )
  }
  if (ntfs) {
    return base('磁盘镜像（含 NTFS 文件系统）', hint?.name ? `${hint.name}（NTFS 磁盘镜像）` : 'NTFS 磁盘镜像', hint?.family ?? 'unknown', '镜像开头是 NTFS 引导扇区', 0.4)
  }
  if (exfat) {
    return base('磁盘镜像（含 exFAT 文件系统）', 'exFAT 磁盘镜像', 'unknown', '镜像开头是 exFAT 引导扇区', 0.4)
  }
  if (isGpt) {
    return base('磁盘镜像（GPT 分区表）', hint?.name ? `${hint.name}（磁盘镜像）` : '磁盘镜像', hint?.family ?? 'unknown', '检测到 GPT 分区表头', 0.3)
  }
  if (isMbr) {
    return base('磁盘镜像（MBR 分区表）', hint?.name ? `${hint.name}（磁盘镜像）` : '原始磁盘镜像', hint?.family ?? 'unknown', '检测到 MBR 分区表', 0.3)
  }

  return base('未知', '无法识别的镜像', 'unknown', '既不是 ISO 9660 / UDF，也不是常见磁盘镜像', 0)
}
