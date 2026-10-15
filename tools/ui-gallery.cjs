// 出「界面效果图」用：一次跑完主界面、设备列表、内置硬盘强提醒、关于面板。
// 只建一个离屏窗口、只加载一次页面，之后靠改 data-theme 与点击切换场景。
//   用法：npx electron tools/ui-gallery.cjs
//        TOMATO_PAGE=<asar 内页面> 可验证打包后的那份资源
//   产物：dist/_uicheck/gallery/*.png
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
// TOMATO_OUT 可把产物写到别处（例如用部署后的 asar 页面做验证时，避免覆盖正式效果图）
const OUT = process.env.TOMATO_OUT || path.join(ROOT, 'dist', '_uicheck', 'gallery')
// 默认加载本地产物；TOMATO_PAGE 可指向部署后的 app.asar 内部页面，
// 用来验证「打包出去的那份」在真机上确实能渲染（含新增的收款码图片）。
const PAGE = process.env.TOMATO_PAGE || path.join(ROOT, 'out', 'renderer', 'index.html')
const VERSION = process.env.TOMATO_SHOT_VERSION || require(path.join(ROOT, 'package.json')).version
// TOMATO_HASH=about|donate —— 「关于 / 捐赠」现在是**独立窗口**，同一个渲染层
// 靠 URL 的 hash 切换身份（见 src/renderer/src/main.tsx）。配这个变量再跑一次，
// 就能用同一个离屏窗口截到那个独立窗口的内容。
const HASH = (process.env.TOMATO_HASH || '').replace(/^#/, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const W = Number(process.env.TOMATO_SHOT_W || 1000)
const H = Number(process.env.TOMATO_SHOT_H || 1000)

const N = (suffix) => `界面效果-${VERSION}${suffix}.png`

async function main() {
  process.on('unhandledRejection', (e) => console.log('  [忽略] ' + (e && e.message)))
  fs.mkdirSync(OUT, { recursive: true })

  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    offscreen: true,
    // 离屏窗口也挂上真的窗口按钮叠层：这样 env(titlebar-area-width) 能解析出 136px，
    // 顶栏（.topbar）的 padding-right 让位规则才会生效，截图才和真机一致。
    // ⚠️ v1.2.33 起 .modal-mask 不再靠 padding-right 让位（改成整体从标题栏下方开始），
    //    所以这里补的 padding-right 只对顶栏有意义，不会再影响对话框位置。
    // 叠层本身离屏截不到，视觉上仍由下面注入的 #wco 假 div 充当。
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#ffffff', symbolColor: '#22262f', height: 62 }
        }
      : {}),
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

  // hash 走选项传，不要拼在路径里 —— loadFile 的第二个参数才认它
  await win.loadFile(PAGE, HASH ? { hash: HASH } : {})
  await sleep(900)

  // 走完整的「选镜像 → 识别 → 自动推荐」流程，让界面进入有内容的状态。
  // 配了 TOMATO_SHOT_PROBE_DELAY 时识别会故意慢下来，「识别中」那一态稍后单独截。
  await win.webContents.executeJavaScript(
    `(function(){ var el=document.querySelector('.dropzone'); if(el) el.click(); return !!el })()`
  )

  // 模拟 Windows 叠画的窗口按钮：右侧让出 136px，并画出三个按钮。
  // 底色必须和真实 overlay 一致（浅色 #fff / 深色 #171a21），
  // 并且要跟随 html[data-masked] —— 真机上这一块是系统独立图层，
  // 网页里的遮罩压不到它，靠主进程 setTitleBarOverlay 换色；
  // 遮罩等效色与主进程 OVERLAY_*_MASKED 保持一致（浅色 #9699a2 / 深色 #0b0e15）。
  // 这里这么写，是为了离屏也能复现 / 验证「弹窗打开时右上角留一块亮斑」那个 bug。
  await win.webContents.executeJavaScript(`(function(){
    var tb=document.querySelector('.topbar')||document.querySelector('.about-head')||document.querySelector('.restore-head');
    // 「关于」「U 盘还原」窗口现在也是合并标题栏（.about-head / .restore-head 顶到窗口顶），同样要画假按钮
    if(!tb) return false;
    tb.style.paddingRight='136px';
    var st=document.createElement('style');
    st.textContent=
      '#wco{background:#ffffff}'+
      'html[data-theme=dark] #wco{background:#171a21}'+
      'html[data-masked="1"] #wco{background:#9699a2}'+
      'html[data-theme=dark][data-masked="1"] #wco{background:#0b0e15}';
    document.head.appendChild(st);
    var h=Math.round(tb.getBoundingClientRect().height)-1;   // 与主进程 OVERLAY_H 一致（叠层比顶栏矮 1px，让分隔线露出来）
    var box=document.createElement('div');
    box.id='wco';
    box.style.cssText='position:fixed;top:0;right:0;width:136px;height:'+h+
      'px;z-index:99999;pointer-events:none;display:flex;align-items:stretch';
    var cell=function(inner){return '<div style="flex:1;display:flex;align-items:center;'+
      'justify-content:center">'+inner+'</div>'};
    var s='stroke="currentColor" stroke-width="1" fill="none"';
    box.innerHTML=
      cell('<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" '+s+'/></svg>')+
      cell('<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" '+s+'/></svg>')+
      cell('<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" '+s+'/></svg>');
    document.body.appendChild(box);
    return true })()`)

  const setTheme = (t) =>
    win.webContents.executeJavaScript(
      `(function(){ document.documentElement.setAttribute('data-theme','${t}');` +
        `var b=document.getElementById('wco'); if(b) b.style.color=('${t}'==='dark'?'#e7eaf0':'#22262f');` +
        `return true })()`
    )
  const shot = async (name) => {
    await sleep(260)
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, name), img.toPNG())
    console.log('  ->', name)
  }
  const js = (code) => win.webContents.executeJavaScript(`(function(){${code}})()`)
  /** 把「选择目标磁盘」那张卡滚到视口顶部，方便截设备列表 */
  const scrollToDevices = () =>
    js(
      `var sc=document.querySelector('.content-scroll');` +
        `var card=[].slice.call(document.querySelectorAll('.card'))` +
        `.filter(function(c){return c.textContent.indexOf('选择目标磁盘')>=0})[0];` +
        `if(card) sc.scrollTop += card.getBoundingClientRect().top - 14; return true`
    )

  // ---------- 「U 盘还原」独立窗口（v1.2.52：用户「单独弹出来一个窗口吧」）----------
  // 它和「关于」一样靠 hash 分身，配 TOMATO_HASH=restore 再跑一次就能截到。
  if (HASH === 'restore') {
    console.log('U 盘还原窗口（#restore）')
    await setTheme('light')
    await sleep(420)
    // 自检：默认只列 U 盘（内置/系统盘被过滤）、默认 NTFS、卷标「番茄U盘」
    const rs = await js(
      `return {` +
        `设备数: document.querySelectorAll('.device').length,` +
        `有内置硬盘标签: [].slice.call(document.querySelectorAll('.device .tag')).some(function(e){return e.textContent.indexOf('内置硬盘')>=0}),` +
        `默认文件系统: (document.querySelector('.seg-btn.active .seg-title')||{}).textContent,` +
        `卷标: (document.getElementById('vol-label')||{}).value,` +
        `开始按钮: (document.querySelector('.btn.primary.block')||{}).textContent` +
        `}`
    )
    console.log('  还原窗口自检:', JSON.stringify(rs))
    await shot(N('-还原窗口'))
    // 选一块 U 盘 → 出现危险横幅；勾选确认后「开始还原」才亮
    await js(
      `(function(){ var rows=[].slice.call(document.querySelectorAll('.device'));` +
        `if(rows[0]) rows[0].click(); return !!rows[0] })()`
    )
    await sleep(320)
    await js(
      `(function(){ var c=document.querySelector('.switch.danger input');` +
        `if(c && !c.checked) c.click(); return true })()`
    )
    await sleep(260)
    await shot(N('-还原窗口-已确认'))
    // 点「开始还原」→ 进入还原中（离屏假实现不会真的跑脚本），
    // 顺便验证日志面板默认是收起的
    await js(
      `(function(){ var b=document.querySelector('.btn.primary.block');` +
        `if(b && !b.disabled) b.click(); return !!b })()`
    )
    await sleep(420)
    const burning = await js(
      `return {` +
        `有进度卡: !!document.querySelector('.burn'),` +
        `日志默认收起: !!document.querySelector('.log-card.collapsed'),` +
        `阶段文案: (document.querySelector('.burn-title')||{}).textContent` +
        `}`
    )
    console.log('  还原中自检:', JSON.stringify(burning))
    await shot(N('-还原中'))
    await setTheme('dark')
    await sleep(300)
    await shot(N('-还原窗口-深色'))
    win.destroy()
    console.log('done')
    app.exit(0)
    return
  }

  // ---------- 「关于 / 捐赠」独立窗口 ----------
  // 它已经不是叠在主界面上的弹层，而是一个真窗口；同一个渲染层靠 hash 分身，
  // 所以配 TOMATO_HASH=about / donate 再跑一次就能截到。
  if (HASH) {
    console.log(`关于窗口（#${HASH}）`)
    await setTheme('light')
    await sleep(320)
    await shot(N('-关于窗口' + (HASH === 'donate' ? '-捐赠区' : '')))
    // 滚到底看捐赠区（顺便验证滚动确实在 .about-body 里发生）
    await js(`var b=document.querySelector('.about-body'); if(b) b.scrollTop=b.scrollHeight; return !!b`)
    await sleep(420)
    await shot(N('-关于窗口-捐赠区'))
    // 收款码放大：这一步顺便验证 fixed 定位是对的（独立窗口里不再有
    // backdrop-filter 祖先把它变成包含块）
    await js(`var b=document.querySelector('.qr-card.wechat .qr-shot'); if(b) b.click(); return !!b`)
    await sleep(420)
    await shot(N('-收款码放大'))
    await js(`var m=document.querySelector('.qr-zoom-mask'); if(m) m.click(); return !!m`)
    await sleep(300)
    await js(`var b=document.querySelector('.about-body'); if(b) b.scrollTop=0; return !!b`)
    await sleep(300)
    await setTheme('dark')
    await sleep(300)
    await shot(N('-关于窗口-深色'))
    win.destroy()
    console.log('done')
    app.exit(0)
    return
  }

  await setTheme('light')

  // 「识别中」那一态：只有配了 TOMATO_SHOT_PROBE_DELAY 才截得到（否则识别已经跑完了）
  const PROBE_DELAY = Number(process.env.TOMATO_SHOT_PROBE_DELAY || 0)
  if (PROBE_DELAY >= 1200) {
    await shot(N('-识别中'))
    await setTheme('dark')
    await shot(N('-识别中-深色'))
    await setTheme('light')
    await sleep(PROBE_DELAY)
  }

  await shot(N(''))

  // 顶栏副标题有没有被省略号截掉（窗口最窄 880 时最容易出事）
  const sub = await js(
    `var e=document.querySelector('.brand-sub'); if(!e) return null;` +
      `return {w: Math.round(e.clientWidth), need: Math.round(e.scrollWidth), text: e.textContent}`
  )
  if (sub) console.log('  副标题: 可用', sub.w, 'px / 需要', sub.need, 'px', sub.need > sub.w ? '★被截断' : 'OK')

  // ---------- 顶栏「U 盘还原」按钮自检（v1.2.52 起改为开独立窗口） ----------
  // 离屏环境里 openRestore 是假实现（noop），开不出真窗口；这里验的是
  // ① 按钮还在；② 点了不会把主界面切成还原模式（模式下拉只剩 dd / format）。
  const rep = await win.webContents.executeJavaScript(
    `(async function(){` +
      `var b=document.querySelector('.repair-btn'); if(!b) return {btn:false};` +
      `b.click(); await new Promise(function(r){setTimeout(r,320)});` +
      `var opts=[].slice.call(document.getElementById('mode-select').options).map(function(o){return o.value});` +
      // 主界面根节点是 .app（还原窗口是 .restore-win）：它还在，就说明没被切走。
      // ⚠️ 不能拿 .dropzone 判断 —— gallery 开头已经选过镜像，那一块早就换成文件卡了。
      `var stillMain=!!document.querySelector('.app');` +
      `var q=!!b.querySelector('.hint');` +
      `return {btn:true, 模式选项:opts, 主界面没被切走:stillMain, 有问号提示:q}` +
    `})()`
  )
  console.log('  顶栏还原按钮自检:', JSON.stringify(rep))

  // ---------- 「模式」旁边的 ? 提示：默认收纳，鼠标移上去才弹出来 ----------
  // 用真实鼠标移动触发 :hover（合成事件骗不过 CSS）
  const hr = await js(
    `var e=document.querySelector('.hint .hint-q'); if(!e) return null;` +
      `var r=e.getBoundingClientRect();` +
      `return {x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}`
  )
  if (hr) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: hr.x, y: hr.y })
    await sleep(460)
    await shot(N('-模式提示'))
    await setTheme('dark')
    await shot(N('-模式提示-深色'))
    await setTheme('light')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
    await sleep(200)
  } else {
    console.log('  !! 没找到 .hint .hint-q，模式提示截图跳过')
  }

  // ---------- 设备列表：打开「显示内置磁盘」，看内置盘的警示标签与提示 ----------
  await js(
    `var cb=document.querySelector('.head-actions input[type=checkbox]'); if(cb) cb.click(); return true`
  )
  await scrollToDevices()
  await sleep(300)
  await shot(N('-设备列表-内置硬盘'))
  // 自检：USB 接口版本的标签有没有渲染出来（离屏假数据里给了 USB 3.0 / USB 2.0 两块）
  const devCheck = await js(
    `return {` +
      `usbTags: [].slice.call(document.querySelectorAll('.device .tag')).map(function(e){return e.textContent.trim()}).filter(function(t){return /USB/.test(t)})` +
      `}`
  )
  console.log('  设备列表自检:', JSON.stringify(devCheck))

  // ---------- 深度扫描提示：要出现、下缘留间隙、5 秒后自动消失 ----------
  const scan = await win.webContents.executeJavaScript(
    `(async function(){` +
      `var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return x.textContent.trim()==='深度扫描'})[0];` +
      `if(!b) return {btn:false};` +
      `b.click(); await new Promise(function(r){setTimeout(r,600)});` +
      `var m=document.querySelector('.deep-scan-msg');` +
      `if(!m) return {btn:true, appeared:false};` +
      `var gap=getComputedStyle(m).marginBottom;` +
      `await new Promise(function(r){setTimeout(r,5300)});` +
      `return {btn:true, appeared:true, 下边距:gap, 五秒后消失:!document.querySelector('.deep-scan-msg')}` +
    `})()`
  )
  console.log('  深度扫描提示自检:', JSON.stringify(scan))


  // ---------- 点内置盘 → 弹强提醒 ----------
  await js(
    `var rows=[].slice.call(document.querySelectorAll('.device'));` +
      `var r=rows.filter(function(e){return e.querySelector('.tag-warn')})[0];` +
      `if(r) r.click(); return !!r`
  )
  await sleep(460)
  await shot(N('-内置硬盘提醒'))

  // 勾选二次确认后，确认按钮才亮起来
  await js(
    `var c=document.querySelector('.danger-ack input'); if(c) c.click(); return true`
  )
  await sleep(240)
  await shot(N('-内置硬盘提醒-已确认'))

  await setTheme('dark')
  await sleep(200)
  await shot(N('-内置硬盘提醒-深色'))

  // 关掉提醒弹窗，回到正常界面
  await setTheme('light')
  await js(
    `var b=document.querySelector('.danger-actions .btn.ghost'); if(b) b.click(); return true`
  )
  await sleep(280)

  await setTheme('dark')
  await scrollToDevices()
  await sleep(200)
  await shot(N('-深色'))

  // ---------- 点「开始刻录」→ 日志面板这时候才登场 ----------
  // （「关于 / 捐赠」已搬去独立窗口，用 TOMATO_HASH=about 另跑一次截它）
  await setTheme('light')
  await sleep(200)
  // 先挑一个 U 盘（前面点过内置盘又取消了，selected 还是空的）
  await win.webContents.executeJavaScript(
    `(function(){ var rows=[].slice.call(document.querySelectorAll('.device'));` +
      `var usb=rows.filter(function(e){return !e.querySelector('.tag-warn')})[0];` +
      `if(usb) usb.click(); return !!usb })()`
  )
  await sleep(260)
  await win.webContents.executeJavaScript(
    `(function(){ var c=document.querySelector('.switch.danger input');` +
      `if(c && !c.checked) c.click(); return true })()`
  )
  await sleep(220)
  const started = await win.webContents.executeJavaScript(
    `(function(){ var b=document.querySelector('.btn.primary.block');` +
      `if(b){ b.click(); return !b.disabled } return 'no-button' })()`
  )
  console.log('  开始刻录按钮可点:', started)
  await sleep(900)
  await shot(N('-刻录中'))

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
