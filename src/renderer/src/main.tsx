import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AboutWindow from './components/AboutWindow'
import RestoreWindow from './components/RestoreWindow'
import ErrorBoundary from './components/ErrorBoundary'
import type { AboutSection } from '@shared/api'
import './styles.css'

/**
 * 同一个渲染层入口，三种身份 —— 靠 URL 的 hash 区分：
 *   `#about` / `#donate`  → 「关于 / 捐赠」独立窗口
 *   `#restore`            → 「U 盘还原」独立窗口
 *   其它                  → 主界面
 *
 * 2026-10-14 起「关于 / 捐赠」「U 盘还原」都不再叠在主界面上，而是主进程另开
 * 独立窗口（用户原话「实在不行就做成单独独立的框吧」「点U盘还原最好还是单独
 * 弹出来一个窗口吧」）。几个窗口共用这一份代码，主题、字体、图标全都一致，
 * 只是渲染的根节点不同。
 */
function aboutSectionFromHash(): AboutSection | null {
  try {
    const h = window.location.hash.replace(/^#/, '')
    return h === 'about' || h === 'donate' ? h : null
  } catch {
    return null
  }
}

function isRestoreHash(): boolean {
  try {
    return window.location.hash.replace(/^#/, '') === 'restore'
  } catch {
    return false
  }
}

const aboutSection = aboutSectionFromHash()
const restoreIdentity = isRestoreHash()

/**
 * 界面侧启动自述。
 *
 * 界面能渲染出来时它是「一切正常」的证明；渲染不出来时（白屏 / 窗口压根没显示），
 * 这几条会落到 %APPDATA%\<应用名>\startup.log，是排查白屏最直接的线索。
 * window.api 缺失说明 preload 没加载上 —— 那是另一类故障，这里也一并记下来。
 */
const diag = (msg: string): void => {
  try {
    window.api?.diagLog?.(msg)
  } catch {
    // 诊断失败绝不拖累界面
  }
}

diag(
  `界面脚本开始执行 preload=${window.api ? '已注入' : '缺失'} ` +
    `身份=${restoreIdentity ? '还原窗口' : aboutSection ? `关于窗口(${aboutSection})` : '主界面'} ` +
    `ua=${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? '?'} dpr=${window.devicePixelRatio}`
)

window.addEventListener('error', (e) => {
  diag(`!! 界面未捕获错误：${e.message} @ ${e.filename}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', (e) => {
  diag(`!! 界面未处理 Promise 拒绝：${String((e as PromiseRejectionEvent).reason)}`)
})

/**
 * 首帧自证。
 *
 * 光有「React 已挂载」是不够的 —— React 18 的 root.render() 是**异步调度**的，
 * 它只说明任务排上了队，不代表真的画出来了。而且把浏览器逼到「真的产出一帧」
 * 的 requestAnimationFrame 回调跑到了，才说明界面确实可见。
 */
function BootProbe(): null {
  React.useEffect(() => {
    diag('界面已挂载完成（React 提交了 <App/>）')
    try {
      requestAnimationFrame(() => {
        const root = document.getElementById('root')
        diag(`界面首帧已绘制 #root 子节点=${root ? root.childElementCount : -1}`)
      })
    } catch {
      // 忽略
    }
  }, [])
  return null
}

const rootEl = document.getElementById('root')
if (!rootEl) {
  diag('!! 找不到 #root 挂载点，界面无法渲染')
} else {
  // 占位块只是「脚本没跑起来」时的兜底，这里确定地清掉，避免 React 挂载后残留
  document.getElementById('boot-splash')?.remove()
  try {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <BootProbe />
        {restoreIdentity ? (
          <RestoreWindow />
        ) : aboutSection ? (
          <AboutWindow section={aboutSection} />
        ) : (
          <App />
        )}
      </ErrorBoundary>
    </React.StrictMode>
  )
    diag('React 已挂载')
  } catch (e) {
    diag(`!! React 挂载失败：${(e as Error)?.message}`)
    throw e
  }
}
