// 仅供 UI 离屏自检（tools/ui-shot.cjs）使用：向页面注入一份假的 window.api，
// 让界面直接进入「已选镜像 + 已识别 + 自动推荐」的完整状态。
// 不参与打包，真机走 src/preload/index.ts。
const { contextBridge } = require('electron')
const { version } = require('../package.json')

const PROBE = {
  container: 'UDF',
  volumeLabel: 'PCHA_X64FREO_ZH-CN_DV9',
  family: 'windows',
  osName: 'Windows 11 25H2',
  version: '10.0.26200.8037',
  arch: 'x86_64 (64 位)',
  bootable: true,
  bootModes: ['UEFI (x64)', 'BIOS (Windows 引导)'],
  evidence: 'sources/INSTALL.WIM → 系统映像 10.0.26200.8037',
  confidence: 0.98,
  details: [
    { label: '卷标', value: 'PCHA_X64FREO_ZH-CN_DV9' },
    { label: '镜像大小', value: '7.71 GB' },
    { label: '系统映像', value: 'Windows 11 专业中文版' },
    { label: '服务分支', value: 'ge_release' }
  ]
}

// 场景二：Windows 10 零售盘 —— 盘里只写家族基础号 19041，按修订号判定为 22H2；
// 而文件名叫「24H2」（Windows 10 并无这一版本），应给出「文件名与内容不符」的提醒。
// 用 TOMATO_SHOT_SCENARIO=win10 触发，用来自检长依据行与提醒条是否撑坏布局。
const PROBE_WIN10 = {
  container: 'UDF',
  volumeLabel: 'ESD-ISO',
  family: 'windows',
  osName: 'Windows 10 22H2',
  version: '10.0.19045.3803',
  arch: 'x86_64 (64 位)',
  bootable: true,
  bootModes: ['UEFI (x64)', 'BIOS (Windows 引导)'],
  evidence:
    'sources/INSTALL.ESD → 系统映像：盘内写 10.0.19041.3803 · 零售盘只发行当时最新版：修订号 3803 ≥ Windows 10 22H2 首发 2130',
  confidence: 0.85,
  hint: '文件名里的 24H2 与镜像内容不符：这张盘实际是 Windows 10 22H2，请以镜像内容为准。',
  details: [
    { label: '卷标', value: 'ESD-ISO' },
    { label: '镜像大小', value: '4.64 GB' },
    { label: '盘内记录版本', value: '10.0.19041.3803（19041 是家族共用基础号）' },
    { label: '系统映像', value: 'Windows 10 家庭版 等 4 个版本' },
    { label: '服务分支', value: 'vb_release' }
  ]
}

// 场景三：镜像里取不到系统映像（只有 setup.exe 可读）——应降置信度并给出提示条。
// 用 TOMATO_SHOT_SCENARIO=ambiguous 触发，用来自检 hint 那一行是否正常渲染。
const PROBE_AMBIGUOUS = {
  container: 'UDF',
  volumeLabel: 'PCHA_X64FREO_ZH-CN_DV9',
  family: 'windows',
  osName: 'Windows 11 24H2 / 25H2',
  version: '10.0.26100.7920',
  arch: 'x86_64 (64 位)',
  bootable: true,
  bootModes: ['UEFI (x64)', 'BIOS (Windows 引导)'],
  evidence:
    '安装程序版本 10.0.26100.7920 —— 26100 这一内核号两个版本共用，仅凭它无法区分；且未能读出 sources/install.wim 内的真实版本',
  confidence: 0.55,
  hint:
    '这两个版本共用同一套系统内核，只有读取系统映像（install.wim / install.esd）内的版本才能区分。' +
    '本机这份镜像的内部版本没能读出来，建议装好后用 winver 确认，或换用官方原版镜像。',
  details: [
    { label: '卷标', value: 'PCHA_X64FREO_ZH-CN_DV9' },
    { label: '镜像大小', value: '7.71 GB' },
    { label: '安装程序版本', value: '10.0.26100.7920' },
    { label: '服务分支', value: 'ge_release' }
  ]
}

const SCENARIOS = {
  win11: {
    probe: PROBE,
    file: {
      name: 'Win11_25H2_Pro_Chinese_Simplified_x64_v2.iso',
      size: 8280907776
    }
  },
  win10: {
    probe: PROBE_WIN10,
    file: { name: 'Windows10-24H2.iso', size: 4983554048 }
  },
  ambiguous: {
    probe: PROBE_AMBIGUOUS,
    file: {
      name: 'Win11_25H2_Pro_Chinese_Simplified_x64_v2.iso',
      size: 8280907776
    }
  }
}

const ACTIVE = SCENARIOS[process.env.TOMATO_SHOT_SCENARIO] || SCENARIOS.win11

const DEVICES = [
  {
    id: 'win:2',
    displayName: 'SanDisk Ultra USB 3.0',
    size: 32212254720,
    devicePath: '\\\\.\\PhysicalDrive2',
    rawId: '2',
    mountPoints: ['E:'],
    removable: true,
    internal: false,
    system: false,
    protected: false,
    busType: 'USB',
    partitionStyle: 'MBR',
    readOnly: false,
    // USB 接口版本（后台补查，判不出来就没有这个字段）
    usbGen: 'USB 3.0',
    notes: ''
  },
  {
    // 顺带演示「USB 2.0」那种慢口：界面上会标成提醒色
    id: 'win:3',
    displayName: 'Generic Flash Disk',
    size: 80026361856,
    devicePath: '\\\\.\\PhysicalDrive3',
    rawId: '3',
    mountPoints: [],
    removable: true,
    internal: false,
    system: false,
    protected: false,
    busType: 'USB',
    partitionStyle: 'RAW',
    readOnly: false,
    usbGen: 'USB 2.0',
    notes: ''
  },
  {
    id: 'win:0',
    displayName: 'WDC WD40EZAZ-00SF3B0 (数据盘)',
    size: 4000787030016,
    devicePath: '\\\\.\\PhysicalDrive0',
    rawId: '0',
    mountPoints: ['D:'],
    removable: false,
    internal: true,
    system: false,
    protected: false,
    busType: 'SATA',
    partitionStyle: 'GPT',
    readOnly: false,
    notes: ''
  },
  {
    id: 'win:1',
    displayName: 'Samsung SSD 990 PRO 2TB',
    size: 2000398934016,
    devicePath: '\\\\.\\PhysicalDrive1',
    rawId: '1',
    mountPoints: ['C:'],
    removable: false,
    internal: true,
    system: true,
    protected: true,
    busType: 'NVMe',
    partitionStyle: 'GPT',
    readOnly: false,
    notes: '系统盘'
  }
]

const noop = () => () => undefined

contextBridge.exposeInMainWorld('api', {
  getEnv: async () => ({
    platform: 'win32',
    arch: 'x64',
    version,
    // TOMATO_SHOT_ELEVATED=0 用来截「未提权」那一态（顶栏会多出「以管理员重启」按钮，最挤）
    elevated: process.env.TOMATO_SHOT_ELEVATED !== '0',
    packaged: true
  }),
  elevate: async () => ({ ok: true, message: '已请求以管理员身份重新启动' }),
  listDevices: async () => ({ ok: true, devices: DEVICES }),
  pickImage: async () => `C:\\Users\\jingt\\Downloads\\${ACTIVE.file.name}`,
  statImage: async () => ({
    ok: true,
    info: {
      size: ACTIVE.file.size,
      name: ACTIVE.file.name,
      ext: '.iso'
    }
  }),
  // TOMATO_SHOT_PROBE_DELAY=<毫秒> 让「识别中」这一态停留久一点，配合 ui-gallery.cjs
  // 把识别动画那一段也截进效果图里（默认 0，即立刻返回）。
  probeImage: async () => {
    const wait = Number(process.env.TOMATO_SHOT_PROBE_DELAY || 0)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    return { ok: true, info: ACTIVE.probe }
  },
  startWrite: async () => ({ started: true }),
  cancelWrite: async () => true,
  eject: async () => ({ ok: true, message: '已安全弹出，可以拔出设备' }),
  setTheme: async () => ({ theme: 'light' }),
  // 弹窗遮罩打开时渲染层会通知主进程调窗口按钮底色。离屏环境没有 WCO，
  // 这里把它挂到 <html data-masked> 上，由 ui-gallery.cjs 注入的 CSS 换色，
  // 好在离屏截图中也能复现 / 验证「右上角那块亮斑」的修复。
  setOverlayMasked: async (masked) => {
    document.documentElement.setAttribute('data-masked', masked ? '1' : '0')
  },
  // 界面会把动作/报错写进启动日志；离屏自检没有主进程可写，吞掉即可
  diagLog: () => undefined,
  openAbout: () => undefined,
  closeAbout: () => undefined,
  onAboutGoto: noop,
  // 「U 盘还原」也是独立窗口；离屏自检里开不出来，静默即可
  openRestore: () => undefined,
  closeRestore: () => undefined,
  listRepairDisks: async () => ({ ok: true, disks: [] }),
  startRepair: async () => ({ started: true }),
  onProgress: noop,
  // USB 接口版本是后台补查的；离屏用的假数据已经自带 usbGen，这里不用做什么
  onUsbGen: noop,
  onLog: noop,
  onDone: noop
})
