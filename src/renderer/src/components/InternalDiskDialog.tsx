import { useEffect, useRef, useState } from 'react'
import type { DeviceInfo } from '@shared/types'
import { formatBytes } from '../lib'

interface Props {
  /** 非 null 时弹出：值是用户刚点击的那块「内置硬盘」 */
  device: DeviceInfo | null
  onConfirm: (d: DeviceInfo) => void
  onCancel: () => void
}

/**
 * 选中内置硬盘时的强提醒弹窗。
 *
 * 背景：默认列表里只显示 U 盘/移动盘，内置盘要手动打开「显示内置磁盘」才会出现，
 * 一不留神就会把系统盘或资料盘当成 U 盘刻了。所以这里加一道硬门槛 ——
 * 点内置盘不直接选中，而是先弹这个警告，勾选确认后才能选中。
 *
 * 默认焦点落在「取消」上（键盘一路回车也不会误确认），Esc 也是取消。
 */
export default function InternalDiskDialog({ device, onConfirm, onCancel }: Props) {
  const [checked, setChecked] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!device) return
    setChecked(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onCancel()
    }
    document.addEventListener('keydown', onKey, true)
    const t = window.setTimeout(() => cancelRef.current?.focus(), 30)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.clearTimeout(t)
    }
  }, [device, onCancel])

  if (!device) return null

  const mounts = device.mountPoints.length ? device.mountPoints.join('  ') : '无盘符'

  return (
    <div className="modal-mask" onMouseDown={onCancel} role="presentation">
      <div
        className="danger-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="danger-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="danger-head">
          <span className="danger-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path
                d="M12 3.4 2.6 20.2h18.8L12 3.4Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path
                d="M12 9.4v5.3M12 17.9v.01"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <div className="danger-head-text">
            <h3 id="danger-dialog-title">停一下 —— 你选的是电脑内置硬盘</h3>
            <p className="danger-sub">这不是 U 盘。继续写入会永久清空这块盘，无法恢复。</p>
          </div>
        </header>

        {/* 把这块盘的「身份」摆在最前面，让人一眼看清选的是哪块 */}
        <div className="danger-dev">
          <div className="danger-dev-name">{device.displayName}</div>
          <div className="danger-dev-rows">
            <span>
              <b>容量</b>
              {formatBytes(device.size)}
            </span>
            <span>
              <b>盘符</b>
              {mounts}
            </span>
            <span>
              <b>接口</b>
              {device.busType || '未知'}
            </span>
            <span>
              <b>分区</b>
              {device.partitionStyle || '未知'}
            </span>
          </div>
        </div>

        <div className="danger-body">
          <p>刻录 / 格式化会从磁盘第 0 字节起整盘覆盖：</p>
          <ul>
            <li>
              这块硬盘上的<b>全部分区、全部文件</b>都会变成「不存在」，且不可恢复；
            </li>
            <li>如果它是系统盘或装有重要资料的资料盘，重装系统、找回数据都会非常麻烦；</li>
            <li>数据丢失后没有任何「撤销」按钮，也没有「回收站」。</li>
          </ul>
          <p className="danger-body-end">如果你只是想刻 U 盘 —— 点下面「取消」，再从列表里选那个可移动设备。</p>
        </div>

        <label className="danger-ack">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>
            我已确认上面这块硬盘里<b>没有需要保留的数据</b>，或已经完成备份
          </span>
        </label>

        <div className="danger-actions">
          <button ref={cancelRef} className="btn ghost" onClick={onCancel}>
            取消，改选 U 盘
          </button>
          <button
            className="btn danger-solid"
            disabled={!checked}
            onClick={() => onConfirm(device)}
          >
            我确认，仍要使用这块内置硬盘
          </button>
        </div>
      </div>
    </div>
  )
}
