/** 统一的磁盘设备描述（Windows / macOS 归一化后的结构） */
export interface DeviceInfo {
  /** 平台唯一 id，例如 win:1 / darwin:disk4 */
  id: string
  /** 展示名称（型号 + 媒体名） */
  displayName: string
  /** 容量（字节） */
  size: number
  /** 实际写入路径：Windows \\.\PhysicalDriveN，macOS /dev/rdiskN */
  devicePath: string
  /** Windows 磁盘号 / macOS 设备标识（diskN） */
  rawId: string
  /** 挂载点或盘符 */
  mountPoints: string[]
  /** 是否可移动介质（U 盘 / SD 卡） */
  removable: boolean
  /** 是否内置磁盘 */
  internal: boolean
  /** 是否系统盘 / 启动盘（禁止写入） */
  system: boolean
  /** 是否受保护（系统盘或不可写），UI 层禁止选择 */
  protected: boolean
  /** 接口类型：USB / NVMe / SATA ... */
  busType: string
  /**
   * USB 接口版本（USB 3.0 / USB 2.0 / USB 1.1 …），只对 USB 总线上的盘有值。
   * 判不出来就不给 —— 绝不猜一个糊弄人。
   */
  usbGen?: string
  /** 分区样式或分区图类型 */
  partitionStyle: string
  /** 写保护 / 只读 */
  readOnly: boolean
  /** 展示用的补充说明 */
  notes?: string
}

export interface ImageInfo {
  path: string
  name: string
  size: number
  /** 扩展名小写，如 .iso */
  ext: string
}

export type WritePhase = 'idle' | 'prepare' | 'write' | 'verify' | 'done' | 'error' | 'cancelled'

export interface ProgressState {
  phase: WritePhase
  /** 当前阶段进度 0-100 */
  percent: number
  writtenBytes: number
  totalBytes: number
  /** 字节/秒 */
  speed: number
  /** 剩余秒数，-1 表示未知 */
  etaSeconds: number
  message: string
}

/**
 * 写入模式。
 *  dd     —— 整盘镜像原样写入（把镜像的每个字节写到磁盘 offset 0）
 *  format —— 非可引导：不写镜像，把磁盘恢复成普通空盘
 *  repair —— U 盘急救修复：清只读 → 刷几何 → 盘头写零 → 重建分区表 → 格式化
 */
export type WriteMode = 'dd' | 'format' | 'repair'

/** 分区表类型 */
export type PartitionStyle = 'MBR' | 'GPT'

/** 目标文件系统 */
export type FileSystemType = 'FAT32' | 'NTFS' | 'exFAT'

/** 非可引导（格式化）模式的参数 */
export interface FormatOptions {
  partitionStyle: PartitionStyle
  fileSystem: FileSystemType
  /** 卷标（FAT32/exFAT 最多 11 字符，NTFS 最多 32） */
  label: string
  /** 快速格式化：只写文件系统元数据，不扫描坏扇区 */
  quick: boolean
}

/**
 * 修复脚本（repair.ps1）扫出来的一块物理盘。
 *
 * 与普通磁盘列表的区别：它直接扫 \\.\PhysicalDrive0..15，所以**系统（Get-Disk）
 * 列不出来**的盘（未知容量 / RAW / 无盘符 / 「没有媒体」）也会出现在这里 ——
 * 刻录失败变砖的 U 盘多半就是这个状态。
 */
export interface RepairDiskInfo {
  /** Windows 磁盘号 */
  number: number
  name: string
  /** 总线类型：USB / NVMe / SATA / Unknown */
  bus: string
  size: number
  /** 盘符，逗号分隔；可能为空 */
  letters: string
  /** 系统（Get-Disk）能不能列出这块盘 */
  visible: boolean
  /** 裸读第一个扇区是否成功 */
  readable: boolean
  /** 读失败时的 Win32 错误码 */
  err: number
  /** 内置盘 / 系统盘 / 含 C: 的盘 —— 一律禁止操作 */
  bad: boolean
}

/** U 盘修复模式的参数 */
export interface RepairOptions {
  diskNumber: number
  fileSystem: FileSystemType
  label: string
}

export interface WriteOptions {
  /** 写入模式，决定后端走哪条流程 */
  mode: WriteMode
  /** 镜像路径；format 模式下为空字符串 */
  imagePath: string
  device: DeviceInfo
  /** 写入后是否做校验（仅 dd 模式有效） */
  validate: boolean
  /** 是否在写入前清空目标盘分区表（仅 dd 模式有效） */
  wipeBeforeWrite: boolean
  /** format 模式使用 */
  format: FormatOptions
}

/** dd 模式的默认值，供 UI 初始化 */
export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  partitionStyle: 'MBR',
  fileSystem: 'FAT32',
  label: '',
  quick: true
}

export interface WriteResult {
  ok: boolean
  message: string
  sourceSha256?: string
  targetSha256?: string
  bytesWritten: number
  elapsedMs: number
}

/** USB 接口版本补查结果（后台算完才推给界面） */
export interface UsbGenResult {
  /** Windows 磁盘号 */
  number: number
  /** USB 3.0 / USB 2.0 / USB 1.1 … */
  usbGen: string
}

export type PlatformName = 'win32' | 'darwin' | 'linux' | (string & {})

export interface AppEnv {
  platform: PlatformName
  arch: string
  version: string
  /** 是否具备刻录所需的特权（Windows 管理员 / macOS root） */
  elevated: boolean
  /** 是否为打包后的应用 */
  packaged: boolean
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'success'
  text: string
  time: number
}

/**
 * 界面主题偏好。
 *  auto  —— 跟随系统（Windows「浅色 / 深色」设置）
 *  light —— 始终浅色
 *  dark  —— 始终深色
 */
export type ThemePref = 'auto' | 'light' | 'dark'

/** 解析后的实际主题（auto 会按系统设置落成 light 或 dark） */
export type ThemeResolved = 'light' | 'dark'

/** 镜像所属系统家族，用于 UI 分类与配色 */
export type ImageFamily = 'linux' | 'windows' | 'dos' | 'bsd' | 'macos' | 'hypervisor' | 'unknown'

/** 镜像内容识别结果（只读探测，不修改任何文件） */
export interface ImageProbeInfo {
  /** 容器/文件系统描述，如 "ISO 9660 + Joliet + UDF" */
  container: string
  /** 卷标 */
  volumeLabel: string
  /** 系统家族 */
  family: ImageFamily
  /** 系统名称（含版本），如 "Ubuntu 24.04.1 LTS" */
  osName: string
  /** 版本号，可能为空字符串 */
  version: string
  /** 架构，如 "x86_64 (64 位)" */
  arch: string
  /** 是否含引导信息 */
  bootable: boolean
  /** 引导方式列表，如 ["UEFI (x64)", "BIOS (ISOLINUX)"] */
  bootModes: string[]
  /** 识别依据 */
  evidence: string
  /** 置信度 0~1 */
  confidence: number
  /** 需要在界面上单独提醒的一句话（例如版本无法区分时说明原因） */
  hint?: string
  /** 补充信息 */
  details: Array<{ label: string; value: string }>
}
