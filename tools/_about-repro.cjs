// 复现「关于弹窗打不开」：用【真 preload】加载部署版 asar 的渲染页，
// 点「关于」按钮，把弹窗状态、计算样式、控制台错误全部打出来。
//   用法：DORO_PAGE=<asar内index.html> npx electron tools/_about-repro.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')

const ROOT = path.join(__dirname, '..')
const PAGE = process.env.DORO_PAGE || path.join(ROOT, 'out', 'renderer', 'index.html')
// 真 preload：打包后在 asar 内 out/preload/index.js；本地在 out/preload/index.js
let PRELOAD = path.join(ROOT, 'out', 'preload', 'index.js')
if (!fs.existsSync(PRELOAD)) {
  // 部署版：从 asar 里取（asar 路径可直接 require/加载）
  PRELOAD = path.join(path.dirname(PAGE), '..', 'preload', 'index.js')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  console.log('PAGE =', PAGE)
  console.log('PRELOAD =', PRELOAD, fs.existsSync(PRELOAD) ? '(exists)' : '(MISSING)')
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    show: false,
    offscreen: true,
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#ffffff', symbolColor: '#22262f', height: 62 }
        }
      : {}),
    webPreferences: {
      preload: PRELOAD,
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.webContents.on('console-message', (_e, level, message) => {
    console.log(`  [renderer L${level}]`, message)
  })
  win.webContents.on('render-process-gone', (_e, d) => console.log('  [render-process-gone]', JSON.stringify(d)))

  try {
    await win.loadFile(PAGE)
  } catch (e) {
    console.log('loadFile FAILED:', e.message)
    app.exit(1)
    return
  }
  await sleep(1200)

  const before = await win.webContents.executeJavaScript(`(() => JSON.stringify({
    hasAboutBtn: !!document.querySelector('.about-btn'),
    hasFooterLink: !!document.querySelector('.footer-link'),
    maskBefore: !!document.querySelector('.modal-mask')
  }))()`)
  console.log('before click:', before)

  const click = await win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.about-btn');
    if (!b) return 'no-button';
    b.click();
    return 'clicked';
  })()`)
  console.log('click:', click)
  await sleep(600)

  const after = await win.webContents.executeJavaScript(`(() => {
    const mask = document.querySelector('.modal-mask');
    const about = document.querySelector('.about');
    const cs = mask ? getComputedStyle(mask) : null;
    return JSON.stringify({
      maskExists: !!mask,
      aboutExists: !!about,
      maskPos: cs && cs.position,
      maskZ: cs && cs.zIndex,
      maskPadRight: cs && cs.paddingRight,
      maskDisplay: cs && cs.display,
      maskRect: mask ? mask.getBoundingClientRect().toJSON() : null,
      aboutRect: about ? about.getBoundingClientRect().toJSON() : null,
      envVar: getComputedStyle(document.documentElement).getPropertyValue('--x') || null
    });
  })()`)
  console.log('after JS click:', after)

  // ---- 第二幕：关掉后改用【原生输入事件】真实点击（mousedown→mouseup→click） ----
  await win.webContents.executeJavaScript(`(() => {
    const x = document.querySelector('.about-x');
    if (x) x.click();
    return true
  })()`)
  await sleep(300)
  const closed = await win.webContents.executeJavaScript(`(() => !document.querySelector('.modal-mask'))()`)
  console.log('closed before native click:', closed)

  const rect = await win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.about-btn');
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  })()`)
  const pt = JSON.parse(rect)
  console.log('about-btn center (CSS px):', pt)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(60)
  win.webContents.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(600)

  const afterNative = await win.webContents.executeJavaScript(`(() => {
    const mask = document.querySelector('.modal-mask');
    const about = document.querySelector('.about');
    return JSON.stringify({
      maskExists: !!mask,
      aboutExists: !!about,
      aboutRect: about ? about.getBoundingClientRect().toJSON() : null
    });
  })()`)
  console.log('after NATIVE click:', afterNative)

  const img = await win.webContents.capturePage()
  const outDir = path.join(ROOT, 'dist', '_uicheck', 'repro')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'about-click.png'), img.toPNG())
  console.log('screenshot ->', path.join(outDir, 'about-click.png'))
  app.exit(0)
})
