// 真机级复现：直接加载部署 asar 里的【真实主进程】，用真实窗口 + 真实输入事件
// 点「关于」按钮，看弹窗到底出不出来。
//   TOMATO_MAIN=<asar内main/index.js> npx electron tools/_about-realapp.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 关键：用户正在跑的那个实例持有默认 userModelId 的单实例锁。
// 这里换一个独立的，测试实例才起得来（否则 require 真实主进程后会被锁直接 quit）。
app.setAppUserModelId('TomatoDebugHarness')

const MAIN = process.env.TOMATO_MAIN || 'E:/番茄镜像刻录工具/resources/app.asar/out/main/index.js'
console.log('loading real main:', MAIN)
require(MAIN)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 防挂死：无论什么情况，100 秒后强制退出（timeout 兜底）
const failsafe = setTimeout(() => { console.log('FAILSAFE TIMEOUT'); app.exit(2) }, 100000)
failsafe.unref?.()

app.whenReady().then(async () => {
  try {
  // 等真实主进程的窗口建出来（它自己也有 whenReady → createWindow）
  let win = null
  for (let i = 0; i < 120; i++) {
    const ws = BrowserWindow.getAllWindows()
    if (ws.length) { win = ws[0]; break }
    await sleep(100)
  }
  if (!win) { console.log('NO WINDOW CREATED'); app.exit(1); return }
  await sleep(2500) // 等 renderer 起来 + IPC 就绪
  console.log('window content size:', JSON.stringify(win.getContentSize()))

  win.webContents.on('console-message', (_e, l, m) => console.log('  [renderer]', m))
  win.webContents.on('render-process-gone', (_e, d) => console.log('  [RENDERER GONE]', JSON.stringify(d)))

  const env = await win.webContents.executeJavaScript(
    `(() => JSON.stringify({ hasBtn: !!document.querySelector('.about-btn'), mask: !!document.querySelector('.modal-mask') }))()`
  )
  console.log('initial:', env)

  // ---- 真实输入事件（走原生事件路径，app-region 拖动区在此路径上才生效）----
  const pt = await win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.about-btn'); if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }
  })()`)
  console.log('about-btn center:', JSON.stringify(pt))
  if (pt) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y })
    await sleep(120)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await sleep(100)
    win.webContents.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  }
  await sleep(900)

  const state = await win.webContents.executeJavaScript(`(() => {
    const mask = document.querySelector('.modal-mask')
    const about = document.querySelector('.about')
    return JSON.stringify({
      mask: !!mask, about: !!about,
      aboutRect: about ? about.getBoundingClientRect().toJSON() : null,
      maskPad: mask ? getComputedStyle(mask).paddingRight : null
    })
  })()`)
  console.log('AFTER REAL CLICK:', state)

  const img = await win.webContents.capturePage()
  const outDir = path.join(__dirname, '..', 'dist', '_uicheck', 'repro')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'realapp-about.png'), img.toPNG())
  console.log('screenshot ->', path.join(outDir, 'realapp-about.png'))
  app.exit(0)
  } catch (e) { console.log('HARNESS ERROR:', e && e.message); app.exit(3) }
})
