/**
 * 首帧对照实验：验证「渲染进程到底有没有产出第一帧」。
 *
 * 判据是 Electron 的 ready-to-show —— 它只在首帧画好后触发。
 * 真实应用日志里每次都是 `did-finish-load` 抢到显示权、ready-to-show 从不出现，
 * 所以窗口亮出来就是一片空白。这个脚本把变量拆开来单独测：
 *
 *   PAINT_MODE=asis   带 disableHardwareAcceleration + disable-gpu* （= 当前应用）
 *   PAINT_MODE=hw     不禁用 GPU（Electron 默认）
 *   PAINT_SHOW=1      窗口创建即显示（show:true）
 *   PAINT_PAGE=real   用真实的 out/renderer/index.html，而不是最小页面
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const MODE = process.env.PAINT_MODE || 'asis'
const SHOW = process.env.PAINT_SHOW === '1'
const PAGE = process.env.PAINT_PAGE || 'min'

// 逐个开关单独试，找出到底哪一条让隐藏窗口不绘制首帧
if (MODE === 'asis' || MODE === 'nohwaccel') app.disableHardwareAcceleration()
if (MODE === 'asis' || MODE === 'onlydg') app.commandLine.appendSwitch('disable-gpu')
if (MODE === 'asis' || MODE === 'onlydgc')
  app.commandLine.appendSwitch('disable-gpu-compositing')
if (MODE === 'asis' || MODE === 'onlydgs')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
// 开关：关掉 Chromium 的「原生窗口遮挡检测」。
// 它会把系统认为被遮挡的窗口判为不需绘制 → 不下发 BeginFrame → 首帧永不来。
if (MODE === 'occl') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}
app.commandLine.appendSwitch('no-sandbox')

const TAG = `${MODE}${SHOW ? '-shown' : ''}-${PAGE}`
const t0 = Date.now()
const lines = []
const L = (m) => {
  const line = `[+${String(Date.now() - t0).padStart(6)}ms] ${m}`
  lines.push(line)
  console.log(line)
}

const MIN_HTML = `<!doctype html><html><body style="margin:0;background:#f4f6fb">
<div id="root"><h1 style="font:20px sans-serif;color:#123">HELLO-PAINT-TEST</h1></div>
</body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    show: SHOW,
    backgroundColor: '#f4f6fb',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#22262f', height: 62 },
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  })

  let rts = false
  win.once('ready-to-show', () => {
    rts = true
    L('*** ready-to-show FIRED（首帧已画好）')
  })
  win.webContents.once('did-finish-load', () => L('did-finish-load'))
  win.webContents.on('console-message', (_e, _l, m) => L(`  console: ${m}`))

  try {
    if (PAGE === 'real') {
      const p = path.join(__dirname, '..', 'out', 'renderer', 'index.html')
      L(`loadFile ${p} 存在=${fs.existsSync(p)}`)
      await win.loadFile(p)
    } else {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(MIN_HTML))
    }
  } catch (e) {
    L('!! 加载失败: ' + e.message)
  }
  L(`加载返回 isVisible=${win.isVisible()} readyToShow=${rts}`)

  await new Promise((r) => setTimeout(r, 5000))
  L(`5 秒后 isVisible=${win.isVisible()} readyToShow=${rts}`)

  try {
    let text = '(取不到)'
    try {
      text = await win.webContents.executeJavaScript(
        'document.body ? document.body.innerText.slice(0,80) : "(no body)"'
      )
    } catch (e) {
      text = '(executeJavaScript 失败: ' + e.message + ')'
    }
    L(`body.innerText = ${JSON.stringify(text)}`)

    const img = await win.webContents.capturePage()
    const bmp = img.toBitmap()
    let min = 255
    let max = 0
    for (let i = 0; i < bmp.length; i += 4) {
      const v = bmp[i]
      if (v < min) min = v
      if (v > max) max = v
    }
    const dir = path.join(__dirname, '..', 'dist', '_uicheck', 'repro')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `painttest-${TAG}.png`), img.toPNG())
    const s = img.getSize()
    L(
      `capturePage ${s.width}x${s.height} 通道极值 min=${min} max=${max} → ` +
        (max - min > 10 ? '有内容' : '纯色 = 没画出来')
    )
  } catch (e) {
    L('!! capturePage 失败: ' + e.message)
  }

  const dir = path.join(__dirname, '..', 'dist', '_uicheck', 'repro')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `painttest-${TAG}.log`), lines.join('\n'))
  L('结论: ready-to-show ' + (rts ? '触发了' : '从未触发'))
  app.exit(0)
})
