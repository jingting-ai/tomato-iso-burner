import { useEffect, useRef } from 'react'
import type { LogEntry } from '@shared/types'
import { formatTime } from '../lib'

interface Props {
  logs: LogEntry[]
  collapsed: boolean
  onToggle: () => void
}

export default function LogPanel({ logs, collapsed, onToggle }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!collapsed && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight
    }
  }, [logs, collapsed])

  return (
    <section className={`card log-card ${collapsed ? 'collapsed' : ''}`}>
      <header className="card-head compact" onClick={onToggle}>
        <span className="caret">{collapsed ? '▸' : '▾'}</span>
        <h2>运行日志</h2>
        <span className="log-count">{logs.length}</span>
      </header>
      {!collapsed && (
        <div className="log-box" ref={boxRef}>
          {logs.length === 0 ? (
            <div className="log-line dim">暂无日志</div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className={`log-line ${l.level}`}>
                <span className="log-time">{formatTime(l.time)}</span>
                <span className="log-text">{l.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  )
}
