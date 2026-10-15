import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppEnv,
  DeviceInfo,
  FormatOptions,
  ImageProbeInfo,
  LogEntry,
  ProgressState,
  ThemePref,
  WriteMode,
  WriteResult
} from '@shared/types'
import { DEFAULT_FORMAT_OPTIONS } from '@shared/types'
import type { ImageStatResult } from '@shared/api'
import type { AboutSection } from '@shared/api'
import { APP_AUTHOR, APP_BUILD_TIME, APP_COPYRIGHT, APP_NAME, versionLabel } from '@shared/version'
import { api, formatBytes, formatDuration } from './lib'
// 界面 logo：白底的番茄徽标（已裁切成正方形）。
// ⚠️ 与 exe / 任务栏那套「蓝底系统图标」是两条互不相干的线，别去"统一"它们。
import appLogo from './assets/app-logo.png'
import ImageStep from './components/ImageStep'
import FormatPanel from './components/FormatPanel'
import DeviceStep from './components/DeviceStep'
import BurnPanel from './components/BurnPanel'
import LogPanel from './components/LogPanel'
import InternalDiskDialog from './components/InternalDiskDialog'
import Hint from './components/Hint'

type Stage = 'select' | 'burning' | 'finished'

const IDLE_PROGRESS: ProgressState = {
  phase: 'idle',
  percent: 0,
  writtenBytes: 0,
  totalBytes: 0,
  speed: 0,
  etaSeconds: -1,
  message: ''
}

/* ------------------------------ 外观（主题） ------------------------------ */

/** 与 index.html 里的防闪烁脚本共用同一个键。
    旧版用的是 'doro.theme'，改名后留一条只读回退，免得用户的主题偏好白丢一次。 */
const THEME_KEY = 'tomato.theme'
const LEGACY_THEME_KEY = 'doro.theme'

const THEME_ORDER: ThemePref[] = ['auto', 'light', 'dark']

const THEME_LABEL: Record<ThemePref, string> = {
  auto: '自动（跟随系统）',
  light: '浅色',
  dark: '深色'
}

function readStoredTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY) ?? localStorage.getItem(LEGACY_THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'auto') return v
  } catch {
    /* 忽略：隐私模式等场景下 localStorage 可能不可用 */
  }
  return 'auto'
}

function ThemeIcon({ kind }: { kind: ThemePref }) {
  if (kind === 'light') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" />
        </g>
      </svg>
    )
  }
  if (kind === 'dark') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M13.3 9.9A5.6 5.6 0 0 1 6.1 2.7a5.6 5.6 0 1 0 7.2 7.2z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect
        x="1.7"
        y="2.6"
        width="12.6"
        height="8.4"
        rx="1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M8 11v2.6M5.7 13.6h4.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/* ---------------------------------- 主界面 --------------------------------- */

export default function App() {
  const [env, setEnv] = useState<AppEnv | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [deviceError, setDeviceError] = useState<string>('')
  const [refreshing, setRefreshing] = useState(false)

  const [themePref, setThemePref] = useState<ThemePref>(readStoredTheme)

  /** 写入模式：dd = 整盘镜像刻录；format = 非可引导（格式化） */
  const [mode, setMode] = useState<WriteMode>('dd')
  /** 模式是否由识别结果自动推荐（用户手动改过就取消标记） */
  const [modeAuto, setModeAuto] = useState(false)
  /** 自动推荐的理由，展示在模式下方 */
  const [modeReason, setModeReason] = useState('')
  const [fmt, setFmt] = useState<FormatOptions>(DEFAULT_FORMAT_OPTIONS)

  const [imagePath, setImagePath] = useState<string | null>(null)
  const [imageInfo, setImageInfo] = useState<ImageStatResult['info']>()
  /** 镜像内容识别结果（镜像里的系统名/版本/架构） */
  const [probe, setProbe] = useState<ImageProbeInfo | null>(null)
  const [probing, setProbing] = useState(false)
  const probeSeq = useRef(0)
  const [selected, setSelected] = useState<DeviceInfo | null>(null)
  const [ack, setAck] = useState(false)
  /** 深度扫描补进来的「隐身盘」：系统（Get-Disk）列不出、但确实存在的盘 */
  const [hiddenDevices, setHiddenDevices] = useState<DeviceInfo[]>([])
  const [deepScanning, setDeepScanning] = useState(false)
  const [deepScanMsg, setDeepScanMsg] = useState('')
  const [validate, setValidate] = useState(true)
  const [wipe, setWipe] = useState(true)
  const [showAll, setShowAll] = useState(false)

  const [stage, setStage] = useState<Stage>('select')
  const [progress, setProgress] = useState<ProgressState>(IDLE_PROGRESS)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [result, setResult] = useState<WriteResult | null>(null)
  /** 「关于 / 捐赠」是一个**独立窗口**，主界面里不再有它的一份状态。
   *  2026-10-14 用户原话：「关于这个框……实在不行就做成单独独立的框吧，
   *  要不然一点关于，上面就很不协调」。改成独立窗口之后，主界面顶栏
   *  不再被任何遮罩压住，右上角那块系统叠画的窗口按钮也不用跟着换色。 */
  const [ejectMsg, setEjectMsg] = useState<string>('')
  const [logCollapsed, setLogCollapsed] = useState(true)
  /** 待确认的内置硬盘：点了内置盘不直接选中，先弹强提醒 */
  const [internalPending, setInternalPending] = useState<DeviceInfo | null>(null)
  /** 日志面板是否已经露过面：初始页面不显示，开始刻录之后才出现 */
  const [logShown, setLogShown] = useState(false)

  /** 打开「关于 / 捐赠」独立窗口。
   *
   *  只做一件事：通知主进程开窗口。**不往运行日志里写任何东西** ——
   *  「打开关于 / 捐赠」不是刻录操作，记进日志纯属噪音
   *  （2026-10-14 用户明确要求去掉：面板里点开看看不该留下痕迹）。
   *
   *  section='donate' 时窗口直接停在收款码那一节 —— 点「捐赠」
   *  就该看到码，而不是从最上面再滚一遍（同一轮反馈的「点击捐赠就不连贯」）。 */
  const openAbout = useCallback((section: AboutSection = 'about') => {
    try {
      api.openAbout(section)
    } catch {
      // 主进程没接上就算了，绝不影响主界面
    }
  }, [])

  const refreshDevices = useCallback(async () => {
    setRefreshing(true)
    setDeviceError('')
    try {
      const r = await api.listDevices()
      setDevices(r.devices ?? [])
      if (!r.ok) setDeviceError(r.message ?? '获取磁盘列表失败')
    } catch (e) {
      setDeviceError((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void api.getEnv().then(setEnv)
    void refreshDevices()
  }, [refreshDevices])

  /** 深度扫描的提示 5 秒后自动消失 —— 它只是一句结果通报，
   *  常驻反而会把设备列表往下顶（用户原话「5s~后自动消失」）。 */
  useEffect(() => {
    if (!deepScanMsg) return
    const t = window.setTimeout(() => setDeepScanMsg(''), 5000)
    return () => window.clearTimeout(t)
  }, [deepScanMsg])

  /**
   * 深度扫描：把「此电脑 / 磁盘管理里完全看不到」的 U 盘也找出来。
   *
   * 刻录失败后的盘经常连 Get-Disk 都列不出来（未知容量 / RAW / 无盘符 /「没有媒体」），
   * 而常规刷新走的就是 Get-Disk —— 盘都列不出来就没法选中它、也就修不了。
   * 这条走 repair.ps1，直接扫 \\.\PhysicalDrive0..15，专为这种情况准备。
   */
  const deepScan = useCallback(async () => {
    setDeepScanning(true)
    setDeepScanMsg('')
    try {
      const r = await api.listRepairDisks()
      if (!r.ok) {
        setDeepScanMsg(r.message ?? '扫描失败')
        setLogs((prev) => [
          ...prev.slice(-299),
          { level: 'error', text: `深度扫描失败：${r.message ?? '未知原因'}`, time: Date.now() }
        ])
        return
      }
      const found = (r.disks ?? []).filter((d) => !d.bad && !d.visible)
      setHiddenDevices(
        found.map((d) => ({
          id: `win:${d.number}`,
          displayName: d.name || '(系统未识别的磁盘)',
          size: d.size,
          devicePath: `\\\\.\\PhysicalDrive${d.number}`,
          rawId: String(d.number),
          mountPoints: d.letters ? d.letters.split(',').map((c) => `${c.trim()}:`) : [],
          removable: true,
          internal: false,
          system: false,
          protected: false,
          busType: d.bus || 'Unknown',
          partitionStyle: d.readable ? 'RAW' : '未知',
          readOnly: false,
          notes: `系统认不出这块盘（深度扫描发现）${d.readable ? '' : ` · 读取失败错误码 ${d.err}`}`
        }))
      )
      const txt =
        found.length > 0
          ? `深度扫描：额外发现 ${found.length} 块系统认不出的磁盘，已在下方列出`
          : '深度扫描完成：没有发现系统认不出的磁盘（常规刷新已经把能识别的都列出来了）'
      setDeepScanMsg(txt)
      setLogs((prev) => [...prev.slice(-299), { level: 'info', text: txt, time: Date.now() }])
    } catch (e) {
      setDeepScanMsg((e as Error).message)
    } finally {
      setDeepScanning(false)
    }
  }, [])

  useEffect(() => {
    const offProgress = api.onProgress(setProgress)
    const offLog = api.onLog((l) => setLogs((prev) => [...prev.slice(-299), l]))
    const offDone = api.onDone((r) => {
      setResult(r)
      setStage('finished')
    })
    // USB 接口版本（USB 3.0 / 2.0 …）是后台补查的，比列表晚一两秒到。
    // 判不出来就没有这一条，界面上只是不显示那个小标签。
    const offUsb = api.onUsbGen((rows) => {
      if (!rows || rows.length === 0) return
      setDevices((prev) =>
        prev.map((d) => {
          const hit = rows.find((r) => String(r.number) === d.rawId)
          return hit ? { ...d, usbGen: hit.usbGen } : d
        })
      )
    })
    return () => {
      offProgress()
      offLog()
      offDone()
      offUsb()
    }
  }, [])

  // 有弹窗遮罩时，让右上角那块系统绘制的窗口按钮也跟着变暗 ——
  //   「关于 / 捐赠」早已搬去独立窗口（2026-10-14），主界面里现在只剩下
  //   「内置硬盘强提醒」这一个弹层会用到它。
  //
  // ★ 这里**只能用 useEffect（绘制之后），不能用 useLayoutEffect（绘制之前）**。
  //   2026-10-13 一次真实的线上故障就从这里来：当时用的是 useLayoutEffect + 同步
  //   IPC(sendSync)，效果跑在「DOM 改完、还没上屏」之间，主进程一慢渲染进程就
  //   永远卡在那儿 —— 界面停在上一帧，点了「关于」什么都不出来，只有窗口按钮
  //   换成了遮罩灰（用户截图里右上角那条 #9699a2 就是它）。
  //   现在两道保险：① 调用挪到绘制之后；② 走异步 send，不等待应答。
  //   代价只是窗口按钮晚一帧换色（≈16ms），肉眼不可见。
  useEffect(() => {
    try {
      api.setOverlayMasked(internalPending !== null)
    } catch (e) {
      setLogs((prev) => [
        ...prev.slice(-299),
        { level: 'warn', text: `窗口按钮换色失败（不影响使用）：${(e as Error).message}`, time: Date.now() }
      ])
      api.diagLog?.(`setOverlayMasked 抛错：${(e as Error).message}`)
    }
  }, [internalPending])

  /**
   * 滚动条「不动时隐藏」：任何滚动容器一开始滚动就挂上 .is-scrolling，
   * 停手约 0.9 秒后摘掉，滑块随之淡出（样式见 styles.css 的滚动条一节）。
   * 用 document 捕获阶段监听，这样主内容区和日志框都能一并生效。
   */
  useEffect(() => {
    const timers = new WeakMap<Element, number>()
    const onScroll = (e: Event): void => {
      const el = e.target
      if (!(el instanceof HTMLElement)) return
      el.classList.add('is-scrolling')
      const prev = timers.get(el)
      if (prev) window.clearTimeout(prev)
      timers.set(
        el,
        window.setTimeout(() => el.classList.remove('is-scrolling'), 900)
      )
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, { capture: true })
  }, [])

  /**
   * 主题：data-theme 决定配色，「自动」时由系统设置决定。
   * 同时把偏好交给主进程，让窗口边框、原生滚动条、右键菜单一起跟着变。
   */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark =
        themePref === 'dark' || (themePref === 'auto' && mq.matches)
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    }
    apply()
    mq.addEventListener('change', apply)
    void api.setTheme(themePref).catch(() => undefined)
    return () => mq.removeEventListener('change', apply)
  }, [themePref])

  const changeTheme = useCallback((p: ThemePref) => {
    setThemePref(p)
    try {
      localStorage.setItem(THEME_KEY, p)
    } catch {
      /* 忽略 */
    }
  }, [])

  /** 常规列表 + 深度扫描补进来的隐身盘（按磁盘号去重，常规列表优先） */
  const allDevices = useMemo(
    () => [...devices, ...hiddenDevices.filter((h) => !devices.some((d) => d.rawId === h.rawId))],
    [devices, hiddenDevices]
  )

  const visibleDevices = useMemo(() => {
    return allDevices.filter((d) => showAll || !d.internal || d.removable)
  }, [allDevices, showAll])

  const pickImage = useCallback(async () => {
    const p = await api.pickImage()
    if (!p) return
    const r = await api.statImage(p)
    if (!r.ok || !r.info) {
      setLogs((prev) => [...prev, { level: 'error', text: r.message ?? '无法读取镜像', time: Date.now() }])
      return
    }
    setImagePath(p)
    setImageInfo(r.info)
    setAck(false)

    // 选好镜像后立刻解析镜像内部的系统信息（只读，不会碰任何磁盘）
    setProbe(null)
    setProbing(true)
    const seq = ++probeSeq.current
    try {
      const pr = await api.probeImage(p)
      if (seq !== probeSeq.current) return
      if (pr.ok && pr.info) {
        const info = pr.info
        setProbe(info)
        const extra = [
          info.version ? `版本 ${info.version}` : '',
          info.arch,
          info.bootable ? `可引导（${info.bootModes.join(' / ')}）` : '不含引导信息'
        ]
          .filter(Boolean)
          .join(' · ')
        setLogs((prev) => [
          ...prev,
          {
            level: info.bootable ? 'success' : 'warn',
            text: `镜像识别：${info.osName}${extra ? ` — ${extra}` : ''}`,
            time: Date.now()
          }
        ])

        // 按识别结果自动选择写入方式：含引导信息 → 整盘刻录；不含 → 非可引导
        const rec: WriteMode = info.bootable ? 'dd' : 'format'
        setMode(rec)
        setModeAuto(true)
        setModeReason(
          info.bootable
            ? `镜像含引导信息（${info.bootModes.join(' / ') || 'El Torito'}），已自动选择「整盘镜像刻录」`
            : '镜像未检测到引导信息，已自动选择「非可引导（格式化）」；此模式不会写入镜像内容，需要时可在下面手动改回整盘刻录'
        )
        setLogs((prev) => [
          ...prev,
          {
            level: info.bootable ? 'info' : 'warn',
            text: info.bootable
              ? '已根据识别结果自动选择写入方式：整盘镜像刻录'
              : '镜像不含引导信息，已自动切换为：非可引导（格式化）',
            time: Date.now()
          }
        ])
      } else {
        setModeAuto(false)
        setModeReason('')
        setLogs((prev) => [
          ...prev,
          { level: 'warn', text: `镜像信息读取失败：${pr.message ?? '未知原因'}`, time: Date.now() }
        ])
      }
    } finally {
      if (seq === probeSeq.current) setProbing(false)
    }
  }, [])

  /** 手动切换写入方式：一旦动过就不再被识别结果覆盖。 */
  const changeMode = useCallback((m: WriteMode) => {
    setMode(m)
    setModeAuto(false)
    setModeReason('')
    setAck(false)
  }, [])

  const start = useCallback(async () => {
    if (!selected) return
    if (mode === 'dd' && !imagePath) return
    setLogs([])
    // 开始刻录这一刻日志才登场 —— 用户这时候正想看它在干什么。
    // 但**默认收起**（用户 2026-10-14：「默认也是收起来的状态」），
    // 想看展开点一下标题栏就行，不占首页地方。
    setLogShown(true)
    setLogCollapsed(true)
    setResult(null)
    setEjectMsg('')
    setProgress(IDLE_PROGRESS)
    setStage('burning')
    const r = await api.startWrite({
      mode,
      imagePath: mode === 'dd' ? (imagePath ?? '') : '',
      device: selected,
      validate: mode === 'dd' ? validate : false,
      wipeBeforeWrite: mode === 'dd' ? wipe : true,
      format: fmt
    })
    if (!r.started) {
      setStage('select')
      setLogs((prev) => [...prev, { level: 'error', text: r.message ?? '无法启动任务', time: Date.now() }])
    }
  }, [mode, imagePath, selected, validate, wipe, fmt])

  const cancel = useCallback(async () => {
    await api.cancelWrite()
  }, [])

  const eject = useCallback(async () => {
    if (!selected) return
    const r = await api.eject(selected)
    setEjectMsg(r.message)
    if (r.ok) void refreshDevices()
  }, [selected, refreshDevices])

  const reset = useCallback(() => {
    setStage('select')
    setResult(null)
    setProgress(IDLE_PROGRESS)
    setAck(false)
    setEjectMsg('')
    // 回到首页就把日志收起来 —— 用户 2026-10-14：「首页也不需要显示运行日志」
    setLogs([])
    setLogShown(false)
    setLogCollapsed(true)
  }, [])

  const canStart =
    !!selected &&
    ack &&
    !selected.protected &&
    !selected.system &&
    stage === 'select' &&
    (mode !== 'dd' || !!imagePath)

  const busy = stage === 'burning'

  /** 失败时把多行错误拆成「标题 + 详细原因」，避免长文本挤成一坨看不清 */
  const failLines = useMemo(
    () =>
      result && !result.ok
        ? result.message
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    [result]
  )

  /** 非可引导模式下又没选镜像时，第 1 步显示提示而不是选择框 */
  const skipImage = mode === 'format' && !imagePath

  /**
   * 日志面板：**只有刻录 / 还原过程中与结果页才出现**，首页一律不显示
   * （用户 2026-10-14：「首页也不需要显示运行日志，只有刻录写入和还原优盘的时候有」）。
   * 出现时默认收起，点标题栏才展开。
   */
  const showLog = logShown

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="logo" src={appLogo} alt="番茄" draggable={false} />
          <div>
            <div className="brand-name">{APP_NAME}</div>
            {/* 副标题要短：窗口窄到 880 时（最窄）这句会被省略号截断。
                2026-10-13 用户决定先不做 macOS，文案一律按 Windows 单平台写，
                界面里不再出现「跨平台 / Windows / macOS」这类双平台字样；
                2026-10-14 用户要求把这里改成「工具介绍」，并点明开源。 */}
            <div className="brand-sub">开源免费 · 本地离线 · 把镜像写入 U 盘</div>
          </div>
        </div>
        <div className="topbar-right">
          {env && (
            <span className={`chip ${env.elevated ? 'chip-ok' : 'chip-warn'}`}>
              {env.elevated ? '已获取管理员权限' : '未获取管理员权限'}
            </span>
          )}
          {env && !env.elevated && (
            <button
              className="btn ghost small"
              onClick={async () => {
                const r = await api.elevate()
                setLogs((prev) => [
                  ...prev,
                  { level: r.ok ? 'success' : 'warn', text: r.message, time: Date.now() }
                ])
                // 提权成功时由主进程关闭本窗口（带管理员权限的新窗口会自己起来），
                // 这里不要再调用 window.close()，否则两个退出流程会互相打架
              }}
            >
              以管理员重启
            </button>
          )}

          {/* U 盘还原：顶栏的小按钮。点了**另开一个独立窗口**，把整套还原流程
              搬进去（2026-10-14 用户原话：「点U盘还原最好还是单独弹出来一个窗口吧，
              把U盘还原」）—— 与「关于」完全同一套做法，主界面只剩刻录这条线。 */}
          <button
            type="button"
            className="btn ghost small about-btn repair-btn"
            onClick={() => {
              try {
                api.openRestore()
              } catch {
                // 主进程没接上就算了，绝不影响主界面
              }
            }}
            title="U 盘打不开 / 容量显示不对 / 提示需要格式化？点它打开「U 盘还原」窗口"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
            U 盘还原
            {/* ？号悬停提示：只说这是干什么的、点了会怎样。
                2026-10-14 用户要求不把一、二、三、四步摆成「U 盘还原的状态」，
                「只需要在提示里面说将u盘还原到初始空U盘可正常使用状态这种描述就可以」。
                内层 span 拦掉点击冒泡，免得点「？」本身把窗口开了。 */}
            <span onClick={(e) => e.stopPropagation()} role="presentation">
              <Hint text="U 盘打不开 / 容量显示异常 / 提示「需要格式化」/ 没有盘符？点它打开「U 盘还原」窗口：将 U 盘还原到初始空 U 盘、可正常使用的状态。还原会清空盘上全部数据，请先备份。" />
            </span>
          </button>

          {/* 关于：点它会在主界面之外**另开一个独立窗口**。
              这里刻意不再给它一个「框」（原来的圆角 + 底色 + 描边），
              改成和右边主题切换器同一套朴素文字按钮 —— 右上角那排东西
              就能保持同一种语言，不再像是拼上去的第二块控件
              （2026-10-14 用户：「右上角还是有点不协调」）。 */}
          <button
            type="button"
            className="btn ghost small about-btn"
            onClick={() => openAbout('about')}
            title="关于本工具 · 完全免费"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M12 21s-7.5-4.6-9.3-9A5.6 5.6 0 0 1 12 6.3 5.6 5.6 0 0 1 21.3 12C19.5 16.4 12 21 12 21Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinejoin="round"
              />
            </svg>
            关于
          </button>

          {/* 外观：自动 / 浅色 / 深色 */}
          <div className="theme-seg" role="group" aria-label="外观模式">
            {THEME_ORDER.map((k) => (
              <button
                key={k}
                type="button"
                className={`theme-btn ${themePref === k ? 'on' : ''}`}
                title={THEME_LABEL[k]}
                aria-label={THEME_LABEL[k]}
                aria-pressed={themePref === k}
                onClick={() => changeTheme(k)}
              >
                <ThemeIcon kind={k} />
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* 滚动条放在这一层（整窗宽），内容再在里面居中 */}
      <div className="content-scroll">
        <main className="content">
        {!env?.elevated && (
          <div className="banner warn">
            刻录需要管理员权限。请右键「以管理员身份运行」，或点击右上角按钮。
          </div>
        )}
        {deviceError && <div className="banner error">{deviceError}</div>}

        {stage === 'burning' ? (
          <BurnPanel
            progress={progress}
            imageName={imageInfo?.name ?? imagePath ?? ''}
            deviceName={selected?.displayName ?? ''}
            onCancel={cancel}
            kind="burn"
          />
        ) : stage === 'finished' && result ? (
          <section className={`card result ${result.ok ? 'ok' : 'bad'}`}>
            <div className="result-icon">{result.ok ? '✓' : '✕'}</div>
            <h2>{result.ok ? result.message : failLines[0] || '操作失败'}</h2>
            {!result.ok && failLines.length > 1 && (
              <div className="result-error">{failLines.slice(1).join('\n')}</div>
            )}
            {!result.ok && (
              <p className="hint">
                目标盘本次【没有被改动】或只写入了一部分。若提示「卷无法锁定」，请关闭「此电脑」窗口、杀毒软件、
                磁盘管理和分区工具后重试；若提示写入 I/O 错误，请更换 U 盘或换一个 USB 接口。
              </p>
            )}
            <div className="result-meta">
              <span>耗时 {formatDuration(result.elapsedMs)}</span>
              {result.bytesWritten > 0 && <span>写入 {formatBytes(result.bytesWritten)}</span>}
              <span>{selected?.displayName}</span>
            </div>
            {result.sourceSha256 && (
              <div className="hash">
                <div>
                  <span className="hash-label">镜像 SHA256</span>
                  <code>{result.sourceSha256}</code>
                </div>
                {result.targetSha256 && (
                  <div>
                    <span className="hash-label">设备 SHA256</span>
                    <code>{result.targetSha256}</code>
                  </div>
                )}
              </div>
            )}
            <div className="result-actions">
              <button className="btn" onClick={reset}>
                再来一次
              </button>
              {selected && (
                <button className="btn ghost" onClick={eject}>
                  安全弹出
                </button>
              )}
            </div>
            {ejectMsg && <div className="hint block">{ejectMsg}</div>}
          </section>
        ) : (
          <>
            {/* ---------- 1. 选择镜像 + 写入方式（同一张卡） ---------- */}
            {/* 顺序刻意保持「先镜像、后写入方式」：识别结果要压在模式上方，
                才能先看清这是什么系统的镜像，再决定怎么写到 U 盘 */}
            <section className="card">
              <header className="card-head">
                <span className="step-badge">1</span>
                <div>
                  <h2>选择镜像与写入方式</h2>
                  <p className="sub">
                    选好镜像后自动读出里面的系统与版本，并据此推荐下面的写入方式
                  </p>
                </div>
              </header>

              {skipImage ? (
                <p className="mode-note">
                  当前为「非可引导」模式，不需要镜像文件 —— 会在下方直接格式化磁盘。想识别并写入某个镜像时，把下面的模式改回「整盘镜像刻录」即可选择文件。
                </p>
              ) : (
                <ImageStep
                  imagePath={imagePath}
                  info={imageInfo}
                  probe={probe}
                  probing={probing}
                  onPick={pickImage}
                  disabled={busy}
                />
              )}

              <div className="block-divider" />

              <div className="block-title">
                <span>写入方式</span>
                <span className="block-hint">
                  整盘镜像刻录，或把磁盘格式化成普通空盘
                </span>
              </div>

              <div className="form-row">
                <label className="form-label" htmlFor="mode-select">
                  模式
                  {/* 长解释收进「?」里：默认不占地方，鼠标移上去 / Tab 聚焦才弹出。
                      文案跟着当前模式走 —— 看 DD 的时候不用读格式化那段。 */}
                  <Hint
                    text={
                      mode === 'dd'
                        ? '镜像会从磁盘第 0 字节起原样写入，镜像自带的分区表将覆盖目标盘原有分区表（与 Rufus 的 DD 模式一致）。写完后 Windows 可能提示「需要格式化」，属正常现象。'
                        : '非可引导模式不写入任何镜像内容：会把目标盘的全部分区删掉，重新格式化成一块普通空盘。'
                    }
                  />
                </label>
                <select
                  id="mode-select"
                  className="control"
                  value={mode}
                  disabled={busy}
                  onChange={(e) => changeMode(e.target.value as WriteMode)}
                >
                  <option value="dd">整盘镜像刻录（把镜像原样写入磁盘）</option>
                  <option value="format">非可引导（把磁盘格式化成普通空盘）</option>
                </select>
              </div>

              {/* （「U 盘还原」已搬去顶栏按钮点开的独立窗口 —— 用户 2026-10-14：
                  「点U盘还原最好还是单独弹出来一个窗口吧，把U盘还原」） */}
              {modeAuto && modeReason && (
                <div className="mode-auto">
                  <span className="mode-auto-tag">自动</span>
                  <span>{modeReason}</span>
                </div>
              )}

              {mode === 'format' && (
                <>
                  <FormatPanel value={fmt} onChange={setFmt} disabled={busy} />
                  {imagePath && (
                    <p className="mode-note">
                      当前为「非可引导」模式，已选的 {imageInfo?.name ?? '镜像'} 不会被写入。若想把镜像里的内容放进
                      U 盘，请把模式改回「整盘镜像刻录」。
                    </p>
                  )}
                </>
              )}
            </section>

            {/* ---------- 2. 目标磁盘 ---------- */}
            <DeviceStep
              devices={visibleDevices}
              selectedId={selected?.id ?? null}
              onSelect={(d) => {
                // 内置硬盘（非可移动）：先弹强提醒 + 二次确认，确认后才真正选中
                if (d.internal && !d.removable) {
                  setInternalPending(d)
                  return
                }
                setSelected(d)
                setAck(false)
              }}
              onRefresh={refreshDevices}
              busy={refreshing}
              showAll={showAll}
              onToggleShowAll={setShowAll}
              onDeepScan={deepScan}
              deepScanning={deepScanning}
              deepScanMsg={deepScanMsg}
              imageSize={mode === 'dd' ? (imageInfo?.size ?? 0) : 0}
              disabled={busy}
            />

            {/* ---------- 3. 确认并开始 ---------- */}
            <section className="card">
              <header className="card-head">
                <span className="step-badge">3</span>
                <div>
                  <h2>确认并开始</h2>
                  <p className="sub">
                    {mode === 'dd' ? '刻录会整盘覆盖，操作不可撤销' : '格式化会清空全部分区，操作不可撤销'}
                  </p>
                </div>
              </header>

              {selected && (
                <div className="banner danger">
                  <strong>{selected.displayName}</strong>（{formatBytes(selected.size)}，
                  {selected.mountPoints.length ? selected.mountPoints.join(' ') : '无盘符'}）上的所有数据将被永久删除。
                </div>
              )}

              <div className="options">
                {mode === 'dd' ? (
                  <>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={validate}
                        onChange={(e) => setValidate(e.target.checked)}
                        disabled={busy}
                      />
                      <span>写入后校验数据一致性（推荐）</span>
                    </label>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={wipe}
                        onChange={(e) => setWipe(e.target.checked)}
                        disabled={busy}
                      />
                      <span>允许覆盖目标盘旧分区表（推荐）</span>
                    </label>
                    <p className="hint">
                      写入整盘镜像时，镜像自带的分区表会覆盖目标盘原有分区表。程序会先确认目标盘可写、并锁定卸除其上的卷，
                      确认成功后才开始写入 —— 失败时不会改动目标盘。
                    </p>
                  </>
                ) : (
                  <p className="hint">
                    将删除目标盘的全部分区并重新格式化，原有数据不可恢复。此模式不写入任何镜像，
                    完成后磁盘可立即在「此电脑」中正常读写。
                  </p>
                )}
                <label className="switch danger">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                    disabled={busy || !selected}
                  />
                  <span>我已确认目标磁盘选择无误，且已备份重要数据</span>
                </label>
              </div>

              <button
                className="btn primary block"
                disabled={!canStart}
                onClick={start}
              >
                {mode === 'dd' && !imagePath
                  ? '请先选择镜像文件'
                  : !selected
                    ? '请选择目标磁盘'
                    : !ack
                      ? '请勾选确认后开始'
                      : mode === 'dd'
                        ? '开始刻录'
                        : '开始格式化'}
              </button>
            </section>
          </>
        )}

        {showLog && (
          <LogPanel
            logs={logs}
            collapsed={logCollapsed}
            onToggle={() => setLogCollapsed((v) => !v)}
          />
        )}
        </main>
      </div>

      <footer className="footer">
        <span className="footer-brand">
          {APP_NAME} <b>{versionLabel()}</b>
        </span>
        <span className="footer-sep">·</span>
        <span>
          由 <b>{APP_AUTHOR}</b> 开发
        </span>
        <span className="footer-sep">·</span>
        <span>构建于 {APP_BUILD_TIME}</span>
        <span className="footer-sep">·</span>
        <span className="footer-copy">{APP_COPYRIGHT}</span>
        <span className="footer-sep">·</span>
        {/* 「关于」和「捐赠」拆成两个入口：点哪个就停在哪个小节 ——
            点「捐赠」直接看到收款码，不用再从最上面滚一遍
            （2026-10-14 用户：「点击捐赠就不连贯」） */}
        <span className="footer-free">
          <span className="footer-heart">♥</span> 完全免费
        </span>
        <span className="footer-sep">·</span>
        <button type="button" className="footer-link" onClick={() => openAbout('about')}>
          关于
        </button>
        <span className="footer-sep">·</span>
        <button type="button" className="footer-link" onClick={() => openAbout('donate')}>
          捐赠
        </button>
      </footer>

      {/* 内置硬盘强提醒 */}
      <InternalDiskDialog
        device={internalPending}
        onCancel={() => setInternalPending(null)}
        onConfirm={(d) => {
          setInternalPending(null)
          setSelected(d)
          setAck(false)
          setLogs((prev) => [
            ...prev,
            {
              level: 'warn',
              text: `目标磁盘为内置硬盘：${d.displayName}（${d.devicePath}）—— 已通过二次确认`,
              time: Date.now()
            }
          ])
        }}
      />
    </div>
  )
}
