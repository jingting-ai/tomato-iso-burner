import type {
  AppEnv,
  DeviceInfo,
  ImageProbeInfo,
  LogEntry,
  ProgressState,
  ThemePref,
  ThemeResolved,
  RepairDiskInfo,
  RepairOptions,
  UsbGenResult,
  WriteOptions,
  WriteResult
} from './types'

export interface ListDevicesResult {
  ok: boolean
  message?: string
  devices: DeviceInfo[]
}

export interface ImageStatResult {
  ok: boolean
  message?: string
  info?: { size: number; name: string; ext: string }
}

/** 镜像内容识别结果 */
export interface ImageProbeResult {
  ok: boolean
  message?: string
  info?: ImageProbeInfo
}

export interface StartResult {
  started: boolean
  message?: string
}

/** 深度扫描（含系统认不出的「隐身盘」）的结果 */
export interface RepairListResult {
  ok: boolean
  message?: string
  disks: RepairDiskInfo[]
}

export interface ElevateResult {
  ok: boolean
  message: string
}

export interface EjectResult {
  ok: boolean
  message: string
}

export interface ThemeResult {
  /** 解析后的实际主题，供主进程同步原生控件配色 */
  theme: ThemeResolved
}

/**
 * 「关于 / 捐赠」窗口里的小节。
 *
 * 入口有三个（顶栏「关于」、底栏「关于」、底栏「捐赠」），
 * 落点由它决定 —— 点「捐赠」就该直接看到收款码，而不是从最上面再滚一遍。
 */
export type AboutSection = 'about' | 'donate'

export interface IsoForgeApi {
  getEnv(): Promise<AppEnv>
  elevate(): Promise<ElevateResult>
  listDevices(): Promise<ListDevicesResult>
  pickImage(): Promise<string | null>
  statImage(path: string): Promise<ImageStatResult>
  /** 读取镜像里的系统信息（只读，不修改文件） */
  probeImage(path: string): Promise<ImageProbeResult>
  startWrite(options: WriteOptions): Promise<StartResult>
  cancelWrite(): Promise<boolean>
  /** 深度扫描：连「此电脑 / 磁盘管理里完全看不到」的盘也一起找出来 */
  listRepairDisks(): Promise<RepairListResult>
  /** U 盘急救修复：清只读 → 刷几何 → 盘头写零 → 重建分区表 → 格式化 */
  startRepair(options: RepairOptions): Promise<StartResult>
  eject(device: DeviceInfo): Promise<EjectResult>
  /** 应用界面主题偏好，返回解析后的实际主题 */
  setTheme(pref: ThemePref): Promise<ThemeResult>
  /**
   * 弹窗遮罩打开 / 关闭时通知主进程。
   *
   * 右上角的窗口按钮是系统「叠画」在网页之上的独立图层，网页里的半透明遮罩
   * 压不到它 —— 弹窗打开时它会突兀地留一块亮斑。这里把遮罩后的等效色递给
   * 主进程，让那一块跟着一起变暗。
   *
   * **必须是异步的（fire-and-forget），不能改成同步 IPC**：调用点在
   * useLayoutEffect 里 —— 那是浏览器绘制之前，同步等主进程应答会把渲染进程
   * 堵死在首帧之前，界面直接白屏（2026-10-13 定位到的真凶之一）。
   * 异步发的代价是换色可能晚一帧，遮罩自带 160ms 过渡，看不出来。
   */
  setOverlayMasked(masked: boolean): void
  /**
   * 「关于」窗口自己的浮层（二维码放大）开关。与 `setOverlayMasked` 分开：
   * 那个窗口换色不该波及主窗口 —— 两个窗口各记各的遮罩状态。
   */
  setOverlayMaskedAbout(masked: boolean): void
  /**
   * 往启动日志（%APPDATA%\<应用名>\startup.log）里写一条界面侧记录。
   *
   * 用于排障：界面里的操作（例如点「关于」）和渲染层报错都记到磁盘上，
   * 这样即使窗口没显示出来、看不到界面内的日志面板，也能拿到线索。
   */
  diagLog(msg: string): void
  /**
   * 打开「关于 / 捐赠」——**一个独立的窗口**，不是叠在主界面上的弹层。
   *
   * 2026-10-14 用户原话：「关于这个框……实在不行就做成单独独立的框吧，
   * 要不然一点关于，上面就很不协调」。做成独立窗口后，主界面那一条 62px 的
   * 合并标题栏不再被任何遮罩压住，右上角那块系统叠画的窗口按钮也不需要跟着
   * 换色 —— 主界面从头到尾保持原样。
   *
   * 参数决定打开后停在哪一节：`'donate'` 直接落到收款码那里。
   */
  openAbout(section?: AboutSection): void
  /** 关闭「关于」窗口（只有那个窗口自己会调） */
  closeAbout(): void
  /** 「关于」窗口已经开着、又要求跳到某一节时，主进程从这里转发过来 */
  onAboutGoto(cb: (section: AboutSection) => void): () => void
  /**
   * 打开「U 盘还原」——**一个独立的窗口**，与「关于」同一套做法。
   *
   * 2026-10-14 用户原话：「点U盘还原最好还是单独弹出来一个窗口吧，把U盘还原」。
   * 还原的整套流程（选盘 → 选文件系统 → 确认 → 还原 → 看日志）都搬进那个窗口，
   * 主界面只剩刻录，首页不再被还原的一大堆选项占满。
   */
  openRestore(): void
  /** 关闭「U 盘还原」窗口（只有那个窗口自己会调） */
  closeRestore(): void
  onProgress(cb: (s: ProgressState) => void): () => void
  /** USB 接口版本补查结果（后台算完才到，可能为空数组） */
  onUsbGen(cb: (rows: UsbGenResult[]) => void): () => void
  onLog(cb: (l: LogEntry) => void): () => void
  onDone(cb: (r: WriteResult) => void): () => void
}

export const IPC = {
  env: 'env:get',
  elevate: 'app:elevate',
  devices: 'devices:list',
  pickImage: 'dialog:pickImage',
  statImage: 'image:stat',
  probeImage: 'image:probe',
  writeStart: 'write:start',
  writeCancel: 'write:cancel',
  repairList: 'repair:list',
  repairStart: 'repair:start',
  writeProgress: 'write:progress',
  writeLog: 'write:log',
  writeDone: 'write:done',
  devicesUsbGen: 'devices:usbGen',
  eject: 'device:eject',
  themeSet: 'theme:set',
  overlayMask: 'titlebar:overlayMask',
  overlayMaskAbout: 'titlebar:overlayMaskAbout',
  diagLog: 'diag:log',
  aboutOpen: 'about:open',
  aboutClose: 'about:close',
  aboutGoto: 'about:goto',
  restoreOpen: 'restore:open',
  restoreClose: 'restore:close'
} as const
