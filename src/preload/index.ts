import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type { DeviceInfo, LogEntry, ProgressState, RepairOptions, ThemePref, WriteOptions } from '@shared/types'
import type { AboutSection, IsoForgeApi } from '@shared/api'
import { IPC } from '@shared/api'

function subscribe(channel: string, cb: (payload: any) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: any): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: IsoForgeApi = {
  getEnv: () => ipcRenderer.invoke(IPC.env),
  elevate: () => ipcRenderer.invoke(IPC.elevate),
  listDevices: () => ipcRenderer.invoke(IPC.devices),
  pickImage: () => ipcRenderer.invoke(IPC.pickImage),
  statImage: (p: string) => ipcRenderer.invoke(IPC.statImage, p),
  probeImage: (p: string) => ipcRenderer.invoke(IPC.probeImage, p),
  startWrite: (options: WriteOptions) => ipcRenderer.invoke(IPC.writeStart, options),
  cancelWrite: () => ipcRenderer.invoke(IPC.writeCancel),
  listRepairDisks: () => ipcRenderer.invoke(IPC.repairList),
  startRepair: (options: RepairOptions) => ipcRenderer.invoke(IPC.repairStart, options),
  eject: (device: DeviceInfo) => ipcRenderer.invoke(IPC.eject, device),
  setTheme: (pref: ThemePref) => ipcRenderer.invoke(IPC.themeSet, pref),
  // 旧实现是 sendSync（同步 IPC），而且调用点还在 useLayoutEffect —— 也就是
  // **浏览器绘制之前**。主进程应答一慢/一卡，渲染进程就堵死在这儿：界面停在上一帧，
  // 点了「关于」什么也出不来，只有右上角窗口按钮换成了遮罩灰（2026-10-13 实测）。
  // 现在两道保险：① 换成异步 send（发出即走，不等应答，绝不阻塞绘制）；
  // ② 调用点也从 useLayoutEffect 挪到了绘制之后的 useEffect（见 App.tsx）。
  // 代价只是窗口按钮晚一帧换色，而遮罩本身有 160ms 过渡动画，肉眼看不出来。
  setOverlayMasked: (masked: boolean) => ipcRenderer.send(IPC.overlayMask, masked),
  // 「关于」窗口自己的浮层换色通道（两个窗口各记各的遮罩状态）
  setOverlayMaskedAbout: (masked: boolean) => ipcRenderer.send(IPC.overlayMaskAbout, masked),
  // 诊断日志：一律 fire-and-forget，绝不阻塞界面
  diagLog: (msg: string) => ipcRenderer.send(IPC.diagLog, msg),
  // 「关于 / 捐赠」是独立窗口：打开 / 跳转 / 关闭都是 fire-and-forget，不等应答
  openAbout: (section?: AboutSection) => ipcRenderer.send(IPC.aboutOpen, section ?? 'about'),
  closeAbout: () => ipcRenderer.send(IPC.aboutClose),
  onAboutGoto: (cb) => subscribe(IPC.aboutGoto, cb),
  // 「U 盘还原」同样是独立窗口（2026-10-14 用户：「单独弹出来一个窗口吧」）
  openRestore: () => ipcRenderer.send(IPC.restoreOpen),
  closeRestore: () => ipcRenderer.send(IPC.restoreClose),
  onProgress: (cb) => subscribe(IPC.writeProgress, cb),
  // USB 接口版本是后台补的，到得比列表晚
  onUsbGen: (cb) => subscribe(IPC.devicesUsbGen, cb),
  onLog: (cb) => subscribe(IPC.writeLog, cb),
  onDone: (cb) => subscribe(IPC.writeDone, cb)
}

contextBridge.exposeInMainWorld('api', api)
