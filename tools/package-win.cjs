/**
 * Windows 便携版（绿色版）打包。
 *
 * 直接以 electron-builder 的 `dist/win-unpacked/` 为源，整树复制即可 —— 它已经包含：
 *   - 打过图标的 `番茄镜像刻录工具.exe`（rcedit 写入 build/icon.ico）
 *   - Electron 运行时、locales、各 dll
 *   - resources/app.asar
 *   - resources/app.asar.unpacked/**（asarUnpack 项）
 *   - resources/burn.ps1（extraResources 项）
 *   - resources/elevate.exe、resources/app-icon.ico
 *
 * 所以不需要再手工拼装。早期那套「从 node_modules/electron/dist 复制 + 逐个补文件」
 * 的做法漏过 burnWorker.js，导致绿色版一点「开始刻录」就失败（v1.2.12 修过），
 * 且 exe 图标停留在 Electron 默认图标。整树复制这两类问题都不存在。
 *
 * 前置：先跑 `npx electron-builder --win --x64`
 * 用法：node tools/package-win.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

/**
 * 递归整树复制。
 *
 * 不用 fs.cpSync：在部分受限环境里它对这么大的树（三百多 MB、含符号链接）
 * 会被直接掐断（进程无输出退出），逐文件 copyFileSync 反而稳。
 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d)
    else fs.copyFileSync(s, d)
  }
}

const root = path.join(__dirname, '..')
const appName = '番茄镜像刻录工具'
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version || '0.0.0'
const outDir = path.join(root, 'dist')
const srcDir = path.join(outDir, 'win-unpacked')
const winDir = path.join(outDir, `TomatoIsoBurner-win32-x64-v${version}`)

/** 读取自动生成的版本常量文件（由 tools/version.cjs 维护） */
function versionMeta() {
  const p = path.join(root, 'src', 'shared', 'version.ts')
  const pick = (key) => {
    const m = fs.existsSync(p)
      ? fs.readFileSync(p, 'utf8').match(new RegExp(`${key} = '([^']*)'`))
      : null
    return m ? m[1] : ''
  }
  return {
    build: pick('APP_BUILD'),
    buildTime: pick('APP_BUILD_TIME'),
    author: pick('APP_AUTHOR')
  }
}

/** 绿色版必须存在的文件：少任何一个都会在真机上出问题，宁可在打包时就炸掉 */
const REQUIRED = [
  `${appName}.exe`,
  'resources/app.asar',
  'resources/burn.ps1', // 写盘脚本（asar 之外，主进程直接调用）
  'resources/app.asar.unpacked/out/main/burnWorker.js' // 写盘 Worker 不能从 asar 里加载
]

function main() {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`未找到 ${srcDir} —— 请先运行：npx electron-builder --win --x64`)
  }

  console.log('源：', srcDir)
  fs.rmSync(winDir, { recursive: true, force: true })
  fs.mkdirSync(winDir, { recursive: true })
  copyTree(srcDir, winDir)

  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(winDir, ...f.split('/'))))
  if (missing.length) {
    throw new Error('绿色版缺少关键文件：' + missing.join('、'))
  }
  console.log('自检：关键文件齐全（' + REQUIRED.length + ' 项）')

  const meta = versionMeta()
  fs.writeFileSync(
    path.join(winDir, 'VERSION.txt'),
    [
      appName,
      `版本：v${version}`,
      `构建号：${meta.build || '-'}`,
      `构建时间：${meta.buildTime || '-'}`,
      `开发者：${meta.author || '敬亭'}`,
      `平台：Windows x64`
    ].join('\n'),
    'utf8'
  )

  const size = (f) => (fs.existsSync(f) ? (fs.statSync(f).size / 1024 / 1024).toFixed(1) + ' MB' : '—')
  console.log('\n完成：', winDir)
  console.log('版本：v' + version, '| 构建：', meta.build || '-')
  console.log('主程序：', size(path.join(winDir, `${appName}.exe`)))
  console.log('app.asar：', size(path.join(winDir, 'resources', 'app.asar')))
}

main()
