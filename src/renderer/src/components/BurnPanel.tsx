import type { ProgressState, WritePhase } from '@shared/types'
import { formatBytes, formatEta, formatSpeed } from '../lib'

interface Props {
  progress: ProgressState
  imageName: string
  deviceName: string
  onCancel: () => void
  /** 当前跑的是刻录还是 U 盘还原 —— 两者的阶段名与统计项不一样 */
  kind?: 'burn' | 'repair'
}

const PHASE_TEXT: Record<ProgressState['phase'], string> = {
  idle: '准备中',
  prepare: '正在卸载目标设备',
  write: '正在写入镜像',
  verify: '正在校验数据',
  done: '完成',
  error: '出错',
  cancelled: '已取消'
}

/** U 盘还原的阶段名（同一组 phase，换一套说法） */
const REPAIR_PHASE_TEXT: Record<ProgressState['phase'], string> = {
  idle: '准备中',
  prepare: '正在打开设备并清只读',
  write: '正在清理残留并重建分区表',
  verify: '正在确认盘符',
  done: '完成',
  error: '出错',
  cancelled: '已取消'
}

/** 刻录的阶段顺序，用于顶部步骤指示 */
const BURN_STAGES: { key: WritePhase; label: string }[] = [
  { key: 'prepare', label: '卸载设备' },
  { key: 'write', label: '写入镜像' },
  { key: 'verify', label: '校验数据' }
]

/** 修复的阶段顺序 */
const REPAIR_STAGES: { key: WritePhase; label: string }[] = [
  { key: 'prepare', label: '打开设备' },
  { key: 'write', label: '清残留并重建分区表' },
  { key: 'verify', label: '确认盘符' }
]

function stageState(phase: WritePhase, key: WritePhase): 'done' | 'active' | 'todo' {
  const order = ['prepare', 'write', 'verify']
  const cur = order.indexOf(phase)
  const idx = order.indexOf(key)
  if (cur < 0) return 'todo'
  if (idx < cur) return 'done'
  if (idx === cur) return 'active'
  return 'todo'
}

export default function BurnPanel({
  progress,
  imageName,
  deviceName,
  onCancel,
  kind = 'burn'
}: Props) {
  const { phase, percent, writtenBytes, totalBytes, speed, etaSeconds } = progress
  const pct = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
  const verifying = phase === 'verify'
  const repairing = kind === 'repair'
  const text = repairing ? REPAIR_PHASE_TEXT : PHASE_TEXT
  const stages = repairing ? REPAIR_STAGES : BURN_STAGES

  return (
    <section className="card burn">
      <div className="burn-headline">
        <span className="burn-title">{text[phase] ?? (repairing ? '还原中' : '刻录中')}</span>
        <span className="burn-target">
          {repairing ? deviceName : `${imageName} → ${deviceName}`}
        </span>
      </div>

      <div className="burn-percent">
        {pct.toFixed(1)}
        <small>%</small>
      </div>

      <div className="progress-track">
        <div
          className={`progress-fill ${verifying ? 'verify' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="burn-stages">
        {stages.map((s, i) => {
          const st = stageState(phase, s.key)
          return (
            <span key={s.key} className={st === 'todo' ? '' : st}>
              {i + 1}. {s.label}
            </span>
          )
        })}
      </div>

      {/* 还原没有「写入字节数 / 速度 / 剩余时间」这些概念，只报百分比 */}
      {!repairing && (
      <div className="stat-grid">
        <div className="stat">
          <span className="stat-label">已写入</span>
          <span className="stat-value">
            {formatBytes(writtenBytes)}
            {totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : ''}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">{verifying ? '校验速度' : '写入速度'}</span>
          <span className="stat-value">{phase === 'prepare' ? '—' : formatSpeed(speed)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">剩余时间</span>
          <span className="stat-value">{verifying ? '校验中' : formatEta(etaSeconds)}</span>
        </div>
      </div>
      )}

      <div className="burn-actions">
        {repairing ? (
          <span className="hint">还原过程中请勿拔出 U 盘</span>
        ) : (
          <>
            <button className="btn danger ghost" onClick={onCancel}>
              取消刻录
            </button>
            <span className="hint">刻录过程中请勿拔出设备或断开电源</span>
          </>
        )}
      </div>
    </section>
  )
}
