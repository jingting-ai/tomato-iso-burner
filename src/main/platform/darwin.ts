import type { DeviceInfo } from '@shared/types'
import { run } from '../exec'
import { parsePlist } from '../plist'

interface DiskUtilEntry {
  DeviceIdentifier?: string
  SizeBytes?: number
  Content?: string
  MountPoint?: string
  VolumeName?: string
  Partitions?: DiskUtilEntry[]
}

async function info(identifier: string): Promise<Record<string, any>> {
  const r = await run('diskutil', ['info', '-plist', identifier])
  if (!r.stdout.trim()) return {}
  try {
    return parsePlist(r.stdout) || {}
  } catch {
    return {}
  }
}

const truthy = (v: unknown): boolean => v === true || v === 'Yes' || v === 'yes' || v === 1

export async function listMacDevices(): Promise<DeviceInfo[]> {
  const r = await run('diskutil', ['list', '-plist'])
  if (!r.stdout.trim()) throw new Error('未能获取磁盘列表：diskutil 返回为空')

  let plist: any
  try {
    plist = parsePlist(r.stdout)
  } catch (e) {
    throw new Error('解析 diskutil 输出失败：' + String(e))
  }

  const entries: DiskUtilEntry[] = plist?.AllDisksAndPartitions ?? []
  const devices: DeviceInfo[] = []

  for (const entry of entries) {
    const id = entry.DeviceIdentifier
    if (!id) continue
    // 只处理整盘（diskN），跳过分区（diskNsM）
    if (id.includes('s')) continue

    const meta = await info(id)
    const internal = truthy(meta.Internal)
    const removable = truthy(meta.Removable) || meta.Removable === 'Removable Media'
    const size = Number(entry.SizeBytes ?? meta.SizeBytes ?? meta.TotalSize ?? 0)
    const mountPoints: string[] = []
    let isSystemDisk = false

    for (const p of entry.Partitions ?? []) {
      const mp = p.MountPoint
      if (mp) {
        mountPoints.push(mp)
        if (mp === '/') isSystemDisk = true
      }
      // 虚拟磁盘 / EFI 分区等没有挂载点，忽略
    }

    const mediaName = String(meta.MediaName || meta.IORegistryEntryName || '').trim()
    const name = mediaName || String(entry.Content || '').replace(/_/g, ' ') || id

    devices.push({
      id: `darwin:${id}`,
      rawId: id,
      displayName: name,
      size,
      devicePath: `/dev/r${id}`,
      mountPoints,
      removable: removable || !internal,
      internal,
      system: isSystemDisk,
      protected: isSystemDisk,
      busType: String(meta.BusProtocol || 'Unknown'),
      partitionStyle: String(entry.Content || meta.Content || 'Unknown'),
      readOnly: truthy(meta.WritableMedia) === false && truthy(meta.ReadOnlyMedia),
      notes: internal ? '内置磁盘' : undefined
    } satisfies DeviceInfo)
  }

  return devices
}

export async function prepareMacDevice(device: DeviceInfo): Promise<void> {
  const id = device.rawId
  let r = await run('diskutil', ['unmountDisk', `/dev/${id}`])
  if (r.code !== 0) {
    r = await run('diskutil', ['unmountDisk', 'force', `/dev/${id}`])
  }
  if (r.code !== 0) {
    throw new Error(`无法卸载磁盘 /dev/${id}：${(r.stderr || r.stdout).trim()}`)
  }
}

export async function finalizeMacDevice(device: DeviceInfo): Promise<void> {
  // 重新挂载，写入 NTFS/exFAT 等不可识别的文件系统会失败，忽略即可
  await run('diskutil', ['mountDisk', `/dev/${device.rawId}`]).catch(() => undefined)
}

export async function ejectMacDevice(device: DeviceInfo): Promise<void> {
  const r = await run('diskutil', ['eject', `/dev/${device.rawId}`])
  if (r.code !== 0) throw new Error(`弹出失败：${(r.stderr || r.stdout).trim()}`)
}
