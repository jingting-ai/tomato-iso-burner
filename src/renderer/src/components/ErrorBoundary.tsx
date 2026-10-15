import React from 'react'

type Props = { children: React.ReactNode }
type State = { error: Error | null }

/**
 * 界面级兜底。
 *
 * 没有它的时候，`<App />` 只要在渲染里抛一次异常，React 就会卸载整棵树 ——
 * 用户看到的是「窗口开着，里面一片空白」，界面上连个提示都没有，只能干瞪眼。
 * 有了它至少能看到出错信息、知道去哪找日志，还能一键重新加载界面。
 *
 * 样式一律内联：这个组件存在的意义就是「别的东西坏掉时它还得能显示」，
 * 绝不能依赖样式表（样式表本身也可能加载失败）。
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      window.api?.diagLog?.(
        `!! 界面崩溃：${error.message} @ ${String(info.componentStack).slice(0, 300)}`
      )
    } catch {
      // 上报失败不影响兜底界面展示
    }
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        style={{
          padding: '48px 56px',
          font: "14px/1.8 'Microsoft YaHei', system-ui, sans-serif"
        }}
      >
        <h2 style={{ margin: '0 0 12px', fontSize: '18px', color: '#b4232b' }}>界面出错了</h2>
        <p style={{ margin: '0 0 8px', color: '#3b4250' }}>{error.message}</p>
        <p style={{ margin: '0 0 20px', color: '#7b8290', fontSize: '13px' }}>
          详细信息已写入 %APPDATA%\番茄镜像刻录工具\startup.log，把这份日志发出来即可定位。
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            font: "13px/1 'Microsoft YaHei', system-ui, sans-serif",
            padding: '9px 18px',
            borderRadius: '8px',
            border: '1px solid #cfd4dd',
            background: '#fff',
            color: '#2b3140',
            cursor: 'pointer'
          }}
        >
          重新加载界面
        </button>
      </div>
    )
  }
}
