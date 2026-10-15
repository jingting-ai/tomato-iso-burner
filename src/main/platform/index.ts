import type { DeviceInfo, FormatOptions } from '@shared/types'
import * as win from './windows'
import type { LogFn } from './windows'
import * as mac from './darwin'

export interface PlatformAdapter {
  list(): Promise<DeviceInfo[]>
  /**
   * 补查 USB 接口版本（USB 3.0 / 2.0 …）。**可选**：只有 Windows 实现了，
   * 别的平台没有就返回空数组，界面上不显示那一栏即可。
   */
  fetchUsbGen?(disks: { number: number; cacheKey: string }[]): Promise<win.UsbGenResult[]>
  prepare(device: DeviceInfo, wipe: boolean): Promise<string>
  finalize(device: DeviceInfo, mode: string): Promise<void>
  eject(device: DeviceInfo): Promise<void>
  /** 非可引导：把磁盘恢复成普通空盘（不写入任何镜像） */
  format(device: DeviceInfo, fmt: FormatOptions, onLog: LogFn): Promise<void>
}

const windows: PlatformAdapter = {
  list: () => win.listWindowsDevices(),
  fetchUsbGen: (disks) => win.fetchUsbGen(disks),
  prepare: (device, wipe) => win.prepareWindowsDevice(device, wipe),
  finalize: (device, mode) => win.finalizeWindowsDevice(device, mode as win.PrepareMode),
  eject: (device) => win.ejectWindowsDevice(device),
  format: (device, fmt, onLog) => win.formatWindowsDevice(device, fmt, onLog)
}

const darwin: PlatformAdapter = {
  list: () => mac.listMacDevices(),
  prepare: async (device) => {
    await mac.prepareMacDevice(device)
    return 'unmounted'
  },
  finalize: (device) => mac.finalizeMacDevice(device),
  eject: (device) => mac.ejectMacDevice(device),
  format: async () => {
    throw new Error('macOS 暂不支持「非可引导格式化」，请改用「整盘镜像刻录」模式')
  }
}

export function getAdapter(): PlatformAdapter {
  if (process.platform === 'win32') return windows
  if (process.platform === 'darwin') return darwin
  throw new Error(`暂不支持的平台：${process.platform}`)
}
