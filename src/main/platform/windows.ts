import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DeviceInfo, FormatOptions } from '@shared/types'
import { run, runPowerShell } from '../exec'

const ENUM_SCRIPT = `
# 磁盘号 -> PnP 实例 id（USB 盘是 USBSTOR\\...，内置盘是 SCSI\\...）
$pnpByIndex = @{}
try {
  foreach ($dd in (Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue)) {
    $pnpByIndex[[int]$dd.Index] = [string]$dd.PNPDeviceID
  }
} catch {}

# USB 接口版本：见 getUsbGen() 的注释 —— 每次查询要几百毫秒到一秒，
# 所以这里【不查】，列表先原样返回，接口版本由后台单独补齐后再推给界面。
$sysDrive = ($env:SystemDrive -replace ':\\\\?$','').Trim()
$rows = New-Object System.Collections.Generic.List[object]
$disks = @(Get-Disk -ErrorAction SilentlyContinue | Sort-Object Number)
foreach ($d in $disks) {
  $letters = @()
  $labels = @()
  try {
    $parts = @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue)
    foreach ($p in $parts) {
      $dl = ([string]$p.DriveLetter).Replace([string][char]0, '').Trim()
      if ($dl.Length -gt 0 -and $dl -ne '0') { $letters += $dl }
      try {
        $v = Get-Volume -Partition $p -ErrorAction SilentlyContinue
        if ($v -and $v.FileSystemLabel) { $labels += [string]$v.FileSystemLabel }
      } catch {}
    }
  } catch {}
  $bus = [string]$d.BusType
  $removable = ($bus -eq 'USB' -or $bus -eq 'SD' -or $bus -eq 'MMC' -or $bus -eq 'IEEE1394' -or $bus -eq 'Thunderbolt' -or $bus -eq 'SCSI')
  $isSystem = ([bool]$d.IsSystem) -or ([bool]$d.IsBoot) -or ($letters -contains $sysDrive) -or ($letters -contains 'C')
  [void]$rows.Add([pscustomobject]@{
    number = [int]$d.Number
    name = [string]$d.FriendlyName
    size = [int64]$d.Size
    busType = $bus
    isSystem = $isSystem
    isReadOnly = [bool]$d.IsReadOnly
    isOffline = [bool]$d.IsOffline
    partitionStyle = [string]$d.PartitionStyle
    driveLetters = @($letters)
    volumeLabels = @($labels)
    removable = $removable
    sysDrive = $sysDrive
  })
}
$rows
`

export async function listWindowsDevices(): Promise<DeviceInfo[]> {
  const r = await runPowerShell(ENUM_SCRIPT)
  if (!r.stdout.trim()) {
    throw new Error('未能获取磁盘列表：' + (r.stderr || 'PowerShell 返回为空'))
  }
  let parsed: any
  try {
    parsed = JSON.parse(r.stdout)
  } catch {
    throw new Error('解析磁盘列表失败：' + r.stdout.slice(0, 200))
  }
  const rows: any[] = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []

  return rows.map((d) => {
    const number = Number(d.number)
    const letters: string[] = (d.driveLetters || [])
      .map((x: unknown) => String(x ?? '').replace(/\0/g, '').trim())
      .filter((x: string) => /^[A-Za-z]$/.test(x))
      .map((x: string) => `${x.toUpperCase()}:`)
    const labels: string[] = d.volumeLabels || []
    const name = (d.name || '未知磁盘').trim()
    const size = Number(d.size) || 0
    const system = !!d.isSystem
    const removable = !!d.removable

    return {
      id: `win:${number}`,
      rawId: String(number),
      displayName: name,
      size,
      devicePath: `\\\\.\\PhysicalDrive${number}`,
      mountPoints: letters,
      removable,
      internal: !removable,
      system,
      protected: system,
      busType: d.busType || 'Unknown',
      partitionStyle: d.partitionStyle || 'Unknown',
      readOnly: !!d.isReadOnly,
      notes: labels.length ? `卷标：${labels.join(' / ')}` : undefined
    } satisfies DeviceInfo
  })
}

/** USB 接口版本的查询结果 */
export interface UsbGenResult {
  number: number
  usbGen: string
}

/** 同一块盘的查询结果缓存：插着不动就不会变，没必要每次刷新都重查一遍 */
const usbGenCache = new Map<string, string>()

/**
 * 判定每块 USB 盘的**接口版本**（USB 3.0 / 2.0 / 1.1）。
 *
 * 做法：从磁盘的 PnP 节点沿「父设备」链往上走 ——
 *   USBSTOR\...（磁盘） → USB\VID_xxx（设备） → USB\ROOT_HUB30（根集线器）
 * 根集线器的实例 id 直接就写明代数：ROOT_HUB30 = USB 3.0，ROOT_HUB20 = USB 2.0。
 * 再往上还能拿到主机控制器名（xHCI / EHCI），作为集线器没认出来时的兜底。
 *
 * ⚠️ 走的是「这块盘插在哪个口上」，不是设备自身的速率 —— 用户问的就是接口版本。
 *
 * ⚠️ 为什么必须异步：每调一次 Get-PnpDeviceProperty 要 700~900ms（CIM 开销），
 *    同步做会让刷新卡住两三秒。所以列表先返回，这个由后台算完再推给界面。
 */
const USBGEN_SCRIPT = `
function Get-UsbGen([string]$startId) {
  if ([string]::IsNullOrWhiteSpace($startId)) { return '' }
  $cur = $startId
  try {
    for ($i = 0; $i -lt 4; $i++) {
      $props = @(Get-PnpDeviceProperty -InstanceId $cur -KeyName 'DEVPKEY_Device_Parent','DEVPKEY_Device_DeviceDesc','DEVPKEY_Device_FriendlyName' -ErrorAction SilentlyContinue)
      if ($props.Count -eq 0) { return '' }
      $parent = ''
      $text = ''
      foreach ($p in $props) {
        $v = [string]$p.Data
        if ($p.KeyName -eq 'DEVPKEY_Device_Parent') { $parent = $v } else { $text = $text + ' ' + $v }
      }
      if ([string]::IsNullOrWhiteSpace($parent)) { return '' }
      $cur = $parent
      # 集线器实例 id 最可靠，优先判
      if ($cur -match 'ROOT_HUB30') { return 'USB 3.0' }
      if ($cur -match 'ROOT_HUB20') { return 'USB 2.0' }
      if ($text -match 'USB 3\\.2') { return 'USB 3.2' }
      if ($text -match 'USB 3\\.1') { return 'USB 3.1' }
      if ($text -match 'USB 3\\.0|SuperSpeed|xHCI') { return 'USB 3.0' }
      if ($text -match 'USB 2\\.0|Enhanced|EHCI') { return 'USB 2.0' }
      if ($text -match 'UHCI|OHCI') { return 'USB 1.1' }
    }
  } catch { return '' }
  return ''
}

$pnpByIndex = @{}
try {
  foreach ($dd in (Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue)) {
    $pnpByIndex[[int]$dd.Index] = [string]$dd.PNPDeviceID
  }
} catch {}

$rows = New-Object System.Collections.Generic.List[object]
foreach ($n in $targets) {
  $id = $pnpByIndex[[int]$n]
  $gen = ''
  if ($id -and $id -notmatch '^SCSI') { $gen = Get-UsbGen $id }
  [void]$rows.Add([pscustomobject]@{ number = [int]$n; usbGen = [string]$gen })
}
$rows
`

/**
 * 后台查询 USB 接口版本。只查给定的磁盘号（调用方已经筛过，只传 USB 总线上的盘）。
 * 查不出来就不出现在结果里 —— 界面上不显示，绝不猜一个糊弄人。
 *
 * 缓存放在这里（而不是塞进脚本里）：同一块盘插着不动，接口版本不会变，
 * 全部命中缓存时连 PowerShell 都不用起。
 */
export async function fetchUsbGen(
  disks: { number: number; cacheKey: string }[]
): Promise<UsbGenResult[]> {
  if (disks.length === 0) return []
  const hit: UsbGenResult[] = []
  const miss: typeof disks = []
  for (const d of disks) {
    const c = usbGenCache.get(d.cacheKey)
    if (c) hit.push({ number: d.number, usbGen: c })
    else miss.push(d)
  }
  if (miss.length === 0) return hit

  const targets = miss.map((d) => d.number).join(',')
  const script = `$targets = @(${targets})\n${USBGEN_SCRIPT}`
  const r = await runPowerShell(script)
  try {
    const rows: any[] = Array.isArray(JSON.parse(r.stdout))
      ? JSON.parse(r.stdout)
      : [JSON.parse(r.stdout)]
    for (const x of rows) {
      const n = Number(x.number)
      const gen = String(x.usbGen || '')
      if (!Number.isFinite(n) || !gen) continue
      const key = miss.find((m) => m.number === n)?.cacheKey
      if (key) usbGenCache.set(key, gen)
      hit.push({ number: n, usbGen: gen })
    }
  } catch {
    /* 解析失败就当没查到，界面上只是少一个小标签 */
  }
  return hit
}

async function diskpart(script: string): Promise<{ ok: boolean; out: string }> {
  const file = path.join(os.tmpdir(), `isoforge-${process.pid}-${Date.now()}.txt`)
  await fs.writeFile(file, script.replace(/\n/g, '\r\n'), 'utf8')
  try {
    const r = await run('diskpart', ['/s', file], 180000)
    const out = `${r.stdout}\n${r.stderr}`
    // diskpart 出错时不总是返回非零退出码，这里做一次文本兜底判断
    const hasError = /(无法|错误|error|failed|拒绝|Virtual Disk Service)/i.test(out)
    return { ok: r.code === 0 && !hasError, out: out.trim() }
  } finally {
    await fs.unlink(file).catch(() => undefined)
  }
}

export type PrepareMode = 'prepared' | 'offline' | 'none'

/**
 * 写入前的设备准备 —— 【绝对不会破坏目标盘】。
 *
 * ⚠️ 这里刻意【不再执行 diskpart clean】。
 * 原因：clean 在写入之前就把分区表清空；一旦随后的写入失败（权限、占用、驱动异常等），
 * 目标盘就变成一个「没有分区表的空盘」，在 Windows 里表现为「未知容量 / 无法写入」，
 * 这就是之前把 U 盘写坏的直接原因。
 *
 * 正确的顺序是「先确认能写、再做任何破坏」：
 *   1. 写盘脚本先以读+写方式打开 \\.\PhysicalDriveN（打不开就直接失败，目标盘毫发无损）；
 *   2. 再 FSCTL_LOCK_VOLUME + FSCTL_DISMOUNT_VOLUME 锁定并卸除该盘所有卷；
 *   3. 才从 offset 0 写入镜像（镜像自带分区表，自然覆盖旧分区表）。
 *
 * 所以这里只做非破坏性的准备：清除只读标记 + 确保磁盘联机。
 */
export async function prepareWindowsDevice(
  device: DeviceInfo,
  _wipe: boolean
): Promise<PrepareMode> {
  const n = device.rawId
  const r = await diskpart(
    `select disk ${n}\r\nattributes disk clear readonly\r\nonline disk\r\nexit\r\n`
  )
  if (!r.ok) {
    // 非致命：写盘脚本还会再尝试清除只读 / 联机
    return 'none'
  }
  return 'prepared'
}

export async function finalizeWindowsDevice(device: DeviceInfo, mode: PrepareMode): Promise<void> {
  const n = device.rawId
  if (mode === 'offline') {
    await diskpart(`select disk ${n}\r\nonline disk\r\nrescan\r\nexit\r\n`).catch(() => undefined)
  } else {
    await diskpart(`select disk ${n}\r\nrescan\r\nexit\r\n`).catch(() => undefined)
  }
}

/** Windows 侧的安全移除：让磁盘脱机后可以拔出 */
export async function ejectWindowsDevice(device: DeviceInfo): Promise<void> {
  await diskpart(`select disk ${device.rawId}\r\noffline disk\r\nexit\r\n`)
}

/* --------------------------- 非可引导：格式化 --------------------------- */

export type LogFn = (text: string, level: 'info' | 'warn' | 'error' | 'success') => void

/** diskpart 卷标限制：FAT32/exFAT 最多 11 字符，NTFS 最多 32；同时剔除会破坏命令行的字符 */
function sanitizeLabel(raw: string, fileSystem: FormatOptions['fileSystem']): string {
  const max = fileSystem === 'NTFS' ? 32 : 11
  return (raw || '')
    .replace(/["\r\n\t]/g, '')
    .trim()
    .slice(0, max)
}

/** 执行 diskpart 脚本并把每一行原始输出回显到界面日志（便于失败时定位） */
async function diskpartVerbose(script: string, onLog: LogFn): Promise<void> {
  const file = path.join(os.tmpdir(), `isoforge-fmt-${process.pid}-${Date.now()}.txt`)
  await fs.writeFile(file, script.replace(/\n/g, '\r\n'), 'utf8')
  try {
    const r = await run('diskpart', ['/s', file], 3600000)
    const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim()
    const errRe = /(失败|错误|error|failed|拒绝|无权|invalid|Virtual Disk Service|没有找到)/i
    for (const raw of out.split(/\r?\n/)) {
      const s = raw.trim()
      if (!s) continue
      onLog(`diskpart: ${s}`, errRe.test(s) ? 'warn' : 'info')
    }
    if (r.code !== 0 || errRe.test(out)) {
      throw new Error(`diskpart 执行失败（退出码 ${r.code}）\n${out}`)
    }
  } finally {
    await fs.unlink(file).catch(() => undefined)
  }
}

/**
 * 非可引导模式：把磁盘恢复成普通空盘（不写入任何镜像）。
 *
 * 与 dd 模式完全独立：不经过 burn.ps1，不受「锁卷 / 引导扇区保护」那套逻辑约束，
 * 直接用 diskpart 重建分区表并格式化，这是 Windows 上最标准可靠的做法。
 */
export async function formatWindowsDevice(
  device: DeviceInfo,
  fmt: FormatOptions,
  onLog: LogFn
): Promise<void> {
  const n = Number(device.rawId)
  if (!Number.isInteger(n) || n < 0) throw new Error(`无法识别的磁盘号：${device.rawId}`)
  if (device.protected || device.system) throw new Error('目标设备是系统盘，已拒绝操作')

  const style = fmt.partitionStyle === 'GPT' ? 'gpt' : 'mbr'
  const fsName = fmt.fileSystem.toLowerCase()
  const label = sanitizeLabel(fmt.label, fmt.fileSystem)

  onLog(
    `格式化参数：分区表 ${fmt.partitionStyle} · 文件系统 ${fmt.fileSystem}` +
      (label ? ` · 卷标 ${label}` : '') +
      ` · ${fmt.quick ? '快速格式化' : '完整格式化（会扫描坏扇区，大容量盘可能耗时很久）'}`,
    'info'
  )

  const script = [
    `select disk ${n}`,
    'attributes disk clear readonly',
    'online disk',
    'clean',
    `convert ${style}`,
    'create partition primary',
    label
      ? `format fs=${fsName} label="${label}"${fmt.quick ? ' quick' : ''}`
      : `format fs=${fsName}${fmt.quick ? ' quick' : ''}`,
    'assign',
    'exit'
  ].join('\r\n')

  await diskpartVerbose(script, onLog)
  await diskpart(`select disk ${n}\r\nrescan\r\nexit\r\n`).catch(() => undefined)
  onLog('格式化完成，磁盘已恢复为可正常读写的普通磁盘', 'success')
}
