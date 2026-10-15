// 检查某个 app.asar 里是否包含 WCO 遮罩修复（titlebar:overlayMask）
// 路径处理照 verify-asar.cjs：listPackage 出来的是带前导符的反斜杠，提取时用原样
const { extractFile, listPackage } = require('@electron/asar')

const p = process.argv[2]
const raw = listPackage(p).map((f) => f.replace(/^[/\\]/, ''))
const files = raw.map((f) => f.replace(/\\/g, '/'))
const read = (norm) => extractFile(p, raw[files.indexOf(norm)]).toString('utf8')
const has = (s, k) => (s.includes(k) ? '有' : '无')

const m = read('out/main/index.js')
console.log('主进程  titlebar:overlayMask :', has(m, 'titlebar:overlayMask'))
console.log('主进程  OVERLAY_LIGHT_MASKED :', has(m, 'OVERLAY_LIGHT_MASKED'))
console.log('预载    setOverlayMasked     :', has(read('out/preload/index.js'), 'setOverlayMasked'))

const r = files.filter((f) => /out\/renderer\/.*\.js$/.test(f))
const jsAll = r.map(read).join('\n')
console.log('渲染层  setOverlayMasked     :', has(jsAll, 'setOverlayMasked'))
console.log('渲染层  初始不展日志         :', has(jsAll, 'logCollapsed'))
