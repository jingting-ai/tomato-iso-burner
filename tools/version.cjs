/**
 * 版本号管理：源码有改动时自动递增，并同步生成版本信息文件与更新日志。
 *
 * 用法：
 *   node tools/version.cjs auto            # 自动：仅当源码相对上次记录有变化时才 patch +1（默认）
 *   node tools/version.cjs auto --note "说明"
 *   node tools/version.cjs patch|minor|major [--note "说明"]   # 强制按语义递增
 *   node tools/version.cjs sync            # 只刷新版本信息文件，不改版本号
 *
 * 产物：
 *   package.json          version 字段
 *   src/shared/version.ts 应用内展示用的版本常量（自动生成，勿手改）
 *   version-state.json    源码快照哈希 + 版本历史
 *   CHANGELOG.md          更新日志
 *
 * 约定：`npm run build` 会通过 prebuild 钩子自动执行 `auto`，
 * 因此每次功能改进后重新构建/打包，版本号都会自动 +1。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.join(__dirname, '..')
const APP_NAME = '番茄镜像刻录工具'
const APP_AUTHOR = '敬亭'
// 发布渠道：Alpha / Beta / RC；留空表示正式版。界面上的版本徽章、页脚、
// 窗口标题都会带上它（用户 2026-10-13：「把版本那里加个 Beta 会好点」）。
const APP_CHANNEL = 'Beta'

const pkgPath = path.join(root, 'package.json')
const statePath = path.join(root, 'version-state.json')
const changelogPath = path.join(root, 'CHANGELOG.md')
const generatedPath = path.join(root, 'src', 'shared', 'version.ts')

/* --------------------------- 参数解析 --------------------------- */
const argv = process.argv.slice(2)
const mode = (argv.find((a) => !a.startsWith('--')) || 'auto').toLowerCase()
let note = ''
const noteIdx = argv.indexOf('--note')
if (noteIdx >= 0 && argv[noteIdx + 1]) note = argv[noteIdx + 1]

if (!['auto', 'patch', 'minor', 'major', 'sync'].includes(mode)) {
  console.error('未知模式：', mode, '（可选 auto / patch / minor / major / sync）')
  process.exit(1)
}

/* --------------------------- 工具函数 --------------------------- */
function pad(n) {
  return String(n).padStart(2, '0')
}

function nowStamp() {
  const d = new Date()
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    iso: d.toISOString(),
    build: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.${pad(d.getHours())}${pad(d.getMinutes())}`
  }
}

function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** 遍历源码目录，计算内容快照哈希（排除自动生成的文件） */
function walk(dir, base, out) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    const rel = path.join(base, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walk(abs, rel, out)
    } else if (entry.isFile()) {
      out.push(rel.replace(/\\/g, '/'))
    }
  }
}

function srcHash() {
  const files = []
  walk(path.join(root, 'src'), 'src', files)
  files.sort()
  const h = crypto.createHash('sha256')
  for (const rel of files) {
    if (rel === 'src/shared/version.ts') continue // 自动生成，不参与快照
    h.update(rel)
    h.update('\0')
    h.update(fs.readFileSync(path.join(root, rel)))
    h.update('\n')
  }
  return { hash: h.digest('hex'), count: files.length }
}

function bump(version, kind) {
  const parts = String(version || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0)
  const [ma, mi, pa] = [parts[0] || 0, parts[1] || 0, parts[2] || 0]
  if (kind === 'major') return `${ma + 1}.0.0`
  if (kind === 'minor') return `${ma}.${mi + 1}.0`
  return `${ma}.${mi}.${pa + 1}`
}

/** 尝试取最近的 git 提交信息作为变更说明 */
function gitNotes() {
  try {
    const out = require('node:child_process')
      .execSync('git log -5 --pretty=format:%s', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
    return out ? out.split('\n').filter(Boolean).slice(0, 5).map((s) => s.replace(/^[-*]\s*/, '')) : []
  } catch {
    return []
  }
}

/* --------------------------- 生成版本常量文件 --------------------------- */
function writeGenerated(version, stamp) {
  const content = `// 本文件由 tools/version.cjs 自动生成，请勿手动修改。
// 每次功能改进后执行构建/打包，版本号会自动递增（详见 README「版本管理」）。

/** 应用名称 */
export const APP_NAME = '${APP_NAME}'
/** 开发者 */
export const APP_AUTHOR = '${APP_AUTHOR}'
/** 版本号（语义化版本 major.minor.patch） */
export const APP_VERSION = '${version}'
/** 构建号：YYYYMMDD.HHMM */
export const APP_BUILD = '${stamp.build}'
/** 构建时间（本地时间） */
export const APP_BUILD_TIME = '${stamp.date} ${stamp.time}'
/** 版权信息 */
export const APP_COPYRIGHT = 'Copyright © ${new Date().getFullYear()} ${APP_AUTHOR}'
/** 发布渠道：Alpha / Beta / RC；正式版为空字符串 */
export const APP_CHANNEL = '${APP_CHANNEL}'
/** 带渠道的版本标签，例如「v1.0.1 Beta」；正式版就是「v1.0.1」 */
export function versionLabel(): string {
  return \`v\${APP_VERSION}\${APP_CHANNEL ? \` \${APP_CHANNEL}\` : ''}\`
}

/** 带版本号的窗口标题，例如「番茄镜像刻录工具 v1.0.1 Beta」 */
export function appTitle(): string {
  return \`\${APP_NAME} \${versionLabel()}\`
}

/** 底部展示的署名，例如「由敬亭开发 · v1.0.1」 */
export function appCredit(): string {
  return \`由 \${APP_AUTHOR} 开发 · \${versionLabel()}\`
}
`
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true })
  fs.writeFileSync(generatedPath, content, 'utf8')
}

/* --------------------------- 更新 CHANGELOG --------------------------- */
function writeChangelog(version, stamp, lines) {
  const header = '# 更新日志\n\n'
  let body = ''
  if (fs.existsSync(changelogPath)) {
    const raw = fs.readFileSync(changelogPath, 'utf8')
    const idx = raw.indexOf('## ')
    body = idx >= 0 ? raw.slice(idx) : raw.replace(/^#\s*.*\n+/, '')
  }
  const block = `## v${version} — ${stamp.date} ${stamp.time}\n${lines.map((l) => `- ${l}`).join('\n')}\n\n`
  fs.writeFileSync(changelogPath, header + block + body, 'utf8')
}

/* --------------------------- 主流程 --------------------------- */
function main() {
  const pkg = readJson(pkgPath, {})
  const { hash, count } = srcHash()
  const stamp = nowStamp()

  let state = readJson(statePath, null)
  if (!state) {
    // 首次运行：以当前版本建立基线，不递增
    state = {
      version: pkg.version || '1.0.0',
      srcHash: hash,
      fileCount: count,
      updatedAt: stamp.iso,
      history: [{ version: pkg.version || '1.0.0', at: stamp.iso, note: '初始版本' }]
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
    writeGenerated(state.version, stamp)
    console.log(`[version] 建立基线 v${state.version}（源码文件 ${count} 个）`)
    return
  }

  let version = pkg.version || state.version
  let kind = null

  if (mode === 'sync') {
    writeGenerated(version, stamp)
    console.log(`[version] 同步版本信息 v${version}`)
    return
  }

  if (mode === 'auto') {
    if (hash === state.srcHash) {
      writeGenerated(version, stamp)
      console.log(`[version] 源码无变化，保持 v${version}`)
      return
    }
    kind = 'patch'
  } else {
    kind = mode
  }

  const next = bump(version, kind)
  const notes = note ? [note] : gitNotes()
  const finalNotes = notes.length ? notes : [`${kind} 级更新：功能改进与问题修复（自动递增）`]

  // 写 package.json（保留原有缩进与字段顺序）
  const rawPkg = fs.readFileSync(pkgPath, 'utf8')
  fs.writeFileSync(pkgPath, rawPkg.replace(/"version":\s*"[^"]+"/, `"version": "${next}"`), 'utf8')

  state.version = next
  state.srcHash = hash
  state.fileCount = count
  state.updatedAt = stamp.iso
  state.history = [...(state.history || []), { version: next, at: stamp.iso, note: finalNotes[0] }].slice(-50)
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')

  writeGenerated(next, stamp)
  writeChangelog(next, stamp, finalNotes)

  console.log(`[version] ${version} → v${next}（${kind}，源码文件 ${count} 个）`)
  if (note) console.log(`[version] 说明：${note}`)
}

main()
