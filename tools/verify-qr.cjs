// 验证裁出来的收款码还能不能扫：用 jsQR 真解码，不靠猜。
//   node tools/verify-qr.cjs <png> [...]
// 依赖 jsqr / pngjs 已在 package.json 的 devDependencies 里。
const fs = require('node:fs')
const path = require('node:path')
const jsQR = require('jsqr')
const { PNG } = require('pngjs')

let bad = 0
for (const f of process.argv.slice(2)) {
  const png = PNG.sync.read(fs.readFileSync(f))
  const res = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
  const name = path.basename(f)
  if (res) {
    console.log(`OK   ${name}  ${png.width}x${png.height}`)
    console.log(`     内容: ${res.data}`)
  } else {
    bad++
    console.log(`FAIL ${name}  ${png.width}x${png.height}  ← 解不出来！`)
  }
}
process.exit(bad ? 1 : 0)
