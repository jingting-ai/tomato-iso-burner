/**
 * 镜像识别自检。
 *
 * 用途：每次改动 src/main/iso/ 下的识别逻辑后，用真实镜像回归一遍，确认没有把
 * 已经认对的镜像改坏。典型场景就是「25H2 被认成 24H2」「Win10 22H2 被认成 2004」
 * 这类版本判定问题。
 *
 * 用法（npm 脚本已配好，会自动先打包再运行）：
 *   npm run probe:selftest                              # 只跑内置的家族判定用例，不需要镜像文件
 *   npm run probe:selftest -- "D:/iso/Win11_25H2.iso"   # 对真实镜像跑识别
 *   npm run probe:selftest -- "D:/iso/a.iso" "D:/iso/b.iso"
 *
 * 手动用法：
 *   npx esbuild tools/probe-selftest.ts --bundle --platform=node --format=cjs \
 *     --outfile=dist/_probe-selftest.cjs --log-level=warning
 *   node dist/_probe-selftest.cjs <镜像路径> [...]
 */
import { guessFamilyRelease, probeImage } from '../src/main/iso/probe'

/**
 * 内置用例：家族基础号 + 修订号 + 是不是零售盘 → 期望认出的版本。
 * 这些数字来自微软更新记录里各版本的首发/终版修订号，改表时必须一起看。
 */
const FAMILY_CASES: Array<{ base: number; rev: number; retail: boolean; want: string }> = [
  // 19041 家族（Windows 10 2004 / 20H2 / 21H1 / 21H2 / 22H2）
  { base: 19041, rev: 3803, retail: true, want: 'Windows 10 22H2' }, // KB5033372（2023-12）
  { base: 19041, rev: 3803, retail: false, want: 'Windows 10 21H2 / 22H2' }, // VL 盘分不出来
  { base: 19041, rev: 1415, retail: true, want: 'Windows 10 21H2' },
  { base: 19041, rev: 1415, retail: false, want: 'Windows 10 2004 – 21H2' },
  { base: 19041, rev: 1000, retail: true, want: 'Windows 10 21H1' },
  { base: 19041, rev: 300, retail: true, want: 'Windows 10 2004' },
  { base: 19041, rev: 2000, retail: true, want: 'Windows 10 21H2' },
  { base: 19041, rev: 2364, retail: false, want: 'Windows 10 21H1 – 22H2' },
  { base: 19041, rev: 0, retail: true, want: 'Windows 10 2004 – 22H2' }, // 没读到修订号，如实列区间
  // 22621 家族（Windows 11 22H2 / 23H2）—— 官方 23H2 盘里写的就是 22621
  { base: 22621, rev: 2506, retail: true, want: 'Windows 11 23H2' },
  { base: 22621, rev: 2000, retail: true, want: 'Windows 11 22H2' },
  { base: 22621, rev: 2506, retail: false, want: 'Windows 11 22H2 / 23H2' },
  { base: 22621, rev: 521, retail: true, want: 'Windows 11 22H2' }
]

function runFamilyCases(): number {
  console.log('内置用例：家族基础号 → 版本判定（无需镜像文件）')
  console.log('='.repeat(78))
  let bad = 0
  for (const c of FAMILY_CASES) {
    const g = guessFamilyRelease(c.base, c.rev, c.retail)
    const got = g ? `${g.candidates.join(' | ')}${g.build ? ` @${g.build}` : ''}` : '(未命中家族表)'
    const ok = got.startsWith(c.want)
    if (!ok) bad++
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${c.base} / 修订 ${String(c.rev).padStart(4)} / ${c.retail ? '零售' : '企业'} → ${got}`
    )
    if (!ok) console.log(`      期望以「${c.want}」开头`)
  }
  console.log('='.repeat(78))
  console.log(bad === 0 ? `内置用例全部通过（${FAMILY_CASES.length} 项）\n` : `内置用例 ${bad} 项不符\n`)
  return bad
}

async function runImages(files: string[]): Promise<number> {
  let failed = 0
  for (const f of files) {
    const t0 = Date.now()
    try {
      const r = await probeImage(f)
      const ms = Date.now() - t0
      console.log('\n' + '='.repeat(78))
      console.log('文件      :', f.split(/[\\/]/).pop())
      console.log('系统      :', r.osName, r.version ? `| 版本 ${r.version}` : '')
      console.log('家族/架构 :', r.family, '|', r.arch || '(未知)')
      console.log('可引导    :', r.bootable ? r.bootModes.join(' + ') : '否')
      console.log('置信度    :', Math.round(r.confidence * 100) + '%')
      console.log('识别依据  :', r.evidence)
      if (r.hint) console.log('提示      :', r.hint)
      if (r.details.length) {
        console.log('补充信息  :')
        for (const d of r.details) console.log('   ', d.label, '=', d.value)
      }
      console.log('耗时      :', ms, 'ms')
    } catch (e) {
      failed++
      console.log('\n文件:', f, ' 识别失败:', (e as Error).message)
    }
  }
  console.log('\n' + '='.repeat(78))
  console.log(`完成：共 ${files.length} 个，失败 ${failed} 个`)
  return failed
}

async function main() {
  const files = process.argv.slice(2)
  let bad = runFamilyCases()
  if (files.length > 0) bad += await runImages(files)
  if (bad > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('识别自检异常：', e)
  process.exit(1)
})
