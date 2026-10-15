// UI 自检：加载真实构建产物，注入假 api 走完整的「选镜像 → 识别 → 自动推荐写入方式」流程后截图。
// 可见窗口在本环境起不来，离屏渲染可以。
//   用法：  npx electron tools/ui-shot.cjs [light|dark|both]
//   产物：  dist/_uicheck/ui-light.png、ui-dark.png
// 与 tools/shot.cjs 的区别：shot.cjs 不注入数据，只验证空状态能渲染。
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
// 场景由 TOMATO_SHOT_SCENARIO 决定（见 ui-shot-preload.cjs）；
// 需要多跑几个场景时用 TOMATO_SHOT_SUFFIX 给产物名加后缀，避免互相覆盖。
const SUFFIX = process.env.TOMATO_SHOT_SUFFIX || ''
// 窗口宽度可配：用来检查最窄（880）到常见宽度下顶栏会不会被窗口按钮挤坏
const SHOT_W = Number(process.env.TOMATO_SHOT_W) || 1000
// 窗口高度可配：验证滚动条时需要让内容确定溢出
const SHOT_H = Number(process.env.TOMATO_SHOT_H) || 1500
// 滚动条取样：active = 滚一下再截（滑块应浮现）；idle = 静止截（滑块应不可见）
const SB_MODE = process.env.TOMATO_SHOT_SB || ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function capture(theme, file) {
  const outFile = file.replace(/\.png$/, `${SUFFIX}.png`)
  const win = new BrowserWindow({
    width: SHOT_W,
    height: SHOT_H,
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
    if (level >= 2) console.log('[renderer]', message)
  })

  const page = path.join(ROOT, 'out', 'renderer', 'index.html')
  await win.loadFile(page)
  await sleep(500)

  // 先写入主题偏好，再重新加载页面，让 React 初始化时就读到它
  await win.webContents.executeJavaScript(`localStorage.setItem('tomato.theme', '${theme}'); true`)
  await win.loadFile(page).catch(() => undefined)
  await sleep(900)

  // 点一下镜像选择框：走完整的 stat → probe → 自动推荐链路
  await win.webContents.executeJavaScript(
    `(function(){var el=document.querySelector('.dropzone'); if(el){el.click();} return !!el})()`
  )
  await sleep(1500)

  const info = await win.webContents.executeJavaScript(
    `(function(){
       var cards=[].map.call(document.querySelectorAll('.card'),function(c){
         var h=c.querySelector('.card-head h2');
         return (c.querySelector('.step-badge')||{}).textContent+':'+(h?h.textContent:'?');
       });
       return {
         theme: document.documentElement.getAttribute('data-theme'),
         cards: cards,
         mode: (document.getElementById('mode-select')||{}).value,
         autoTag: !!document.querySelector('.mode-auto'),
         divider: !!document.querySelector('.block-divider')
       };
     })()`
  )
  console.log(outFile, JSON.stringify(info))

  // 无头环境看不到系统叠画的窗口按钮：默认画一块半透明标记，用来目视检查顶栏有没有被盖住；
  // TOMATO_SHOT_WCO=real 时改画成真实的三个窗口按钮，用来出「界面效果图」。
  const realWco = process.env.TOMATO_SHOT_WCO === 'real'
  const wco = await win.webContents.executeJavaScript(
    `(function(){
       var tb=document.querySelector('.topbar');
       var tr=document.querySelector('.topbar-right');
       var btnW=136; // Windows 上实测的窗口按钮区宽度
       // 离屏窗口没启用窗口按钮叠层，env(titlebar-area-width) 不存在 → padding 会回落到 24px。
       // 这里按真实值模拟一次，才测得出顶栏会不会被窗口按钮挤坏。
       tb.style.paddingRight=btnW+'px';
       var r=tr.getBoundingClientRect();
       var tbR=tb.getBoundingClientRect();
       var real=${realWco};
       var dark=document.documentElement.getAttribute('data-theme')==='dark';
       var h=Math.round(tbR.height);
       var box=document.createElement('div');
       box.style.cssText='position:fixed;top:0;right:0;width:'+btnW+'px;height:'+h+
         'px;z-index:99999;pointer-events:none;display:flex;align-items:stretch';
       if(real){
         box.style.color = dark ? '#e7eaf0' : '#22262f';
         var cell=function(inner){return '<div style="flex:1;display:flex;align-items:center;'+
           'justify-content:center">'+inner+'</div>'};
         var st='stroke="currentColor" stroke-width="1" fill="none"';
         box.innerHTML=
           cell('<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" '+st+'/></svg>')+
           cell('<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" '+st+'/></svg>')+
           cell('<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" '+st+'/></svg>');
       }else{
         box.style.background='rgba(255,0,0,.15)';
         box.style.borderLeft='1px dashed rgba(255,0,0,.7)';
         box.style.alignItems='center';
         box.style.justifyContent='center';
         box.style.font='10px/1.2 sans-serif';
         box.style.color='#d00';
         box.style.textAlign='center';
         box.textContent='窗口按钮区 '+btnW+'px';
       }
       document.body.appendChild(box);
       return {
         topbarH: h,
         paddingRight: getComputedStyle(tb).paddingRight,
         topbarOverflow: tb.scrollWidth > tb.clientWidth + 1,
         rightEdgeOfChips: Math.round(r.right),
         windowW: window.innerWidth,
         buttonsStartAt: window.innerWidth - btnW,
         chipsCoveredByButtons: r.right > window.innerWidth - btnW,
         brandSubShown: (function(){var s=document.querySelector('.brand-sub');
           return s ? Math.round(s.getBoundingClientRect().width) : 0})(),
         brandSubEllipsis: (function(){var s=document.querySelector('.brand-sub');
           return s ? s.scrollWidth > s.clientWidth + 1 : null})(),
         rightContentW: tr.scrollWidth,
         rightClientW: tr.clientWidth,
         rightClipped: tr.scrollWidth > tr.clientWidth + 1,
         hasElevateBtn: !!document.querySelector('.topbar .btn'),
         freeSpace: Math.round(window.innerWidth - btnW - r.right)
       };
     })()`
  )
  console.log('  顶栏检查:', JSON.stringify(wco))

  // 滚动条取样：量滑块槽宽度；active/after 会先滚一下，hover 会把鼠标移到滚动条槽上
  //   active → 滚动后立刻截（滑块应浮现）
  //   after  → 滚动后静置 1.3 秒再截（滑块应已随「不动时隐藏」淡出）
  //   hover  → 鼠标移到右侧槽上，检查「鼠标靠近也能露出来」
  if (SB_MODE) {
    const doScroll = SB_MODE === 'active' || SB_MODE === 'after'
    const sb = await win.webContents.executeJavaScript(
      `(function(){
         window.__mm = 0;
         document.addEventListener('mousemove', function(){ window.__mm++ });
         var el=document.querySelector('.content-scroll');
         if(!el) return null;
         var gutter = el.offsetWidth - el.clientWidth;
         var over = el.scrollHeight - el.clientHeight;
         if (${doScroll}) el.scrollTop = el.scrollHeight;
         return { gutterW: gutter, overflowPx: over, innerW: window.innerWidth };
       })()`
    )
    if (SB_MODE === 'hover') {
      // 先移到内容中间，再移到最右侧滚动条槽上（坐标是逻辑像素）
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 400, y: 300 })
      await sleep(120)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: sb.innerW - 5, y: 300 })
      await sleep(400)
      const hit = await win.webContents.executeJavaScript(
        `(function(){ var e=document.elementFromPoint(${sb.innerW - 5}, 300);
           return { mousemoves: window.__mm, elem: e ? (e.className||e.tagName) : null }; })()`
      )
      console.log('  鼠标命中检查:', JSON.stringify(hit))
    }
    await sleep(doScroll ? (SB_MODE === 'active' ? 260 : 1300) : 900)
    const cls = await win.webContents.executeJavaScript(
      `(function(){var el=document.querySelector('.content-scroll');
        return { scrollingClass: el.classList.contains('is-scrolling'),
                 scrollTop: Math.round(el.scrollTop) };})()`
    )
    console.log('  滚动条检查:', JSON.stringify(Object.assign({}, sb, cls)))
  }

  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(OUT, outFile), img.toPNG())
  win.destroy()
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const which = process.argv[2] || 'both'
  if (which === 'light' || which === 'both') await capture('light', 'ui-light.png')
  if (which === 'dark' || which === 'both') await capture('dark', 'ui-dark.png')
  console.log('done')
  app.exit(0)
})
