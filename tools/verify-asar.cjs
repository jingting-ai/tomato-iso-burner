// 校验打包产物里确实含本版改动（用「列目录 + 归一化路径」而非硬拼反斜杠）
const { extractFile, listPackage } = require('@electron/asar')

const A = process.argv[2]
if (!A) {
  console.error('用法: node _verify.cjs <app.asar 路径>')
  process.exit(2)
}

// asar 在 Windows 上建的包，内部路径是反斜杠、且带前导分隔符 —— 提取时要去掉前导符
const raw = listPackage(A).map((f) => f.replace(/^[/\\]/, ''))
const files = raw.map((f) => f.replace(/\\/g, '/'))
const pick = (re) => files.filter((f) => re.test(f))

const read = (norm) => {
  const i = files.indexOf(norm)
  return extractFile(A, raw[i]).toString('utf8')
}

const mainPath = pick(/^out\/main\/index\.js$/)[0]
const cssPath = pick(/^out\/renderer\/assets\/index-.*\.css$/)[0]
const jsPath = pick(/^out\/renderer\/assets\/index-.*\.js$/)[0]
const htmlPath = pick(/^out\/renderer\/index\.html$/)[0]

console.log('asar:', A)
console.log('文件数:', files.length)

const main = read(mainPath)
const html = htmlPath ? read(htmlPath) : ''
console.log('[main] titleBarOverlay      :', main.includes('titleBarOverlay'))
console.log('[main] setTitleBarOverlay   :', main.includes('setTitleBarOverlay'))
// 反向断言：Electron 没有 getTitleBarOverlay() 这个 getter（正确写法是窗口选项），
// 以前误用过一次。标签写清楚是「反向」，免得看到 false 以为坏了。
console.log('[main] 未误用 getTitleBarOverlay(反):', !main.includes('getTitleBarOverlay'))
console.log('[main] 图标：打包后资源路径  :', main.includes('app-icon.ico'))
console.log('[main] 图标：开发态路径      :', main.includes('build/icon.ico') || main.includes('build\\icon.ico'))
console.log('[main] 识别：26200 判据      :', main.includes('26200'))
console.log('[main] 识别：家族 19041      :', main.includes('19041'))

const css = read(cssPath)
console.log('[css ] 4px 胶囊 background-clip:', css.includes('background-clip: content-box'))
console.log('[css ] 滑块默认透明          :', /::-webkit-scrollbar-thumb\s*\{[^}]*background-color:\s*transparent/.test(css))
console.log('[css ] 滚动时浮现            :', css.includes('.is-scrolling::-webkit-scrollbar-thumb'))
console.log('[css ] 悬停浮现              :', css.includes('::-webkit-scrollbar-thumb:hover'))
console.log('[css ] 滚动条配色变量        :', css.includes('--sb-thumb'), '/', css.includes('--sb-thumb-hover'))
console.log('[css ] 滚动条槽宽 12px       :', css.includes('--sb-size: 12px') || css.includes('--sb-size:12px'))

const js = read(jsPath)
console.log('[js  ] is-scrolling 逻辑     :', js.includes('is-scrolling'))
console.log('[js  ] 捕获阶段监听 scroll   :', js.includes('capture') || js.includes('!0'))
console.log('[js  ] 900ms 定时             :', js.includes('900'))

// ---- v1.2.19：关于 / 捐赠 ----
const wechatAsset = pick(/^out\/renderer\/assets\/donate-wechat-.*\.png$/)
const alipayAsset = pick(/^out\/renderer\/assets\/donate-alipay-.*\.png$/)
console.log('[asar] 微信收款码图片        :', wechatAsset.length === 1, wechatAsset[0] || '缺失')
console.log('[asar] 支付宝收款码图片      :', alipayAsset.length === 1, alipayAsset[0] || '缺失')
console.log('[js  ] 关于文案「一直免费」  :', js.includes('一直免费'))
console.log('[js  ] 捐赠文案「喝杯咖啡」  :', js.includes('喝杯咖啡'))
console.log('[js  ] 免费承诺三条          :', js.includes('没有广告') && js.includes('不用联网') && js.includes('不请'))
// 第 8 条原为「跨平台 · 双主题」；v1.2.34 去掉双平台后改叫「双主题」
console.log('[js  ] 功能一览 8 条          :',
  ['整盘镜像刻录', '镜像内容识别', '非可引导格式化', '写完即校验', '写盘安全保护', 'U 盘一键修复', '中文错误提示', '双主题']
    .every((t) => js.includes(t)))
console.log('[css ] .about 面板           :', css.includes('.about{') || css.includes('.about {'))
console.log('[css ] 收款码卡片 .qr-card   :', css.includes('.qr-card'))
console.log('[css ] 扫码放大 .qr-zoom-box :', css.includes('.qr-zoom-box'))
console.log('[css ] 关于面板滚动条常显    :', /\.about-body::-webkit-scrollbar-thumb/.test(css))

// ---- v1.2.20：内置硬盘强提醒 + 跨平台文案 + 去掉平台 chip ----
console.log('[js  ] 内置盘弹窗标题        :', js.includes('你选的是电脑内置硬盘'))
console.log('[js  ] 内置盘风险说明        :', js.includes('全部分区') && js.includes('不可恢复'))
console.log('[js  ] 二次确认文案          :', js.includes('没有需要保留的数据'))
console.log('[js  ] 确认按钮              :', js.includes('我确认，仍要使用这块内置硬盘'))
console.log('[js  ] 取消按钮（引导选U盘） :', js.includes('取消，改选 U 盘'))
console.log('[js  ] 内置盘不直接选中      :', /internal[\s\S]{0,40}removable/.test(js))
console.log('[js  ] 设备列表提示条        :', js.includes('二次确认后才允许使用'))
console.log('[css ] .danger-dialog 弹窗   :', css.includes('.danger-dialog'))
console.log('[css ] 实心红确认按钮        :', css.includes('.danger-solid'))
console.log('[css ] 内置盘警示标签        :', css.includes('.tag-warn'))
// v1.2.23 起改为负向：Linux 版还没做，跨平台文案只列 Windows / macOS
console.log('[js  ] 顶栏平台 chip 已移除  :', !/win32\s*:\s*"Windows"|win32:"Windows"/.test(js))

// ---- v1.2.21：顶栏去掉版本号 + 「关于」移到主题切换左边、两块同高 ----
console.log('[css ] 版本 chip 样式已移除  :', !css.includes('chip-version'))
console.log('[js  ] 顶栏版本号已移除     :', !js.includes('chip chip-version'))
console.log('[css ] 关于按钮与切换器同高 :', /\.btn\.about-btn\s*\{[^}]*height:\s*28px/.test(css))

// ---- v1.2.22 / v1.2.31：窗口按钮区穿模修复（换色 + 对话框避让 + 等效色微调）----
// 1) 主进程：遮罩等效色按实测微调；通道用 ipcMain.on（不是 handle）
console.log('[main] overlayMask 通道就位   :',
  /ipcMain\.on\("titlebar:overlayMask"/.test(main) && !/ipcMain\.handle\("titlebar:overlayMask"/.test(main)
)
console.log('[main] 浅色遮罩等效色 #9699a2 :', main.includes('#9699a2'))
console.log('[main] 深色遮罩等效色 #0b0e15 :', main.includes('#0b0e15'))
// 2) 预载：★ v1.2.31 起必须是异步 send。
// 旧的 sendSync 在 useLayoutEffect（浏览器绘制之前）同步等主进程应答，一旦慢/卡就把
// 渲染进程堵死在首帧之前 → 界面白屏。这是「打开全白」的成因之一，不能再退回去。
const preloadPath = pick(/^out\/preload\/index\.js$/)[0]
const preload = preloadPath ? read(preloadPath) : ''
console.log('[pre ] 遮罩通道为异步 send   :',
  /send\(IPC\.overlayMask/.test(preload) && !/sendSync\s*\(/.test(preload))
console.log('[pre ] 不再用 invoke 异步     :', !/invoke\(IPC\.overlayMask/.test(preload))
// 3) 渲染层：遮罩同步 + 对话框让开窗口按钮
// ⚠️ 不能用 js.includes('useLayoutEffect') 判断 —— React 自己的运行时里就有这个字符串。
//    v1.2.32 起用「面板自愈」的文案当指纹；★ v1.2.42 关于面板已搬去独立窗口，
//    不再有弹层需要自愈，所以改判「自愈已随弹层一起撤掉」，别让它悄悄复活。
console.log('[js  ] 关于已无弹层自愈      :', !js.includes('关于面板未落地，强制重挂一次'))
console.log('[main] 关于独立窗口已就位    :', main.includes('createAboutWindow'))
// v1.2.33 起改为「对话框整体从标题栏下方开始」（不再是右边抠 136px 的 padding-right）。
// 那条老写法会把对话框推到左边（用户原话「非常割裂」），必须反向断言它不再出现。
console.log('[css ] 对话框从标题栏下开始   :',
  /padding:\s*74px\s+18px\s+22px/.test(css)
)
console.log('[css ] 不再右抠按钮区(反)     :',
  !/\.modal-mask\s*\{[^}]*padding-right:\s*max\(18px/.test(css)
)
console.log('[css ] 顶栏仍给按钮让位       :',
  /padding-right:\s*max\(24px,\s*calc\(100%\s*-\s*env\(titlebar-area-width/.test(css)
)

// ---- v1.2.23：Beta 渠道 + 去 Linux + 开源区 + 界面 logo 统一灰底 ----
// 1) Beta：version.cjs 模板加了 APP_CHANNEL 与 versionLabel()
console.log('[js  ] Beta 渠道常量         :', /APP_CHANNEL\s*=\s*"Beta"|APP_CHANNEL:'Beta'/.test(js))
console.log('[js  ] versionLabel 标签函数 :', js.includes('versionLabel'))
console.log('[js  ] Beta 徽章渲染         :', js.includes('about-beta'))
console.log('[css ] Beta 徽章样式 .about-beta :', css.includes('.about-beta'))
// 2) ★ v1.2.34：改成 Windows 单平台 —— 界面文案里不再出现「跨平台 / Windows / macOS」
//    （「图片识别」里的 macOS 是**被识别镜像**的家族标签，不是平台支持声明，不算）
console.log('[js  ] 界面已无 macOS 文案   :',
  !js.includes('Windows / macOS')
  && !js.includes('跨平台镜像刻录工具')
  && !js.includes('跨平台 · 双主题')
  && !js.includes('macOS 请以 root 启动')
)
// v1.2.40 起副标题改成「工具介绍」并点明开源（用户原话「可以改成工具的介绍，
// 可以说明开源什么的」）；v1.2.42 起「关于」窗口里那一句也跟着改成同一句 ——
// 两处各说各的会显得像两个产品。
console.log('[js  ] 顶栏副标题=工具介绍   :', js.includes('开源免费 · 本地离线 · 把镜像写入 U 盘'))
console.log('[js  ] 关于副标题与顶栏一致  :',
  js.includes('开源免费 · 本地离线 · 把镜像写入 U 盘') &&
    !js.includes('Windows 镜像刻录工具 · 本地离线运行'))
// 3) 开源：关于面板新区块 + 外链常量 + 主进程外链处理
console.log('[js  ] 开源区标题            :', js.includes('开源') && js.includes('经得起所有人审视'))
// GITHUB_REPO_URL 为空字符串时，链接按钮那一支会被 tree-shake 掉，只留
// 「仓库地址即将公布」—— 这是有意的：不往包里塞死链。等 src/shared/links.ts
// 填了地址，按钮文案才会进包。所以这里验「链接态 / 占位态恰有一个」。
const ossLinkIn = js.includes('在 GitHub 上查看源码')
const ossPendingIn = js.includes('仓库地址即将公布')
console.log('[js  ] 开源区链接/占位恰一对一 :', ossLinkIn !== ossPendingIn,
  ossLinkIn ? '（链接态）' : ossPendingIn ? '（占位态）' : '（两个都没有！）')
console.log('[js  ] MIT 许可说明          :', js.includes('MIT') && js.includes('欢迎 Star'))
console.log('[main] 外链走系统浏览器      :',
  main.includes('setWindowOpenHandler') && main.includes('openExternal'))
console.log('[css ] .oss-link 链接样式    :', css.includes('.oss-link'))
// 4) 界面 logo 与源文件逐字节一致（源文件由 make-logo.py 生成，自带灰底自检）
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const logoAsset = pick(/^out\/renderer\/assets\/app-logo-.*\.png$/)
const srcLogo = path.join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'app-logo.png')
let logoSame = false
if (logoAsset.length === 1 && fs.existsSync(srcLogo)) {
  const md5 = (b) => crypto.createHash('md5').update(b).digest('hex')
  logoSame = md5(extractFile(A, raw[files.indexOf(logoAsset[0])])) === md5(fs.readFileSync(srcLogo))
}
console.log('[asar] 界面 logo 与源文件一致:', logoAsset.length === 1 && logoSame,
  logoAsset[0] || '缺失')
// 5) .logo / .about-logo 不再写死白底（灰底由图片自带）
console.log('[css ] 顶栏 logo 去掉白底    :',
  !/\.logo\s*\{[^}]*background:\s*#fff/.test(css))
console.log('[css ] 关于 logo 去掉白底    :',
  !/\.about-logo\s*\{[^}]*background:\s*#fff/.test(css))

/* ---- v1.2.26：窗口显示兜底 + 启动自述日志 ----
 * 这两个是「打不开」类问题的根治手段，必须确认真的进了包：
 * 少任何一条兜底，都可能又回到「进程活着但窗口不出现」。 */
console.log('[main] 启动日志模块已打进包  :',
  main.includes('startup.log') && main.includes('diagInit'))
/* ★ v1.2.30 根治「窗口全白」：窗口必须创建即显示。
   禁用 GPU 时隐藏窗口不绘制首帧 —— 这是「打不开 / 打开全白」的真凶。
   show:true 与上面四行 GPU 开关是绑定的，少一边就复发。 */
console.log('[main] 窗口创建即显示        :', /show:\s*true/.test(main))
console.log('[main] 禁用 GPU 仍在(防崩溃)  :',
  main.includes('disableHardwareAcceleration') && main.includes('disable-gpu'))
console.log('[main] 首帧信号诊断          :', main.includes('首帧已绘制'))
console.log('[main] 界面快照探针          :', main.includes('界面快照'))
console.log('[main] 渲染层日志通道        :', main.includes('diag:log'))
console.log('[main] 渲染崩溃/崩溃上报      :',
  main.includes('render-process-gone') && main.includes('uncaughtException'))
console.log('[pre ] diagLog 通道已暴露    :', preload.includes('diagLog'))
console.log('[pre ] 遮罩已无同步 IPC      :', !/sendSync\s*\(/.test(preload))
console.log('[html] 启动占位存在          :', html.includes('boot-splash'))
console.log('[js  ] 界面启动自述已注入    :',
  js.includes('界面脚本开始执行') && js.includes('React 已挂载'))
console.log('[js  ] 首帧自证(rAF)          :', js.includes('界面首帧已绘制'))
console.log('[js  ] 界面错误兜底          :', js.includes('界面出错了'))
// v1.2.41 起：打开「关于 / 捐赠」面板**不再写任何运行日志**（用户要求去掉这条噪音）。
// 三项探针全部撤掉，所以这里反过来检查它们「都没有」。
console.log('[js  ] 关于面板不写运行日志  :',
  !js.includes('打开「关于 / 捐赠」面板') &&
    !js.includes('关于面板渲染结果') &&
    !js.includes('点击「关于」入口'))

/* ---- v1.2.42：「关于 / 捐赠」独立窗口 + 顶栏统一 + 刻录过程日志 ----
 * 用户原话：「关于这个框，如果不好做，实在不行就做成单独独立的框吧，
 * 要不然一点关于，上面就很不协调」「点击捐赠就不连贯」
 * 「日志里面怎么没有写入镜像什么的日志啊」 */
// 1) 独立窗口：主进程要真的会开一个 BrowserWindow，并且三个通道都通
console.log('[main] about:open 通道        :', main.includes('about:open'))
console.log('[main] about:close 通道       :', main.includes('about:close'))
console.log('[main] about:goto 通道        :', main.includes('about:goto'))
// v1.2.44：关于窗口改用与主程序同款「合并标题栏」（用户原话「做成一个整体的框，
// 跟主程序一样」）—— 页面头部 .about-head 就是标题栏，窗口按钮叠画在它右侧
console.log('[main] 关于窗口专属换色通道   :', main.includes('titlebar:overlayMaskAbout'))
console.log('[pre ] 关于窗口换色已暴露     :', preload.includes('setOverlayMaskedAbout'))
console.log('[css ] 关于头部=62px 标题栏   :', /\.about-head\s*\{[^}]*height:\s*62px/.test(css))
console.log('[css ] 关于头部给按钮让位     :',
  /\.about-head\s*\{[^}]*env\(titlebar-area-width/.test(css))
console.log('[css ] 关于头部整条可拖动     :',
  /\.about-head\s*\{[^}]*-webkit-app-region:\s*drag/.test(css))
console.log('[css ] 页面内关闭按钮已移除(反):', !css.includes('.about-x'))
console.log('[main] 关于窗口创建即显示     :', (main.match(/show:\s*true/g) || []).length >= 2)
console.log('[pre ] openAbout 已暴露       :', preload.includes('openAbout'))
console.log('[pre ] closeAbout 已暴露      :', preload.includes('closeAbout'))
console.log('[js  ] AboutWindow 分身渲染   :', js.includes('about-win'))
console.log('[css ] 关于窗口铺满整窗       :', /\.about\.about-win\s*\{[^}]*inset:\s*0/.test(css))
// 2) 顶栏右上角统一语言：chip 与按钮同高，「关于」不再自带一个框
console.log('[css ] chip 与按钮同高 28px   :', /\.chip\s*\{[^}]*height:\s*28px/.test(css))
console.log('[css ] 关于按钮不再带框(反)   :',
  !/\.btn\.about-btn\s*\{[^}]*background:\s*var\(--line-soft\)/.test(css))
// ⚠️ 打包后是压缩过的代码：`openAbout('donate')` 的引号会变成双引号，
//    60000 会被压成 6e4。断言必须容忍这两种变形，否则会假报警。
console.log('[js  ] 捐赠入口直达捐赠区     :', /openAbout\(\s*["']donate["']\s*\)/.test(js))
// 4) 刻录过程日志：写入 / 校验每 10% 一条 + 60 秒心跳
console.log('[main] 写入进度日志 progressLine:', main.includes('progressLine'))
console.log('[main] 进度日志文案 已写入/已校验:', main.includes('已写入') && main.includes('已校验'))
console.log('[main] 进度日志 60s 心跳      :', /6e4|60000/.test(main))
console.log('[main] 任务开始首条日志       :', main.includes('刻录任务开始'))

/* ---- v1.2.45：U 盘修复进程序（不再只靠发布包里那个独立的修复工具）---- */
console.log('[main] repair:list 通道       :', main.includes('repair:list'))
console.log('[main] repair:start 通道      :', main.includes('repair:start'))
console.log('[main] 修复脚本解析函数       :', main.includes('resolveRepairScript') || main.includes('repair.ps1'))
console.log('[pre ] listRepairDisks 已暴露 :', preload.includes('listRepairDisks'))
console.log('[pre ] startRepair 已暴露     :', preload.includes('startRepair'))
/* ---- v1.2.52：U 盘还原搬进独立窗口（用户：「单独弹出来一个窗口吧」）---- */
console.log('[main] restore:open 通道      :', main.includes('restore:open'))
console.log('[main] restore:close 通道     :', main.includes('restore:close'))
console.log('[pre ] openRestore 已暴露     :', preload.includes('openRestore'))
console.log('[js  ] 还原窗口标题/副标题    :', js.includes('选择要还原的 U 盘') && js.includes('将 U 盘还原到初始空 U 盘'))
console.log('[js  ] 还原开始按钮           :', js.includes('开始还原'))
console.log('[js  ] 还原默认 NTFS+番茄U盘  :', js.includes('番茄U盘'))
console.log('[js  ] 模式下拉已无还原项(反) :', !js.includes('U 盘还原（把读不出'))
console.log('[css ] 还原窗口样式           :', css.includes('.restore-head') && css.includes('.restore-body'))
console.log('[js  ] 深度扫描入口           :', js.includes('深度扫描'))
console.log('[css ] 修复四步已收纳(反)     :', !css.includes('.repair-steps'))
console.log('[css ] 深度扫描提示样式       :', css.includes('.deep-scan-msg'))
console.log('[js  ] 诊断调用均带可选链    :',
  !/(?<!\?\.)\bapi\.diagLog\(/.test(js))
