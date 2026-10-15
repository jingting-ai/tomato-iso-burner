// 诊断：离屏窗口 + titleBarOverlay 时 env(titlebar-area-width) 到底解析成多少
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const ROOT = path.join(__dirname, '..')
  const probe = (label, opts) =>
    new Promise((resolve) => {
      let win
      try {
        win = new BrowserWindow({
          width: 1000,
          height: 1000,
          show: false,
          offscreen: true,
          ...opts,
          webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: false }
        })
      } catch (e) {
        console.log(label, 'CREATE-FAILED:', e.message)
        return resolve()
      }
      win.webContents.on('did-finish-load', async () => {
        try {
          const r = await win.webContents.executeJavaScript(`(function(){
            var d=document.createElement('div');
            d.style.width='env(titlebar-area-width)';
            document.body.appendChild(d);
            var w=getComputedStyle(d).width;
            var d2=document.createElement('div');
            d2.style.width='env(titlebar-area-x)';
            document.body.appendChild(d2);
            var x=getComputedStyle(d2).width;
            return { innerWidth: window.innerWidth, innerHeight: window.innerHeight,
                     dpr: window.devicePixelRatio, areaWidth: w, areaX: x }
          })()`)
          console.log(label, JSON.stringify(r))
        } catch (e) {
          console.log(label, 'JS-FAILED:', e.message)
        }
        win.destroy()
        resolve()
      })
      win.webContents.on('did-fail-load', (_e, code, desc) => {
        console.log(label, 'LOAD-FAILED:', code, desc)
        resolve()
      })
      win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
    })

  await probe('plain-offscreen        ', {})
  await probe('hidden+overlay(h=62)   ', {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#22262f', height: 62 }
  })
  app.exit(0)
})
