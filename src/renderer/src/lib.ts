import type { IsoForgeApi } from '@shared/api'

declare global {
  interface Window {
    api?: IsoForgeApi
  }
}

/** 直接用浏览器打开页面时的兜底实现，避免白屏 */
const offline: IsoForgeApi = {
  getEnv: async () => ({ platform: 'web', arch: '-', version: '0.0.0', elevated: false, packaged: false }),
  elevate: async () => ({ ok: false, message: '当前不在 Electron 环境中运行' }),
  listDevices: async () => ({ ok: false, message: '未连接到主进程', devices: [] }),
  pickImage: async () => null,
  statImage: async () => ({ ok: false, message: '未连接到主进程' }),
  probeImage: async () => ({ ok: false, message: '未连接到主进程' }),
  startWrite: async () => ({ started: false, message: '未连接到主进程' }),
  cancelWrite: async () => false,
  listRepairDisks: async () => ({ ok: false, message: '未连接到主进程', disks: [] }),
  startRepair: async () => ({ started: false, message: '未连接到主进程' }),
  eject: async () => ({ ok: false, message: '未连接到主进程' }),
  setTheme: async () => ({ theme: 'light' }),
  setOverlayMasked: () => undefined,
  setOverlayMaskedAbout: () => undefined,
  diagLog: () => undefined,
  // 浏览器兜底里没有「独立窗口」这回事：什么都不做即可，绝不报错
  openAbout: () => undefined,
  closeAbout: () => undefined,
  onAboutGoto: () => () => undefined,
  // 「U 盘还原」独立窗口同理（浏览器兜底里开不出来，静默即可）
  openRestore: () => undefined,
  closeRestore: () => undefined,
  onProgress: () => () => undefined,
  onUsbGen: () => () => undefined,
  onLog: () => () => undefined,
  onDone: () => () => undefined
}

export const api: IsoForgeApi = window.api ?? offline

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '计算中…'
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  if (m < 60) return `${m} 分 ${s.toString().padStart(2, '0')} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${(m % 60).toString().padStart(2, '0')} 分`
}

export function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} 秒`
  const m = Math.floor(s / 60)
  return `${m} 分 ${Math.round(s % 60)} 秒`
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}
