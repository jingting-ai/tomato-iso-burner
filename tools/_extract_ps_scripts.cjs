// 把 windows.ts 里的两段 PowerShell 脚本抽出来落盘，供语法/运行验证
const fs = require('fs')
const s = fs.readFileSync('src/main/platform/windows.ts', 'utf8')
function grab(name) {
  const re = new RegExp('const ' + name + ' = `([\\s\\S]*?)`\\r?\\n')
  const m = s.match(re)
  if (!m) throw new Error('没抓到 ' + name)
  // 模板串里的 \\ 是转义后的单个反斜杠，落盘前还原
  return m[1].replace(/\\\\/g, '\\')
}
fs.writeFileSync('dist/_enum_test.ps1', grab('ENUM_SCRIPT'), 'utf8')
fs.writeFileSync('dist/_usbgen_test.ps1', '$targets = @(2)\n' + grab('USBGEN_SCRIPT'), 'utf8')
console.log('已写出 dist/_enum_test.ps1 与 dist/_usbgen_test.ps1')
