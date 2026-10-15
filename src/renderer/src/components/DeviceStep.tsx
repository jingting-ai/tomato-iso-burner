import type { DeviceInfo } from '@shared/types'
import { formatBytes } from '../lib'

interface Props {
  devices: DeviceInfo[]
  selectedId: string | null
  onSelect: (d: DeviceInfo) => void
  onRefresh: () => void
  busy: boolean
  showAll: boolean
  onToggleShowAll: (v: boolean) => void
  imageSize: number
  disabled: boolean
  /**
   * 深度扫描：把「此电脑 / 磁盘管理里完全看不到」的盘也找出来。
   * 刻录失败变砖的 U 盘常常连系统都列不出来，常规刷新（Get-Disk）看不到它，
   * 这时就靠这个按钮 —— 它直接扫 \\.\PhysicalDrive0..15。
   */
  onDeepScan?: () => void
  deepScanning?: boolean
  deepScanMsg?: string
}

export default function DeviceStep({
  devices,
  selectedId,
  onSelect,
  onRefresh,
  busy,
  showAll,
  onToggleShowAll,
  imageSize,
  disabled,
  onDeepScan,
  deepScanning = false,
  deepScanMsg = ''
}: Props) {
  return (
    <section className="card">
      <header className="card-head">
        <span className="step-badge">2</span>
        <div>
          <h2>选择目标磁盘</h2>
          <p className="sub">目标磁盘上的所有数据都会被覆盖</p>
        </div>
        <div className="head-actions">
          <label className="switch">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => onToggleShowAll(e.target.checked)}
              disabled={disabled}
            />
            <span>显示内置磁盘</span>
          </label>
          <button className="btn ghost small" onClick={onRefresh} disabled={busy || disabled}>
            {busy ? '刷新中…' : '刷新'}
          </button>
          {onDeepScan && (
            <button
              className="btn ghost small"
              onClick={onDeepScan}
              disabled={busy || disabled || deepScanning}
              title="直接扫描 \\.\PhysicalDrive0..15，把系统列不出来的「隐身盘」也找出来"
            >
              {deepScanning ? '深度扫描中…' : '深度扫描'}
            </button>
          )}
        </div>
      </header>

      {deepScanMsg && <div className="deep-scan-msg">{deepScanMsg}</div>}

      {devices.length === 0 ? (
        <div className="empty">没有检测到可用磁盘，插入 U 盘后点击刷新</div>
      ) : (
        <>
          <div className="device-list">
          {devices.map((d) => {
            const locked = d.protected || d.system || d.readOnly
            const tooSmall = imageSize > 0 && d.size > 0 && d.size < imageSize
            const unselectable = locked || tooSmall
            const active = d.id === selectedId
            // USB 接口版本：3.x 标绿（快），2.0 及以下标黄（刻录会明显慢）
            const isFastUsb = !!d.usbGen && /^USB 3/.test(d.usbGen)
            const isSlowUsb = !!d.usbGen && !isFastUsb
            return (
              <button
                key={d.id}
                className={`device ${active ? 'active' : ''} ${unselectable ? 'locked' : ''}`}
                disabled={unselectable || disabled}
                onClick={() => !unselectable && onSelect(d)}
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
                    {/* 接口类型；USB 盘换成更具体的「USB 3.0」这类接口版本
                        （判不出来就还是显示 USB）—— 不再拼成「USB · USB 3.0」那种重复字样 */}
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
                  {locked && <div className="dev-warn">系统盘 / 只读，禁止写入</div>}
                  {!locked && tooSmall && <div className="dev-warn">容量不足，放不下该镜像</div>}
                </div>
              </button>
            )
          })}
          </div>
          {showAll && (
            <p className="dev-tip">
              标着<b>「内置硬盘」</b>的是电脑里的固定硬盘。点它不会直接选中 ——
              会先弹出风险提醒，二次确认后才允许使用。
            </p>
          )}
        </>
      )}
    </section>
  )
}
