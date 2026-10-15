import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppEnv,
  DeviceInfo,
  FormatOptions,
  LogEntry,
  ProgressState,
  WriteResult
} from '@shared/types'
import { APP_BUILD_TIME, APP_NAME, versionLabel } from '@shared/version'
import { api, formatBytes, formatDuration } from '../lib'
// 界面 logo：白底的番茄徽标（与主界面同一张，别去"统一"成系统图标那套）
import appLogo from '../assets/app-logo.png'
import FormatPanel from './FormatPanel'
import BurnPanel from './BurnPanel'
import LogPanel from './LogPanel'
import Hint from './Hint'

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

/**
 * 还原窗口的默认格式：NTFS + 卷标「番茄U盘」。
 *
 * 2026-10-14 用户原话：「u盘还原后，名称改成番茄U盘，logo改成番茄」——
 * 卷标就是「此电脑」里显示的名字，图标由主进程在还原完成后写进盘根目录
 * （tomato-usb.ico + autorun.inf，见 src/main/index.ts 的 repair:start）。
 * NTFS 是用户要的「修完能用的」文件系统：支持大文件、有日志、权限可控。
 */
const DEFAULT_RESTORE_FMT: FormatOptions = {
  partitionStyle: 'MBR',
  fileSystem: 'NTFS',
  label: '番茄U盘',
  quick: true
}

/**
 * 「?」悬停提示的文案。
 *
 * 2026-10-14 用户明确要求：不要把一、二、三、四步摆成「U 盘还原的状态」，
 * 「只需要在提示里面说将u盘还原到初始空U盘可正常使用状态这种描述就可以」。
 * 所以这里只有一句定位描述 + 一条数据无价的警告，不列步骤。
 */
const RESTORE_HINT =
  'U 盘打不开 / 容量显示异常 / 提示「需要格式化」/ 没有盘符？用它来救：将 U 盘还原到初始空 U 盘、可正常使用的状态。还原会清空这块盘上的全部数据，操作前请确认没有要保留的文件。'

/**
 * 「U 盘还原」——**一个独立的窗口**，与「关于 / 捐赠」同一套做法。
 *
 * 2026-10-14 用户原话：「点U盘还原最好还是单独弹出来一个窗口吧，把U盘还原」。
 * 整套还原流程（选盘 → 选格式 → 确认 → 还原 → 看日志 → 结果）都在这个窗口里，
 * 主界面只剩刻录那条线，首页不再被还原的一大堆选项占满。
 *
 * 与主界面共用一份渲染层代码，靠 URL hash `#restore` 分身（见 main.tsx）；
 * 主题由 index.html 里的防闪烁脚本提前定好，这里不用再管。
 */
export default function RestoreWindow() {
  const [env, setEnv] = useState<AppEnv | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [deviceError, setDeviceError] = useState<string>('')
  const [refreshing, setRefreshing] = useState(false)
  /** 深度扫描补进来的「隐身盘」：系统（Get-Disk）列不出、但确实存在的盘 */
  const [hiddenDevices, setHiddenDevices] = useState<DeviceInfo[]>([])
  const [deepScanning, setDeepScanning] = useState(false)
  const [deepScanMsg, setDeepScanMsg] = useState('')
  /** 默认只列 U 盘 / 移动硬盘；内置硬盘、系统盘一律不还原 */
  const [showAll, setShowAll] = useState(false)
  const [selected, setSelected] = useState<DeviceInfo | null>(null)
  const [ack, setAck] = useState(false)
  const [fmt, setFmt] = useState<FormatOptions>(DEFAULT_RESTORE_FMT)

  const [stage, setStage] = useState<Stage>('select')
  const [progress, setProgress] = useState<ProgressState>(IDLE_PROGRESS)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [result, setResult] = useState<WriteResult | null>(null)
  /** 选择阶段的错误横幅（启动失败 / 提权失败等），不往日志里塞 */
  const [notice, setNotice] = useState('')
  /** 日志默认收起 —— 用户 2026-10-14：「默认也是收起来的状态」 */
  const [logCollapsed, setLogCollapsed] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  /** 关闭 = 关掉这个窗口，回到主界面 */
  const closeWin = useCallback(() => {
    try {
      api.closeRestore()
    } catch {
      // 主进程没接上（例如单独用浏览器打开这个页面）：什么都不做即可
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

  /**
   * 深度扫描：把「此电脑 / 磁盘管理里完全看不到」的 U 盘也找出来。
   *
   * 刻录失败变砖的盘经常连 Get-Disk 都列不出来，而常规刷新走的就是 Get-Disk ——
   * 盘都列不出来就没法选中它、也就还原不了。这条直接扫 \\.\PhysicalDrive0..15。
   */
  const deepScan = useCallback(async () => {
    setDeepScanning(true)
    setDeepScanMsg('')
    try {
      const r = await api.listRepairDisks()
      if (!r.ok) {
        setDeepScanMsg(r.message ?? '扫描失败')
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
      setDeepScanMsg(
        found.length > 0
          ? `深度扫描：额外发现 ${found.length} 块系统认不出的磁盘，已在下方列出`
          : '深度扫描完成：没有发现系统认不出的磁盘（常规刷新已经把能识别的都列出来了）'
      )
    } catch (e) {
      setDeepScanMsg((e as Error).message)
    } finally {
      setDeepScanning(false)
    }
  }, [])

  useEffect(() => {
    void api.getEnv().then(setEnv)
    void refreshDevices()
  }, [refreshDevices])

  // 深度扫描的提示 5 秒后自动消失（与主界面同一行为）
  useEffect(() => {
    if (!deepScanMsg) return
    const t = window.setTimeout(() => setDeepScanMsg(''), 5000)
    return () => window.clearTimeout(t)
  }, [deepScanMsg])

  // 任务事件：还原一定从这个窗口发起，主进程会把进度 / 日志 / 完成都指回来
  useEffect(() => {
    const offProgress = api.onProgress(setProgress)
    const offLog = api.onLog((l) => setLogs((prev) => [...prev.slice(-299), l]))
    const offDone = api.onDone((r) => {
      setResult(r)
      setStage('finished')
    })
    return () => {
      offProgress()
      offLog()
      offDone()
    }
  }, [])

  // 进入还原中 / 结果页时把内容区滚回顶部 —— 用户刚才是滚到底部点的「开始还原」
  useEffect(() => {
    if (stage !== 'select') bodyRef.current?.scrollTo({ top: 0 })
  }, [stage])

  // ESC 关窗口；但还原进行中不许关 —— 关了就看不着进度了（任务还在主进程跑）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (stage === 'burning') return
      closeWin()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [stage, closeWin])

  /** 常规列表 + 深度扫描补进来的隐身盘（按磁盘号去重，常规列表优先） */
  const allDevices = useMemo(
    () => [...devices, ...hiddenDevices.filter((h) => !devices.some((d) => d.rawId === h.rawId))],
    [devices, hiddenDevices]
  )

  /** 默认只列能还原的盘；勾了「显示全部磁盘」才把内置/系统盘摆出来（且不可选） */
  const listDevices = useMemo(
    () =>
      showAll
        ? allDevices
        : allDevices.filter((d) => !d.internal && !d.system && !d.protected && !d.readOnly),
    [allDevices, showAll]
  )

  const startRepair = useCallback(async () => {
    if (!selected) return
    const n = Number(selected.rawId)
    if (!Number.isFinite(n)) {
      setNotice(`无法识别磁盘号（${selected.rawId}），请重新选择目标磁盘`)
      return
    }
    setNotice('')
    setLogs([])
    setResult(null)
    setProgress(IDLE_PROGRESS)
    setStage('burning')
    const r = await api.startRepair({
      diskNumber: n,
      fileSystem: fmt.fileSystem,
      label: fmt.label
    })
    if (!r.started) {
      setStage('select')
      setNotice(r.message ?? '无法启动还原')
    }
  }, [selected, fmt])

  const reset = useCallback(() => {
    setStage('select')
    setResult(null)
    setProgress(IDLE_PROGRESS)
    setAck(false)
    setLogs([])
    setNotice('')
  }, [])

  const canStart = !!selected && ack && stage === 'select'

  /** 失败时把多行错误拆成「标题 + 详细原因」 */
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

  return (
    <div className="restore restore-win">
      {/* 这一整条就是「合并标题栏」：系统把窗口按钮叠画在它右侧，
          整条可拖动（双击 = 最大化/还原），与主界面顶栏同一套做法 */}
      <header className="restore-head">
        <img className="restore-logo" src={appLogo} alt="" draggable={false} />
        <div className="restore-title">
          <div className="restore-name">
            U 盘还原
            {/* ？号悬停提示：只说这是干什么的（一句定位描述），不列步骤。
                内层 span 拦掉点击冒泡，免得点「？」顺带触发拖动区。 */}
            <span onClick={(e) => e.stopPropagation()} role="presentation">
              <Hint text={RESTORE_HINT} />
            </span>
          </div>
          <div className="restore-sub">将 U 盘还原到初始空 U 盘、可正常使用的状态</div>
        </div>
      </header>

      <div className="restore-body" ref={bodyRef}>
        {!env?.elevated && (
          <div className="banner warn">
            <span>还原需要管理员权限。请右键「以管理员身份运行」，或</span>
            <button
              className="btn ghost small"
              onClick={async () => {
                const r = await api.elevate()
                if (!r.ok) setNotice(r.message)
                // 提权成功时由主进程关闭本窗口（带管理员权限的新窗口会自己起来）
              }}
            >
              以管理员重启
            </button>
          </div>
        )}
        {deviceError && <div className="banner error">{deviceError}</div>}
        {notice && <div className="banner error">{notice}</div>}

        {stage === 'burning' ? (
          <>
            <BurnPanel
              progress={progress}
              imageName=""
              deviceName={selected?.displayName ?? ''}
              onCancel={() => undefined}
              kind="repair"
            />
            {/* 日志：只有还原过程中与结果页才出现，且默认收起 */}
            <LogPanel
              logs={logs}
              collapsed={logCollapsed}
              onToggle={() => setLogCollapsed((v) => !v)}
            />
          </>
        ) : stage === 'finished' && result ? (
          <>
            <section className={`card result ${result.ok ? 'ok' : 'bad'}`}>
              <div className="result-icon">{result.ok ? '✓' : '✕'}</div>
              <h2>{result.ok ? result.message : failLines[0] || '还原失败'}</h2>
              {!result.ok && failLines.length > 1 && (
                <div className="result-error">{failLines.slice(1).join('\n')}</div>
              )}
              {result.ok && (
                <p className="hint">
                  这块盘在「此电脑」里现在叫<b>「{fmt.label || '番茄U盘'}」</b>
                  ，图标是番茄；名称或图标要过几秒 / 刷新一下才更新。
                </p>
              )}
              {!result.ok && (
                <p className="hint">
                  目标盘本次【没有被改动】或只处理了一部分。若提示「卷无法锁定」，请关闭「此电脑」窗口、
                  杀毒软件、磁盘管理和分区工具后重试；若提示 I/O 错误，请更换 U 盘或换一个 USB 接口。
                </p>
              )}
              <div className="result-meta">
                <span>耗时 {formatDuration(result.elapsedMs)}</span>
                <span>{selected?.displayName}</span>
              </div>
              <div className="result-actions">
                {/* 「完成」= 关掉这个窗口，回到主界面（首页） */}
                <button className="btn" onClick={closeWin}>
                  完成
                </button>
                {/* 「再试一次」= 不关窗口，重新选一块盘再来一遍 */}
                <button className="btn ghost" onClick={reset}>
                  再试一次
                </button>
              </div>
            </section>
            <LogPanel
              logs={logs}
              collapsed={logCollapsed}
              onToggle={() => setLogCollapsed((v) => !v)}
            />
          </>
        ) : (
          <>
            {/* ---------- 1. 选择要还原的磁盘 ---------- */}
            <section className="card">
              <header className="card-head">
                <span className="step-badge">1</span>
                <div>
                  <h2>选择要还原的 U 盘</h2>
                  <p className="sub">只针对 U 盘 / 移动硬盘，内置硬盘与系统盘不能还原</p>
                </div>
                <div className="head-actions">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={showAll}
                      onChange={(e) => setShowAll(e.target.checked)}
                    />
                    <span>显示全部磁盘</span>
                  </label>
                  <button className="btn ghost small" onClick={refreshDevices} disabled={refreshing}>
                    {refreshing ? '刷新中…' : '刷新'}
                  </button>
                  <button
                    className="btn ghost small"
                    onClick={deepScan}
                    disabled={refreshing || deepScanning}
                    title="直接扫描 \\.\PhysicalDrive0..15，把系统列不出来的「隐身盘」也找出来"
                  >
                    {deepScanning ? '深度扫描中…' : '深度扫描'}
                  </button>
                </div>
              </header>

              {deepScanMsg && <div className="deep-scan-msg">{deepScanMsg}</div>}

              {listDevices.length === 0 ? (
                <div className="empty">没有检测到可还原的磁盘，插入 U 盘后点击刷新</div>
              ) : (
                <div className="device-list">
                  {listDevices.map((d) => {
                    const locked = d.protected || d.system || d.readOnly || d.internal
                    const active = d.id === selected?.id
                    const isFastUsb = !!d.usbGen && /^USB 3/.test(d.usbGen)
                    const isSlowUsb = !!d.usbGen && !isFastUsb
                    return (
                      <button
                        key={d.id}
                        className={`device ${active ? 'active' : ''} ${locked ? 'locked' : ''}`}
                        disabled={locked}
                        onClick={() => {
                          if (locked) return
                          setSelected(d)
                          setAck(false)
                          setNotice('')
                        }}
                        title={d.devicePath}
                      >
                        <div className="dev-radio">{active ? '●' : '○'}</div>
                        <div className="dev-body">
                          <div className="dev-line">
                            <span className="dev-name">{d.displayName}</span>
                            <span className="dev-size">{formatBytes(d.size)}</span>
                          </div>
                          <div className="dev-tags">
                            <span className={`tag ${d.removable ? 'tag-ok' : d.internal ? 'tag-warn' : ''}`}>
                              {d.internal ? '内置硬盘' : '可移动'}
                            </span>
                            <span className={`tag ${isFastUsb ? 'tag-ok' : isSlowUsb ? 'tag-warn' : ''}`}>
                              {d.usbGen || d.busType}
                            </span>
                            {d.mountPoints.map((m) => (
                              <span key={m} className="tag">
                                {m}
                              </span>
                            ))}
                            {d.notes && <span className="dev-note">{d.notes}</span>}
                          </div>
                          {locked && <div className="dev-warn">内置硬盘 / 系统盘 / 只读，不能还原</div>}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
              {showAll && (
                <p className="dev-tip">
                  勾了<b>「显示全部磁盘」</b>才会列出内置硬盘与系统盘 —— 它们一律不能还原，列出来只是让你确认
                  「哪块才是我的 U 盘」。
                </p>
              )}
            </section>

            {/* ---------- 2. 还原后的格式 ---------- */}
            <section className="card">
              <header className="card-head">
                <span className="step-badge">2</span>
                <div>
                  <h2>还原后的格式</h2>
                  <p className="sub">还原完成后，这块盘在「此电脑」里的文件系统与名字</p>
                </div>
              </header>
              <FormatPanel value={fmt} onChange={setFmt} disabled={false} simple />
            </section>

            {/* ---------- 3. 确认并还原 ---------- */}
            <section className="card">
              <header className="card-head">
                <span className="step-badge">3</span>
                <div>
                  <h2>确认并还原</h2>
                  <p className="sub">还原会清空全部数据并重建分区表，操作不可撤销</p>
                </div>
              </header>

              {selected && (
                <div className="banner danger">
                  <strong>{selected.displayName}</strong>（{formatBytes(selected.size)}，
                  {selected.mountPoints.length ? selected.mountPoints.join(' ') : '无盘符'}）上的所有数据将被永久删除。
                </div>
              )}

              <p className="hint">
                还原只针对 U 盘 / 移动硬盘：内置硬盘与系统盘会被拒绝。完成后自动分配盘符，
                在「此电脑」里就是一块能直接用的普通 U 盘。
              </p>

              <div className="options">
                <label className="switch danger">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                    disabled={!selected}
                  />
                  <span>我已确认目标磁盘选择无误，且已备份重要数据</span>
                </label>
              </div>

              <button className="btn primary block" disabled={!canStart} onClick={startRepair}>
                {!selected ? '请选择目标磁盘' : !ack ? '请勾选确认后开始' : '开始还原'}
              </button>
            </section>
          </>
        )}
      </div>

      <footer className="restore-foot">
        <span>
          {APP_NAME} <b>{versionLabel()}</b>
        </span>
        <span className="restore-sep">·</span>
        <span>构建于 {APP_BUILD_TIME}</span>
      </footer>
    </div>
  )
}
