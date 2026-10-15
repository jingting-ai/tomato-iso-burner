// 冒烟：离屏加载渲染页面并截图，用于确认 UI 能正常渲染（非应用运行时依赖）
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000,
    height: 1100,
    show: false,
    offscreen: true,
    webPreferences: { offscreen: true }
  })

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer error]', message)
  })

  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1200))
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(__dirname, '..', 'screenshot.png'), img.toPNG())
  console.log('screenshot saved')
  app.quit()
})
