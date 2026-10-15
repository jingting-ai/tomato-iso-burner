import os from 'node:os'
import path from 'node:path'
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import type { BrowserWindowConstructorOptions, WebContents } from 'electron'
import type {
  AppEnv,
  DeviceInfo,
  LogEntry,
  ProgressState,
  RepairOptions,
  ThemePref,
  WriteOptions,
  WriteResult
} from '@shared/types'
import { appTitle } from '@shared/version'
import { IPC } from '@shared/api'
import type { AboutSection } from '@shared/api'
import { diag, diagInit, diagPath } from './diag'
import { isElevated, elevate } from './elevate'
import { getAdapter } from './platform'
import { probeImage } from './iso/probe'
import { BurnJob, CancelledError, statImage } from './writer'
import { listRepairDisks, runRepair } from './repair'
import { runPowerShell } from './exec'

/* ---------------------- GPU / 软件渲染（★ 2026-10-13 定案） ----------------------
 * 下面四行禁用 GPU 加速：工具类界面用不上 GPU，而且虚拟机 / 远程桌面 / 显卡异常的
 * 机器上开着它会出现 GPU 进程反复崩溃（2026-10-13 在受限会话里实测：0xC0000005 连崩 8 次）。
 *
 * ⚠️ 但它有个必须记住的副作用，用 tools/_paint-test.cjs 量出来的：
 *
 *     开关组合                          隐藏窗口的 ready-to-show（= 首帧已画好的信号）
 *     --disable-gpu-compositing         ~0.5s  正常
 *     --disable-gpu-sandbox             ~0.5s  正常
 *     --disable-gpu                     永不触发
 *     app.disableHardwareAcceleration() 永不触发
 *     上面全开 + 窗口创建即显示           ~0.4s  正常
 *
 * 即：**只要禁用 GPU，隐藏状态的窗口就根本不会绘制第一帧。**
 * 这正是「双击打不开」的真凶 —— 老代码是 show:false + 只在 ready-to-show 里 show()，
 * 首帧永远不来，窗口就永远不出现。所以 createWindow 里必须 `show: true`：
 * 窗口可见才会收到 BeginFrame、才会绘制。**这两件事是绑的，不要只改一边。**
 */
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-gpu-sandbox')
// 关掉 Chromium 的「原生窗口遮挡检测」：它会把系统判定为「被遮挡」的窗口当作不需要绘制，
// 直接不下发 BeginFrame —— 表现就是窗口开着却永远空白。这是 Electron 在 Windows 上
// 「白屏窗口」最常见的一类成因，代价只是被遮挡时多花一点 CPU，本工具界面也吃不满。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

/* ------------------------- 绿色版（单文件便携版）判定 -------------------------
 * 用户要的「绿色版」= 一个 exe，双击就能用，不在系统里留东西。
 * electron-builder 的 portable 目标正好是这个形态：启动器把「外层那个单文件」
 * 的位置通过环境变量传进来 —— 安装版没有这些变量。保险起见再加一条判据：
 * 便携版是解包到临时目录里跑的，process.execPath 必然落在 %TEMP% 下。
 */
const portableHint = process.env['PORTABLE_EXECUTABLE_FILE'] || process.env['PORTABLE_EXECUTABLE_DIR'] || ''
const isPortable =
  portableHint.length > 0 || process.execPath.toLowerCase().startsWith(os.tmpdir().toLowerCase())

/**
 * 「绿色」文件夹版（把 win-unpacked 整个目录拷走直接跑的那种，例如 E:\番茄镜像刻录工具\）。
 * 判据：**安装版一定住在 Program Files 里**（NSIS 的 perMachine 安装固定如此），
 * 不在那儿的就是绿色副本。这样不用往目录里塞标记文件，拷到哪都认得出。
 */
const inProgramFiles = /[\\/]program files( \(x86\))?[\\/]/i.test(process.execPath)
const isGreenFolder = app.isPackaged && !isPortable && !inProgramFiles

/** 本次运行是不是绿色形态（单文件版 / 绿色文件夹版都算） */
const isGreen = isPortable || isGreenFolder

/**
 * 「本次运行是不是已经为提权跑过一轮了」。
 *
 * 用**环境变量**而不是命令行参数做标记：环境变量会被子进程继承，
 * 哪怕外层那个单文件启动器不转发参数也拦得住 —— 这是防「无限重启」的关键。
 * 命令行参数只作为第二道保险。
 */
const elevateAttempted =
  process.env['TOMATO_ELEVATED'] === '1' || process.argv.includes('--elevated')

/**
 * 绿色版不往 %APPDATA% 写任何东西：缓存、偏好、日志一律改到系统临时目录，
 * 退出后随系统清理 —— 用户手上永远只有「一个 exe」，删掉即干净。
 * 安装版保持原样（%APPDATA%\<产品名>），那是长期用的，缓存留着下次启动更快。
 *
 * ⚠️ 这里顺带解决一个真实故障：安装版和绿色版如果共用同一份 userData，
 *    Electron 的单实例锁会互相顶掉 —— 先开了安装版，再双击绿色版，
 *    后者会「静默退出、界面上什么都不显示」，用户看到的就是「双击没反应」。
 *    分开之后两边各开各的，互不干扰。
 *
 * 必须在 app ready 之前设置，也必须早于 diagInit（它要读 userData）。
 */
if (isGreen) {
  try {
    // 两种绿色形态各用各的目录：单文件版和绿色文件夹版互不干扰，
    // 也不会跟安装版抢单实例锁。
    app.setPath('userData', path.join(os.tmpdir(), isPortable ? 'tomato-iso-burner-portable' : 'tomato-iso-burner-green'))
  } catch {
    // 极端情况下设不进去：退回默认 userData，不影响启动
  }
}

/* ------------------------------ 启动自述日志 ------------------------------
 * 窗口出过的两种毛病（「双击打不开」= 窗口不出现、「打开了但全白」= 首帧没画）
 * 都发生在主进程里，而界面自己的日志面板这时根本看不到。把启动全过程写到磁盘，
 * 出问题时直接读 startup.log 定位，不靠猜。见 src/main/diag.ts 的注释。
 *
 * 绿色版走 deferred：平时一个文件都不产生，只有真出异常时才落盘（在临时目录里）。 */
diagInit(isGreen ? 'deferred' : 'file')
diag(`=================== 启动 pid=${process.pid} ===================`)
diag(`版本=${app.getVersion()} 打包=${app.isPackaged} 平台=${process.platform}/${process.arch}`)
diag(`resourcesPath=${process.resourcesPath}`)
diag(`exe=${process.execPath}`)
diag(`形态=${isPortable ? '绿色版·单文件' : isGreenFolder ? '绿色版·文件夹' : '安装版'} 已提权过一轮=${elevateAttempted}`)
diag(`argv=${JSON.stringify(process.argv)}`)
diag(`userData=${app.getPath('userData')}`)
diag(`日志文件=${diagPath() || '(不可写，仅控制台)'}`)

process.on('uncaughtException', (err) => {
  diag(`!! uncaughtException: ${(err as Error)?.stack || String(err)}`)
})
process.on('unhandledRejection', (reason) => {
  diag(`!! unhandledRejection: ${String(reason)}`)
})

const isMac = process.platform === 'darwin'

/** 窗口底色，与界面主题保持一致，避免加载瞬间闪白 / 闪黑 */
const BG_LIGHT = '#f4f6fb'
const BG_DARK = '#0f1116'

function themeBackground(): string {
  return nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT
}

/**
 * 界面顶栏的高度（DIP）。无边框窗口下，右上角的窗口按钮就叠画在这一条上，
 * 所以这个值必须与渲染层 `.topbar` 的实际高度（styles.css）保持一致，
 * 否则按钮会与顶栏内容错位。
 */
const TITLEBAR_H = 62

/**
 * 窗口按钮叠层的高度（DIP）—— **刻意比顶栏少 1px**。
 *
 * 全局是 `box-sizing: border-box`，而 `.topbar` 是 `height:62px + border-bottom:1px`，
 * 也就是说那条分隔线占的是第 61~62px，**落在叠层里头**。叠层是系统画的不透明色块，
 * 会把这一段线整个盖掉 —— 于是分隔线走到按钮那儿就断了，右上角看着像被切了一刀
 * （2026-10-14 用户原话：「分割开了，到 x 窗口那里，割裂开了」）。
 *
 * 把叠层压到 61px，分隔线（61~62px）就露在叠层外面，横贯整窗，顶栏与内容区
 * 重新连成一个整体。顶栏的内容区本来就是 61px（62 减掉 1px 边框），
 * 按钮的垂直居中因此完全不变，不会错位。
 * 「关于」窗口（.about-head）同理，两个窗口共用这一个值。
 */
const OVERLAY_H = TITLEBAR_H - 1

/** 窗口按钮（最小化 / 最大化 / 关闭）的配色，跟随界面主题，免得深浅切换时突兀 */
const OVERLAY_LIGHT = { color: '#ffffff', symbolColor: '#22262f' }
const OVERLAY_DARK = { color: '#171a21', symbolColor: '#e7eaf0' }

/**
 * 弹窗打开时的窗口按钮底色。
 *
 * 右上角这块是系统叠画在网页之上的独立图层，网页里的 `.modal-mask`
 * 压不到它 —— 不换色就会在遮罩里留一块亮斑（用户报的「这里有点异常」）。
 * 取值 = 把 `--mask` 叠在 `--surface` 上算出的等效实色，再按截图像素实测微调：
 *   浅色 0.42 × rgba(15,23,42) over #ffffff  → 公式值 #9a9ea6，
 *        但 backdrop-blur 会把背后的界面内容平均进来，实测遮罩灰 (149,152,161)，
 *        取 #9699a2（150,153,162）与周边融合最好
 *   深色 0.58 × rgba(3,6,12)  over #171a21  → #0b0e15（公式值与实测一致）
 * 改动这两个值时必须回到 styles.css 的 `--mask` / `--surface` 重新算一遍。
 */
const OVERLAY_LIGHT_MASKED = { color: '#9699a2', symbolColor: '#22262f' }
const OVERLAY_DARK_MASKED = { color: '#0b0e15', symbolColor: '#e7eaf0' }

/** 主窗口当前是否有弹窗遮罩打开（由渲染层通过 `titlebar:overlayMask` 同步过来） */
let overlayMasked = false
/** 「关于」窗口当前是否有浮层打开（二维码放大等，走 `titlebar:overlayMaskAbout`）。
 *  ⚠️ 必须和主窗口分开记：关于窗口里开了浮层，不该把主窗口的按钮也一起换色。 */
let aboutOverlayMasked = false

/** 按主题与遮罩状态给出窗口按钮的配色 */
function overlayColors(masked: boolean): { color: string; symbolColor: string } {
  const dark = nativeTheme.shouldUseDarkColors
  if (masked) return dark ? OVERLAY_DARK_MASKED : OVERLAY_LIGHT_MASKED
  return dark ? OVERLAY_DARK : OVERLAY_LIGHT
}

function titleBarOverlay(): { color: string; symbolColor: string } {
  return overlayColors(overlayMasked)
}

/**
 * 只有 Windows 才做「隐藏系统标题栏 + 叠画窗口按钮」：
 * macOS 的红绿灯按钮在左侧、由系统托管最省事，Linux 的叠层支持也不一致，
 * 这两者一律保持原生标题栏。判据与下面的 frameOptions 必须一致。
 */
const useTitleBarOverlay = process.platform === 'win32'

/** 把当前主题色同步给几个窗口的窗口按钮（主窗口 / 关于窗口 / 还原窗口各按各的遮罩状态） */
function syncTitleBarOverlay(): void {
  if (!useTitleBarOverlay) return
  for (const [win, masked] of [
    [mainWindow, overlayMasked],
    [aboutWindow, aboutOverlayMasked],
    // 还原窗口内部没有任何模态弹层，遮罩状态恒为 false
    [restoreWindow, false]
  ] as const) {
    if (!win || win.isDestroyed()) continue
    try {
      win.setTitleBarOverlay({ ...overlayColors(masked), height: OVERLAY_H })
    } catch {
      // 个别环境不支持窗口按钮叠层：忽略即可，不影响其它功能（窗口按钮退化为系统默认配色）
    }
  }
}

let mainWindow: BrowserWindow | null = null
let restoreWindow: BrowserWindow | null = null
let currentJob: BurnJob | null = null
/**
 * 是否有任何破坏性任务在跑（刻录或还原）。
 *
 * 2026-10-14 起「U 盘还原」是独立窗口，用户完全可能一边还原、一边回主界面点刻录 ——
 * 两个写盘操作同时进行可能互相踩（同一块盘更是直接毁数据）。所以两边都过这道闸。
 */
let jobRunning = false
let cancelRequested = false
// 记录「写入阶段」最后一个进度值。失败时用它填 bytesWritten，
// 否则失败卡片会显示「写入 0 B」，即使其实已经写进去好几个 GB（会误导人以为没写）。
let lastWrittenBytes = 0

/**
 * 任务事件（进度 / 日志 / 完成）当前要发给哪个窗口。
 *
 * 2026-10-14「U 盘还原」搬进独立窗口之后，刻录与还原可能从**不同窗口**发起：
 *  · 从主界面点「开始刻录」→ 事件该回主窗口；
 *  · 从还原窗口点「开始还原」→ 事件该回还原窗口。
 * 一律广播会让另一个窗口也收到 write:done，把它的界面冷不丁切成结果卡片
 * （主窗口停在「选择」阶段时突然显示「还原完成」就是这么来的）。
 * 所以这里记下发起任务的 webContents，没有任务时退回主窗口。
 */
let eventTarget: WebContents | null = null

function send(channel: string, payload: unknown): void {
  // 任务事件只认发起窗口。那个窗口没了（例如还原中途把窗口关了）就作废，
  // **绝不转投主窗口** —— 否则主界面会冷不丁弹出「还原完成」的结果卡片，
  // 而用户根本没在那个窗口里操作过。
  if (eventTarget) {
    if (!eventTarget.isDestroyed()) eventTarget.send(channel, payload)
    return
  }
  const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  target?.send(channel, payload)
}

function log(text: string, level: LogEntry['level'] = 'info'): void {
  send('write:log', { level, text, time: Date.now() } satisfies LogEntry)
}

/**
 * 任务栏身份（AppUserModelID）。值必须与 electron-builder.yml 里的 appId 一致 ——
 * 安装包写进快捷方式的也是这个值。
 *
 * 不设置的话 Windows 会按 exe 路径另算一个身份：任务栏 / 固定项跟应用对不上号，
 * 「换了新图标但任务栏一直是旧图标」多半就是这么来的（2026-10-14 用户报的现象）。
 * 注意：这里也顺便保证「无论从哪个副本启动，任务栏都归到同一项」。
 */
const APP_ID = 'com.doro.isoburner'

app.setAppUserModelId(APP_ID)

/**
 * 应用图标（番茄，由 tools/make-icon.py 生成）。
 * 打包后走 extraResources 放出来的 resources/app-icon.ico；
 * 开发时直接读 build/ 下的源文件 —— 两条路都取不到就返回 undefined，
 * 交给 Electron 用默认图标，绝不因为图标缺失而让窗口创建失败。
 */
function appIcon(): string | undefined {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'app-icon.ico')
    : path.join(__dirname, '../../build/icon.ico')
  return existsSync(p) ? p : undefined
}

/**
 * 在渲染层里跑一次，把「界面到底长什么样」抓回来写进启动日志。
 *
 * 这是界面白屏时的黑匣子：窗口画不出来时，界面自己的日志面板同样看不到，
 * 只有主进程隔着 IPC 去问渲染层「你 DOM 里到底有什么」才拿得到真相。
 * 写成具名函数再 toString() 注入，避免在模板串里跟正则、换行符打架。
 */
function rendererSnapshot(): string {
  // 这段代码是发给渲染进程跑的，主进程的 tsconfig 里没有 DOM 类型库，
  // 所以统一从 globalThis 上取（打包后 as any 会被抹掉，不影响注入的源码）。
  const g = globalThis as any
  const nl = String.fromCharCode(10)
  const root = g.document.getElementById('root')
  const body = g.document.body
  const text = body ? body.innerText : ''
  return JSON.stringify({
    readyState: g.document.readyState,
    url: String(g.location.href).slice(-70),
    rootChildren: root ? root.childElementCount : -1,
    splash: !!g.document.getElementById('boot-splash'),
    htmlLen: body ? body.innerHTML.length : -1,
    textLen: text.length,
    text: text.split(nl).join(' / ').slice(0, 180),
    bodyBg: body ? g.getComputedStyle(body).backgroundColor : '',
    sheets: g.document.styleSheets.length
  })
}

function createWindow(): void {
  // 标题栏与应用顶栏合并成一条：隐藏系统标题栏，三个窗口按钮由系统叠画在顶栏右侧
  // （这样能保留原生按钮手感、Windows 11 的贴靠布局与无障碍支持）。
  // macOS 保持原生不动：它的红绿灯按钮在左侧，交给系统处理最省事。
  const frameOptions: BrowserWindowConstructorOptions = useTitleBarOverlay
    ? {
        titleBarStyle: 'hidden',
        titleBarOverlay: { ...titleBarOverlay(), height: OVERLAY_H }
      }
    : {}

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 880,
    minHeight: 660,
    // ★ 必须创建即显示。原来用 show:false + 等首帧再显示来防白闪，但它有个致命前提：
    //   隐藏窗口必须真的会绘制。禁用 GPU 时它不会 —— ready-to-show 永不触发，
    //   于是窗口要么永不出现（老症状），要么出现却永远空白（加兜底之后的新症状）。
    //   配合下面与主题同色的 backgroundColor，直接显示不会闪白。
    show: true,
    backgroundColor: themeBackground(),
    title: appTitle(),
    icon: appIcon(),
    ...frameOptions,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 「首帧已画好」的标记，由 ready-to-show 置位（见下面的诊断区）
  let firstPainted = false

  // 首帧看门狗：既报警，也自救。
  // Chromium 在个别环境下不给窗口下发 BeginFrame（系统判定窗口被遮挡、会话没有可见桌面等），
  // 表现就是「窗口开着却一直空白」。invalidate() 和抓一帧都会逼出一次绘制，
  // 都是无副作用的动作，能在界面真卡住时把画面拉回来。
  // 窗口尺寸抖动也能触发重绘，但最大化的窗口会被它还原，所以不用。
  const paintWatchdog = setTimeout(() => {
    if (firstPainted || !mainWindow || mainWindow.isDestroyed()) return
    diag('!! 6s 未收到首帧信号，主动请求重绘')
    try {
      mainWindow.webContents.invalidate()
    } catch (e) {
      diag(`!! invalidate 失败：${(e as Error).message}`)
    }
    void mainWindow.webContents
      .capturePage()
      .then(() => diag('已强制抓取一帧（用于触发绘制）'))
      .catch((e) => diag(`!! 强制绘制失败：${(e as Error).message}`))
  }, 6000)
  paintWatchdog.unref?.()

  // 4 秒后主动拉一次界面快照：白屏时这是唯一能拿到真相的途径。
  const snapTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    void mainWindow.webContents
      .executeJavaScript(`(${rendererSnapshot.toString()})()`)
      .then((s) => diag(`[界面快照] ${s}`))
      .catch((e) => diag(`!! 界面快照失败：${(e as Error).message}`))
  }, 4000)
  snapTimer.unref?.()

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    diag(`loadURL ${process.env['ELECTRON_RENDERER_URL']}`)
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    const indexPath = path.join(__dirname, '../renderer/index.html')
    diag(`loadFile ${indexPath} 存在=${existsSync(indexPath)}`)
    void mainWindow.loadFile(indexPath)
  }

  // 外部链接（关于面板里的 GitHub 仓库等）一律交系统浏览器打开，
  // 不允许在应用内再开 Electron 窗口 —— 否则会出一个没有我们 UI 的空白窗口。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 窗口已经可见了，这几个事件只做诊断与保险：
  //   ready-to-show   —— 「首帧已画好」的可靠信号；它不来就说明渲染层/显卡有问题
  //   did-finish-load —— 页面加载完成
  //   did-fail-load   —— 页面没加载出来（例如 asar 里资源缺失）
  mainWindow.once('ready-to-show', () => {
    firstPainted = true
    diag('首帧已绘制 <- ready-to-show')
  })
  mainWindow.webContents.once('did-finish-load', () => {
    diag('页面加载完成 <- did-finish-load')
    // 万一窗口被什么外力藏起来了（异常窗口状态、外部脚本），这里补一刀把界面亮出来
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.isVisible() &&
      !mainWindow.isMinimized()
    ) {
      mainWindow.show()
    }
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    diag(`!! did-fail-load code=${code} desc=${desc} url=${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    diag(`!! 渲染进程退出 ${JSON.stringify(details)}`)
  })
  mainWindow.webContents.on('preload-error', (_e, file, err) => {
    diag(`!! preload 报错 ${file}: ${err?.message}`)
  })
  // 渲染层的 warn / error 也收进来，界面白屏时这里是唯一线索
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) diag(`[渲染层 ${level === 3 ? 'error' : 'warn'}] ${message} (${sourceId}:${line})`)
  })
  mainWindow.on('unresponsive', () => diag('!! 窗口无响应'))
  mainWindow.on('closed', () => {
    diag('窗口已关闭')
    mainWindow = null
    // 主窗口没了，关于 / 还原窗口也一起收掉（留着会变成孤儿窗口）
    for (const w of [aboutWindow, restoreWindow]) {
      try {
        w?.close()
      } catch {
        /* 忽略 */
      }
    }
  })
}

/* ------------------------- 「关于 / 捐赠」独立窗口 -------------------------
 * 2026-10-14 用户原话：「关于这个框，如果不好做，实在不行就做成单独独立的框吧，
 * 要不然一点关于，上面就很不协调」。
 *
 * 所以「关于 / 捐赠」不再是叠在主界面上的一层遮罩，而是一个**真正独立的窗口**：
 *  · 主界面那条 62px 的合并标题栏不再被任何遮罩压住，右上角系统叠画的窗口按钮
 *    也不用跟着换色 —— 用户看到的「一点关于，上面就很不协调」从根上消失；
 *  · 窗口外观与主程序**同款合并标题栏**（hidden + titleBarOverlay，页面头部
 *    `.about-head` 就是标题栏，高 62px）—— 用户接着原话「做成一个整体的框，
 *    跟主程序一样」：原生系统标题栏那版会多出一条系统灰条，和页面头拼成两截；
 *  · 顺带修掉一个隐性毛病：原来二维码放大层是 `position: fixed`，而它的祖先
 *    `.modal-mask` 带着 `backdrop-filter` —— 带 backdrop-filter 的元素会成为
 *    固定定位的包含块，于是那层放大图实际是相对「遮罩的内边距盒子」定位的，
 *    比窗口中心低了约 26px。独立窗口里没有这层祖先，定位才是对的。
 */
let aboutWindow: BrowserWindow | null = null

/** 渲染层入口（dev 走 dev server，打包后走 asar 里的 index.html） */
function rendererEntry(): { url?: string; file: string } {
  return {
    url: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'],
    file: path.join(__dirname, '../renderer/index.html')
  }
}

function createAboutWindow(section: AboutSection): void {
  // 已经开着：直接叫到前面，再让页面自己滚到对应小节。
  // ⚠️ 不要重新 loadFile —— 同一个窗口反复加载会互相打断（ERR_FAILED），
  //    实测踩过，见 tools/ui-gallery.cjs 的注释。
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    if (aboutWindow.isMinimized()) aboutWindow.restore()
    aboutWindow.show()
    aboutWindow.focus()
    aboutWindow.webContents.send(IPC.aboutGoto, section)
    return
  }

  const w = new BrowserWindow({
    width: 780,
    height: 820,
    minWidth: 520,
    minHeight: 460,
    // 与主窗口同一条铁律：**创建即显示**。本进程禁用了 GPU，
    // 隐藏状态的窗口根本不会绘制首帧，ready-to-show 永不到来。
    show: true,
    backgroundColor: themeBackground(),
    title: `关于 · ${appTitle()}`,
    icon: appIcon(),
    // ★ 与主程序同款「合并标题栏」：隐藏系统标题栏，窗口按钮叠画在页面头部
    //   （.about-head，高 62px，与 TITLEBAR_H 一致）—— 用户原话
    //   「做成一个整体的框，跟主程序一样」。原生标题栏那版会多出一条系统灰条，
    //   跟下面的页面头拼成两截，看起来就不像一个整体。
    ...(useTitleBarOverlay
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { ...overlayColors(aboutOverlayMasked), height: OVERLAY_H }
        }
      : {}),
    // 原生标题栏没了，这行只是兜底（个别环境不支持叠层时菜单别露出来）
    autoHideMenuBar: true,
    resizable: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  aboutWindow = w

  const entry = rendererEntry()
  if (entry.url) {
    void w.loadURL(`${entry.url}#${section}`)
  } else {
    void w.loadFile(entry.file, { hash: section })
  }

  // 关于面板里的 GitHub 链接等一律交系统浏览器，不在应用内开第二个 Electron 窗口
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('did-fail-load', (_e, code, desc, url) => {
    diag(`!! 关于窗口 did-fail-load code=${code} desc=${desc} url=${url}`)
  })

  w.on('closed', () => {
    if (aboutWindow === w) aboutWindow = null
  })
}

/* --------------------------- 「U 盘还原」独立窗口 ---------------------------
 * 2026-10-14 用户原话：「点U盘还原最好还是单独弹出来一个窗口吧，把U盘还原」。
 *
 * 还原的整套流程（选盘 → 选文件系统/卷标 → 确认 → 还原 → 看日志 → 结果）
 * 全部在这个窗口里完成，主界面只剩刻录那条线 —— 首页不再被还原的一大堆
 * 选项占满，顶栏那颗「U 盘还原」按钮点了就弹窗，与「关于」完全同一套做法
 * （同一个渲染层，靠 URL hash `#restore` 分身，见 src/renderer/src/main.tsx）。
 *
 * 变量 restoreWindow 声明在文件上方（与 mainWindow 等窗口状态放在一起）。
 */
function createRestoreWindow(): void {
  // 已经开着：叫到前面就行。⚠️ 不要重新 loadFile —— 同一个窗口反复加载会互相
  // 打断（ERR_FAILED），实测踩过（见 tools/ui-gallery.cjs 的注释）。
  if (restoreWindow && !restoreWindow.isDestroyed()) {
    if (restoreWindow.isMinimized()) restoreWindow.restore()
    restoreWindow.show()
    restoreWindow.focus()
    return
  }

  const w = new BrowserWindow({
    width: 760,
    height: 780,
    minWidth: 520,
    minHeight: 560,
    // 与主窗口同一条铁律：**创建即显示**（禁 GPU 时隐藏窗口画不出首帧）
    show: true,
    backgroundColor: themeBackground(),
    title: `U 盘还原 · ${appTitle()}`,
    icon: appIcon(),
    // 与主程序 / 关于窗口同款「合并标题栏」：页面头部就是标题栏（62px）
    ...(useTitleBarOverlay
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { ...overlayColors(false), height: OVERLAY_H }
        }
      : {}),
    autoHideMenuBar: true,
    resizable: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  restoreWindow = w

  const entry = rendererEntry()
  if (entry.url) {
    void w.loadURL(`${entry.url}#restore`)
  } else {
    void w.loadFile(entry.file, { hash: 'restore' })
  }

  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('did-fail-load', (_e, code, desc, url) => {
    diag(`!! 还原窗口 did-fail-load code=${code} desc=${desc} url=${url}`)
  })

  w.on('closed', () => {
    if (restoreWindow === w) restoreWindow = null
  })
}

/**
 * 单实例锁：同一时间只允许一个窗口。
 * 没有它的话，「以管理员重启」之后新旧两个进程会同时活着，出现两个窗口。
 * 注意配套关系 —— 提权时 elevate() 会先让出这把锁，再启动新实例。
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  // 已有实例在跑（用户又双击了一次图标等）。把已有窗口叫到最前面的是主实例
  // （下面的 second-instance 事件），本进程直接退出。
  //
  // ★ 但绝不静默退出 ——「双击了、什么都没发生」是最糟糕的反馈：用户没法判断
  //   是没点开、卡住了，还是程序已经开着。2026-10-14 用户报的「双击没反应」
  //   里就有这一类。所以这里补一个说明框，讲清楚去哪儿找、怎么重开。
  // 提示框要等 app ready 才能弹，所以退出动作也推迟到那时。
  app.whenReady().then(() => {
    try {
      dialog.showMessageBoxSync({
        type: 'info',
        title: appTitle(),
        message: '番茄镜像刻录工具已经在运行了',
        detail:
          '同一时间只开一个窗口，避免两个窗口同时往一块盘上写数据。\n\n' +
          '· 请到任务栏切换回已经打开的那个窗口；\n' +
          '· 如果找不到它，先在任务管理器里结束「番茄镜像刻录工具」，再重新打开本程序。',
        buttons: ['知道了'],
        noLink: true
      })
    } catch {
      // 连提示框都弹不出来（极罕见）：也不能卡住进程
    }
    app.quit()
  })
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      createWindow()
      return
    }
    // 已有窗口则在前面亮出来，而不是再开一个
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

app.whenReady().then(async () => {
  diag(`app ready，单实例锁=${hasSingleInstanceLock}`)
  if (!hasSingleInstanceLock) {
    diag('未拿到单实例锁：已有实例在跑，本进程退出')
    return
  }

  /* -------------------- 绿色版自动提权 --------------------
   * 单文件便携版的启动器本身是普通权限（electron-builder 的 portable 目标固定如此），
   * 内层程序虽然写着 requireAdministrator，但能不能提起来取决于启动器怎么起子进程，
   * 指望不上。而本工具**要写物理磁盘**，没有管理员权限等于用不了。
   *
   * 所以绿色版自己补这一步：启动时发现没提权，就走一次 elevate()（和用户点
   * 「以管理员重启」完全同一条路）把界面以管理员身份重新拉起来，然后本进程让位。
   * 效果与安装版「双击即带管理员权限」一致。
   *
   * ★ 必须放在 createWindow() **之前**：否则会先闪出一个没有权限的窗口、
   *   再重开一个，用户看到的是闪屏。
   * ★ elevateAttempted 保证最多只跑一轮 —— 用户拒绝 UAC 也不会无限重启。
   */
  if (isPortable && !elevateAttempted) {
    const already = await isElevated()
    if (!already) {
      diag('绿色版未提权，自动走一次「以管理员重启」')
      process.env['TOMATO_ELEVATED'] = '1'
      const r = await elevate()
      diag(`自动提权结果：ok=${r.ok} ${r.message}`)
      if (r.ok) {
        // 带管理员权限的新实例已经起来了，本进程让位
        setTimeout(() => app.exit(0), 300)
        return
      }
      // 用户拒绝了 UAC：照常以普通权限打开 —— 界面上本来就有提醒和「以管理员重启」按钮
      diag('用户拒绝或系统未允许提权，改以普通权限打开')
    }
  }

  Menu.setApplicationMenu(null)
  // 系统切换浅色 / 深色时，同步窗口底色（界面配色由渲染层自己跟随）
  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(themeBackground())
    aboutWindow?.setBackgroundColor(themeBackground())
    syncTitleBarOverlay()
  })
  try {
    createWindow()
    diag('createWindow() 返回')
  } catch (e) {
    diag(`!! createWindow 抛错：${(e as Error)?.stack || String(e)}`)
    throw e
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('child-process-gone', (_e, details) => {
  diag(`子进程退出 ${JSON.stringify(details)}`)
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

/* ------------------------------- IPC ------------------------------- */

ipcMain.handle('env:get', async (): Promise<AppEnv> => {
  return {
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    elevated: await isElevated(),
    packaged: app.isPackaged
  }
})

ipcMain.handle('app:elevate', async () => {
  const r = await elevate()
  if (!r.ok) return r

  // 提权后的新实例已经启动（elevate() 内已让出单实例锁），本进程必须主动退出，
  // 否则会残留一个没有管理员权限的旧窗口。
  if (currentJob) {
    // 正在刻录：不自动退出，避免中途打断写入
    return { ok: true, message: `${r.message}；当前有刻录任务正在进行，请在本窗口手动操作` }
  }
  // 留一点时间让界面把提示显示出来
  setTimeout(() => app.exit(0), 700)
  return r
})

// 应用界面主题偏好。交给 nativeTheme 统一管理，窗口边框、原生滚动条、
// 右键菜单也会一起跟着变色。
ipcMain.handle('theme:set', async (_e, pref: ThemePref) => {
  nativeTheme.themeSource = pref === 'light' || pref === 'dark' ? pref : 'system'
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  mainWindow?.setBackgroundColor(theme === 'dark' ? BG_DARK : BG_LIGHT)
  syncTitleBarOverlay()
  return { theme }
})

// 同步通道：渲染层在 useEffect 里异步 send 调用（★ 不能用同步 IPC，见 preload 的注释）
ipcMain.on('titlebar:overlayMask', (_e, masked: boolean) => {
  overlayMasked = Boolean(masked)
  syncTitleBarOverlay()
})

// 「关于」窗口自己的浮层（二维码放大）——各按各的换色，别把主窗口一起染了
ipcMain.on('titlebar:overlayMaskAbout', (_e, masked: boolean) => {
  aboutOverlayMasked = Boolean(masked)
  syncTitleBarOverlay()
})

/**
 * 渲染层的诊断日志通道。
 * 界面里的动作（点「关于」等）和渲染层报错都从这里落到 startup.log ——
 * 万一窗口根本没显示出来，界面内的日志面板也看不到，只有磁盘上的这份是可靠的。
 */
ipcMain.on('diag:log', (_e, msg: unknown) => {
  diag(`[界面] ${String(msg).slice(0, 800)}`)
})

/**
 * USB 接口版本（USB 3.0 / 2.0 …）单独在后台补。
 *
 * 判它要沿 PnP 父设备链一层层问，每层一次 CIM 查询、约 0.7~0.9 秒 ——
 * 放进 list() 里同步做会把「刷新」卡住两三秒。所以列表先原样返回，
 * 这里算完再用 `devices:usbGen` 推给界面，那几个小标签晚一两秒出现，无感。
 */
function enrichUsbGen(devices: DeviceInfo[]): void {
  const adapter = getAdapter()
  if (!adapter.fetchUsbGen) return
  const usb = devices
    .filter((d) => /^(USB|SD|MMC|IEEE1394|Thunderbolt)$/i.test(d.busType))
    .map((d) => ({ number: Number(d.rawId), cacheKey: `${d.rawId}|${d.size}` }))
    .filter((d) => Number.isFinite(d.number))
  if (usb.length === 0) return
  void adapter
    .fetchUsbGen(usb)
    .then((rows) => {
      if (rows.length) send('devices:usbGen', rows)
    })
    .catch(() => undefined)
}

ipcMain.handle('devices:list', async () => {
  try {
    const devices = await getAdapter().list()
    void enrichUsbGen(devices)
    return { ok: true, devices }
  } catch (e) {
    return { ok: false, message: (e as Error).message, devices: [] }
  }
})

ipcMain.handle('dialog:pickImage', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  if (!win) return null
  const res = await dialog.showOpenDialog(win, {
    title: '选择镜像文件',
    properties: ['openFile'],
    filters: [
      { name: '镜像文件', extensions: ['iso', 'img', 'bin', 'raw', 'dmg', 'img.gz', 'vhd', 'vhdx'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
})

ipcMain.handle('image:stat', async (_e, p: string) => {
  try {
    return { ok: true, info: await statImage(p) }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
})

// 读取镜像内部的系统信息。纯只读解析，不触碰任何磁盘设备。
ipcMain.handle('image:probe', async (_e, p: string) => {
  try {
    return { ok: true, info: await probeImage(p) }
  } catch (e) {
    return { ok: false, message: (e as Error).message || '读取镜像信息失败' }
  }
})

/* --------------------------- 关于 / 捐赠 --------------------------- */

// 打开「关于 / 捐赠」独立窗口。section 决定停在顶部还是收款码那一节 ——
// 点「捐赠」就该直接看到码，而不是再从头滚一遍（2026-10-14 用户：「点击捐赠就不连贯」）。
ipcMain.on(IPC.aboutOpen, (_e, section: unknown) => {
  try {
    createAboutWindow(section === 'donate' ? 'donate' : 'about')
  } catch (e) {
    diag(`!! 创建关于窗口失败：${(e as Error)?.stack || String(e)}`)
  }
})

ipcMain.on(IPC.aboutClose, () => {
  try {
    aboutWindow?.close()
  } catch {
    /* 忽略 */
  }
})

/* --------------------------- U 盘还原（独立窗口） --------------------------- */

// 主界面顶栏那颗「U 盘还原」按钮：开一个独立窗口，把整套还原流程搬进去
ipcMain.on(IPC.restoreOpen, () => {
  try {
    createRestoreWindow()
  } catch (e) {
    diag(`!! 创建还原窗口失败：${(e as Error)?.stack || String(e)}`)
  }
})

ipcMain.on(IPC.restoreClose, () => {
  try {
    restoreWindow?.close()
  } catch {
    /* 忽略 */
  }
})

/* ------------------------------- 刻录 ------------------------------- */

/**
 * 把进度数字说成人话，写给运行日志面板。
 *
 * 这一步是 2026-10-14 补的：以前整段写入在日志里**完全是空白的** ——
 * 只有开头「开始写入 xxx」和结尾「写入完成」各一条，中间十几分钟一行都没有，
 * 用户盯着进度条却看不到它在干什么（原话「日志里面怎么没有写入镜像什么的日志啊」）。
 */
function progressLine(
  phase: string,
  s: { percent: number; writtenBytes: number; totalBytes: number; speed: number; etaSeconds: number }
): string {
  const verb = phase === 'verify' ? '已校验' : '已写入'
  const done = fmtSize(s.writtenBytes)
  const all = s.totalBytes > 0 ? fmtSize(s.totalBytes) : '—'
  const speed = s.speed > 0 ? ` · ${fmtSize(s.speed)}/s` : ''
  const eta = s.etaSeconds >= 0 ? ` · 剩余约 ${fmtEta(s.etaSeconds)}` : ''
  return `${verb} ${Math.floor(s.percent)}%（${done} / ${all}）${speed}${eta}`
}

function fmtEta(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

ipcMain.handle('write:start', async (e, opts: WriteOptions) => {
  if (currentJob || jobRunning) return { started: false, message: '已有任务正在进行，请等当前任务完成' }

  cancelRequested = false
  // 进度 / 日志 / 完成事件回给发起任务的那个窗口（主界面或还原窗口）
  eventTarget = e.sender
  jobRunning = true

  /* 写入 / 校验阶段的日志节流：
   *  · 每跨过 10% 记一条 —— 一条 6 GB 的镜像大约留 10 条，够看清进度又不刷屏；
   *  · 外加 60 秒心跳 —— U 盘慢、或者卡在某个百分比上不动时，
   *    也能在日志里看出「还活着 / 停在多少」，而不是一片死寂。 */
  let lastStep = -1
  let lastPhase = ''
  let lastLogAt = 0

  const job = new BurnJob({
    isCancelled: () => cancelRequested,
    onLog: (text, level) => log(text, level),
    onTick: (s) => {
      if (s.phase === 'write' && s.writtenBytes > lastWrittenBytes) lastWrittenBytes = s.writtenBytes
      send('write:progress', {
        phase: s.phase,
        percent: s.percent,
        writtenBytes: s.writtenBytes,
        totalBytes: s.totalBytes,
        speed: s.speed,
        etaSeconds: s.etaSeconds,
        message: s.phase === 'write' ? '正在写入' : '正在校验'
      } satisfies ProgressState)

      // 换阶段时把节流状态复位，免得上一阶段的 10% 挡住新阶段的第一条
      const now = Date.now()
      if (s.phase !== lastPhase) {
        lastPhase = s.phase
        lastStep = -1
        lastLogAt = now
      }
      if (s.phase !== 'write' && s.phase !== 'verify') return
      const step = Math.floor(s.percent / 10) * 10
      const crossed = step > lastStep && step >= 10
      const heartbeat = now - lastLogAt >= 60000 && s.percent > 0
      if (crossed || heartbeat) {
        if (step > lastStep) lastStep = step
        lastLogAt = now
        log(progressLine(s.phase, s), 'info')
      }
    }
  })
  currentJob = job

  void runJob(job, opts)
  return { started: true }
})

ipcMain.handle('write:cancel', async () => {
  cancelRequested = true
  currentJob?.cancel()
  return true
})

/* --------------------------- U 盘急救修复 --------------------------- */

/**
 * 深度扫描：连「此电脑 / 磁盘管理里完全看不到」的盘也找出来。
 *
 * 刻录失败后的 U 盘经常连 Get-Disk 都列不出来（未知容量 / RAW / 无盘符 /「没有媒体」），
 * 而界面上的磁盘列表正是靠 Get-Disk —— 盘都列不出来，用户就选不到它、也就修不了。
 * repair.ps1 直接扫 \\.\PhysicalDrive0..15，把这种「隐身盘」补进列表。
 */
ipcMain.handle('repair:list', async (e) => {
  // 深度扫描的日志也按调用方投递：从还原窗口扫的，别写到主窗口去
  const prevTarget = eventTarget
  eventTarget = e.sender
  try {
    const disks = await listRepairDisks({ onLog: (t, l) => log(t, l) })
    return { ok: true, disks }
  } catch (err) {
    return { ok: false, message: (err as Error).message, disks: [] }
  } finally {
    eventTarget = prevTarget
  }
})

ipcMain.handle('repair:start', async (e, opts: RepairOptions) => {
  if (jobRunning || currentJob) return { started: false, message: '已有任务正在进行，请等当前任务完成' }
  const started = Date.now()
  // 还原一定是从还原窗口发起的；把事件指回去，主界面不会跟着亮结果卡片
  eventTarget = e.sender
  jobRunning = true
  // 进度阶段：与刻录那套保持同一组 phase，界面上的步骤条才能复用
  const phaseOf = (p: number): ProgressState['phase'] =>
    p < 10 ? 'prepare' : p < 92 ? 'write' : 'verify'

  const sendProgress = (p: number): void => {
    send('write:progress', {
      phase: phaseOf(p),
      percent: p,
      writtenBytes: 0,
      totalBytes: 0,
      speed: 0,
      etaSeconds: -1,
      message: '正在还原 U 盘'
    } satisfies ProgressState)
  }
  sendProgress(0)

  try {
    const r = await runRepair(
      { diskNumber: opts.diskNumber, fileSystem: opts.fileSystem, label: opts.label },
      {
        onLog: (t, l) => log(t, l),
        onTick: (p) => sendProgress(p)
      }
    )
    const label = opts.label || '番茄U盘'

    /* 还原完的 U 盘要「名字叫番茄U盘、图标是番茄」：
     *  · 卷标用 Set-Volume 设 —— 走 Unicode，中文没问题
     *    （diskpart 的 format label= 不能用，它的脚本文件只吃 ASCII）；
     *  · 图标往盘根目录写 tomato-usb.ico + autorun.inf，「此电脑」里就是番茄 logo。 */
    if (r.ok && r.letters) {
      const vol = r.letters.split(',')[0].trim()
      if (vol) {
        try {
          await runPowerShell(
            `Set-Volume -DriveLetter ${vol} -NewFileSystemLabel '${label.replace(/'/g, "''")}' -ErrorAction Stop`
          )
          log(`卷标已设为「${label}」`, 'success')
        } catch (e) {
          log(`设置卷标失败：${(e as Error).message}`, 'warn')
        }
        const icon = appIcon()
        if (icon) {
          try {
            const root = `${vol}:\\`
            copyFileSync(icon, path.join(root, 'tomato-usb.ico'))
            writeFileSync(path.join(root, 'autorun.inf'), '[autorun]\r\nicon=tomato-usb.ico\r\n', 'ascii')
            log('已写入番茄图标与 autorun.inf ——「此电脑」里这块 U 盘就是番茄 logo', 'success')
          } catch (e) {
            log(`写图标失败：${(e as Error).message}`, 'warn')
          }
        }
      }
    }
    const letters = r.letters ? ` ${r.letters}:` : ''
    const result: WriteResult = {
      ok: r.ok,
      message: r.ok
        ? `还原完成：U 盘已恢复为 ${opts.fileSystem} 格式、卷标「${label}」，盘符${letters}可以正常使用了`
        : '还原命令已执行，但没有拿到盘符 —— 请拔下 U 盘等 10 秒重插，再打开「此电脑」按 F5 刷新',
      bytesWritten: 0,
      elapsedMs: Date.now() - started
    }
    sendProgress(100)
    send('write:done', result)
    eventTarget = null
    jobRunning = false
    return { started: true }
  } catch (e) {
    const result: WriteResult = {
      ok: false,
      message: (e as Error).message || '还原失败',
      bytesWritten: 0,
      elapsedMs: Date.now() - started
    }
    send('write:done', result)
    eventTarget = null
    jobRunning = false
    return { started: false, message: result.message }
  }
})

ipcMain.handle('device:eject', async (_e, device: DeviceInfo) => {
  try {
    await getAdapter().eject(device)
    return { ok: true, message: '已安全弹出，可以拔出设备' }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
})

ipcMain.handle('path:open', async (_e, p: string) => {
  await shell.openPath(p)
})

async function runJob(job: BurnJob, opts: WriteOptions): Promise<void> {
  const started = Date.now()
  lastWrittenBytes = 0
  const adapter = getAdapter()
  let mode: string | null = null
  let result: WriteResult = {
    ok: false,
    message: '',
    bytesWritten: 0,
    elapsedMs: 0
  }

  try {
    // 0. 系统盘 / 受保护盘一律拒绝（两种模式通用）
    if (opts.device.protected || opts.device.system) {
      throw new Error('目标设备是系统盘，已拒绝操作')
    }

    // ---------- 模式 A：非可引导 —— 把磁盘恢复成普通空盘 ----------
    //    不走 burn.ps1，也不涉及镜像，直接用 diskpart 重建分区表并格式化。
    if (opts.mode === 'format') {
      send('write:progress', {
        phase: 'prepare',
        percent: 0,
        writtenBytes: 0,
        totalBytes: 0,
        speed: 0,
        etaSeconds: -1,
        message: '正在格式化磁盘…'
      } satisfies ProgressState)
      log(`准备格式化 ${opts.device.displayName}（${opts.device.devicePath}）`, 'info')
      mode = await adapter.prepare(opts.device, true)
      await adapter.format(opts.device, opts.format, (t, l) => log(t, l))
      await adapter.finalize(opts.device, mode).catch(() => undefined)
      result.ok = true
      result.message = `已格式化为 ${opts.format.fileSystem}（${opts.format.partitionStyle}），磁盘可正常读写`
      return
    }

    // ---------- 模式 B：整盘镜像刻录 ----------
    // 1. 容量预检
    const info = await statImage(opts.imagePath)
    if (opts.device.size > 0 && info.size > opts.device.size) {
      throw new Error(`镜像（${fmtSize(info.size)}）大于目标设备容量（${fmtSize(opts.device.size)}）`)
    }
    // 第一条日志：证明日志通道是通的，后面万一「只有进度条没有日志」就能一眼看出
    // 是日志没发出去，还是压根没到这一步。
    log(
      `刻录任务开始：${info.name}（${fmtSize(info.size)}）→ ${opts.device.displayName}（${fmtSize(opts.device.size)}）`,
      'info'
    )

    // 2. 释放设备占用
    send('write:progress', {
      phase: 'prepare',
      percent: 0,
      writtenBytes: 0,
      totalBytes: info.size,
      speed: 0,
      etaSeconds: -1,
      message: '正在卸载目标设备…'
    } satisfies ProgressState)
    log(`准备设备 ${opts.device.displayName}（${opts.device.devicePath}）`, 'info')
    mode = await adapter.prepare(opts.device, opts.wipeBeforeWrite)
    if (mode === 'prepared') log('目标盘已就绪（已清除只读并确保联机）', 'success')
    else if (mode === 'offline') log('目标盘已脱机', 'success')
    else log('目标盘就绪（写入时会自动锁定并卸除卷）', 'info')

    // 3. 写入
    log(`开始写入 ${info.name}（${fmtSize(info.size)}）`, 'info')
    const { sourceSha256, bytesWritten } = await job.write(opts)
    result.bytesWritten = bytesWritten
    result.sourceSha256 = sourceSha256
    log(`写入完成，共 ${fmtSize(bytesWritten)}`, 'success')

    // 4. 让系统重新识别
    if (mode !== null) await adapter.finalize(opts.device, mode).catch(() => undefined)

    // 5. 校验
    if (opts.validate && !cancelRequested) {
      log('开始校验数据一致性…', 'info')
      const target = await job.verify(opts, sourceSha256, bytesWritten)
      result.targetSha256 = target
      log('校验通过，内容与镜像完全一致', 'success')
    }

    result.ok = true
    result.message = opts.validate ? '刻录完成，校验通过' : '刻录完成'
  } catch (e) {
    if (e instanceof CancelledError) {
      result.ok = false
      result.message = '已取消刻录'
      log('任务已取消，目标设备可能包含不完整数据', 'warn')
      if (mode !== null) await adapter.finalize(opts.device, mode).catch(() => undefined)
    } else {
      result.ok = false
      result.message = (e as Error).message || String(e)
      // 把「已经写进去多少」带出来。失败卡片上如果显示 0 B，会让人误以为盘没被动过。
      if (!result.bytesWritten) result.bytesWritten = lastWrittenBytes
      log(`失败：${result.message}`, 'error')
      if (mode !== null) await adapter.finalize(opts.device, mode).catch(() => undefined)
    }
  } finally {
    result.elapsedMs = Date.now() - started
    currentJob = null
    send('write:done', result)
    // 任务结束：事件接收方作废 + 打开闸（防止下一个任务的日志跑错窗口）
    eventTarget = null
    jobRunning = false
  }
}

function fmtSize(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}
