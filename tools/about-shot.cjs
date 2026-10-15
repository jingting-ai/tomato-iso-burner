// 「关于 / 捐赠」面板离屏自检：加载真实构建产物，打开面板并截图。
//   用法：npx electron tools/about-shot.cjs        （需先去掉 ELECTRON_RUN_AS_NODE）
//   产物：dist/_uicheck/about-*.png
//
// 只创建一个离屏窗口、只加载一次页面，之后靠改 data-theme 与窗口尺寸切换场景
// —— 反复 loadFile 在离屏模式下会互相打断（ERR_FAILED），这里绕开它。
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('no-sandbox')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'dist', '_uicheck')
const PAGE = path.join(ROOT, 'out', 'renderer', 'index.html')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 打开面板并量关键尺寸 */
const PROBE = `(function(){
  var btn = document.querySelector('.about-btn');
  if (!btn) return { error: '找不到「关于」按钮' };
  btn.click();
  return new Promise(function(res){
    setTimeout(function(){
      var dlg = document.querySelector('.about');
      var body = document.querySelector('.about-body');
      var grid = document.querySelector('.feat-grid');
      var dg = document.querySelector('.donate-grid');
      var shots = document.querySelectorAll('.qr-shot img');
      var rect = function (el) { return el ? el.getBoundingClientRect() : null };
      var d = rect(dlg), b = rect(body), bt = rect(btn);
      res({
        opened: !!dlg,
        panel: d ? { w: Math.round(d.width), h: Math.round(d.height) } : null,
        bodyOverflowPx: body ? body.scrollHeight - body.clientHeight : null,
        featCols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
        featCount: grid ? grid.children.length : 0,
        donateCols: dg ? getComputedStyle(dg).gridTemplateColumns : null,
        qr: [].map.call(shots, function (i) {
          return { nat: i.naturalWidth + 'x' + i.naturalHeight,
                   shown: Math.round(i.getBoundingClientRect().width) }
        }),
        version: (document.querySelector('.about-ver') || {}).textContent,
        hero: ((document.querySelector('.about-hero h3') || {}).textContent || ''),
        // 顶栏：加了「关于」按钮之后有没有被窗口按钮挤到溢出
        topbar: (function () {
          var tb = document.querySelector('.topbar');
          var tr = document.querySelector('.topbar-right');
          return {
            overflow: tb.scrollWidth > tb.clientWidth + 1,
            rightClipped: tr.scrollWidth > tr.clientWidth + 1,
            rightEdge: Math.round(tr.getBoundingClientRect().right),
            btnRightEdge: Math.round(bt.right),
            windowW: window.innerWidth,
            buttonsStartAt: window.innerWidth - 136,
            aboutBtnVisible: bt.width > 0 && bt.right <= window.innerWidth - 136
          }
        })()
      });
    }, 240);
  });
})()`

async function main() {
  process.on('unhandledRejection', (e) => console.log('  [忽略] ' + (e && e.message)))
  fs.mkdirSync(OUT, { recursive: true })

  const win = new BrowserWindow({
    width: 1000,
    height: 1000,
    show: false,
    offscreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'ui-shot-preload.cjs'),
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/Security Warning/.test(message)) console.log('  [renderer]', message)
  })

  await win.loadFile(PAGE)
  await sleep(900)

  // 模拟 Windows 上叠画的窗口按钮区（离屏窗口没有 env(titlebar-area-width)）
  await win.webContents.executeJavaScript(
    `(function(){ var tb=document.querySelector('.topbar'); if(tb) tb.style.paddingRight='136px'; return true })()`
  )

  const info = await win.webContents.executeJavaScript(PROBE)
  console.log('  自检数据:', JSON.stringify(info, null, 0))

  const shot = async (file) => {
    await sleep(200)
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, file), img.toPNG())
    console.log(`  -> ${file}`)
  }

  const setTheme = async (t) => {
    await win.webContents.executeJavaScript(
      `document.documentElement.setAttribute('data-theme', '${t}'); true`
    )
  }
  const resize = async (w, h) => {
    win.setContentSize(w, h)
    await sleep(400)
  }

  // 1) 常用窗口尺寸（1000×1000）下浅色 / 深色
  await setTheme('light')
  await shot('about-light.png')
  await setTheme('dark')
  await shot('about-dark.png')

  // 2) 二维码放大态
  await setTheme('light')
  await win.webContents.executeJavaScript(
    `(function(){ var s=document.querySelector('.qr-card.wechat .qr-shot'); if(s) s.click(); return !!s })()`
  )
  await sleep(300)
  const z = await win.webContents.executeJavaScript(
    `(function(){ var b=document.querySelector('.qr-zoom-box img');
       return b ? { nat: b.naturalWidth, shown: Math.round(b.getBoundingClientRect().width) } : null })()`
  )
  console.log('  放大图:', JSON.stringify(z))
  await shot('about-zoom.png')
  await win.webContents.executeJavaScript(
    `(function(){ var m=document.querySelector('.qr-zoom-mask'); if(m) m.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return !!m })()`
  )
  await sleep(250)

  // 3) 默认窗口尺寸（1000×760，主进程的默认值）
  await resize(1000, 760)
  const d = await win.webContents.executeJavaScript(
    `(function(){ var b=document.querySelector('.about-body');
       return { over: b ? b.scrollHeight - b.clientHeight : null } })()`
  )
  console.log('  1000x760:', JSON.stringify(d))
  await shot('about-default.png')

  // 4) 最窄窗口（主进程 minWidth × minHeight）
  await resize(880, 660)
  const n = await win.webContents.executeJavaScript(
    `(function(){ var b=document.querySelector('.about-body');
       var tr=document.querySelector('.topbar-right');
       return { over: b ? b.scrollHeight - b.clientHeight : null,
                topbarClipped: tr.scrollWidth > tr.clientWidth + 1,
                aboutBtnRight: Math.round(document.querySelector('.about-btn').getBoundingClientRect().right),
                limit: window.innerWidth - 136 } })()`
  )
  console.log('  880x660:', JSON.stringify(n))
  await shot('about-narrow.png')
  await setTheme('dark')
  await shot('about-narrow-dark.png')

  win.destroy()
  console.log('done')
  app.exit(0)
}

app.whenReady().then(() => {
  main().catch((e) => {
    console.log('失败:', e && e.message)
    app.exit(1)
  })
})
