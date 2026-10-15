#!/usr/bin/env bash
# v1.2.36 部署：铺到统一的单一目录 E:\番茄镜像刻录工具\
# 只做 additive 复制；目标目录里已有的东西（旧效果图 / 证据图）一概不动。
set -u
cd "E:/开发/Doro镜像刻录工具" || exit 1

V=1.2.36
SRC="dist/win-unpacked"
DST="E:/番茄镜像刻录工具"
RC=0

echo "=== 写入 $DST ==="
mkdir -p "$DST/安装包" "$DST/修复U盘"

if cp -r "$SRC/." "$DST/" 2>/tmp/_deploy_err; then

  cp "dist/番茄镜像刻录工具-$V-win-x64.exe"  "$DST/安装包/"
  cp "dist/番茄镜像刻录工具-$V-portable.exe" "$DST/安装包/"
  cp "dist/番茄镜像刻录工具-$V-win-x64.zip"  "$DST/安装包/"

  cp dist/_uicheck/gallery/界面效果-$V*.png "$DST/" 2>/dev/null
  cp "tools/_readme_1236.txt"                "$DST/使用说明-$V.txt"
  cp "dist/TomatoIsoBurner-win32-x64-v$V/VERSION.txt" "$DST/VERSION.txt"

  # 目录里的快捷脚本（GBK）
  cp "tools/更新番茄刻录工具到最新版.cmd" "$DST/"
  cp "tools/查看当前版本.cmd"             "$DST/"

  # 修复U盘：脚本从工程现取，别用旧副本
  cp assets/burn.ps1              "$DST/修复U盘/"
  cp tools/修复U盘.ps1             "$DST/修复U盘/"
  cp tools/一键修复U盘.cmd         "$DST/修复U盘/"
  cp tools/一键更新安装版.cmd      "$DST/修复U盘/"
  cp tools/同步脚本到安装版.ps1    "$DST/修复U盘/"

  echo "  OK，文件数: $(find "$DST" -type f | wc -l)"
else
  echo "  !! 写入失败。前几条错误："
  head -3 /tmp/_deploy_err | sed 's/^/     /'
  RC=1
fi

echo
echo "=== 校验 ==="
node -e "
const fs=require('fs');
const DST='E:/番茄镜像刻录工具';
const exe=DST+'/番茄镜像刻录工具.exe';
const asar=DST+'/resources/app.asar';
console.log('主程序        :', fs.existsSync(exe) ? (fs.statSync(exe).size/1048576).toFixed(1)+' MB' : '缺失 !!');
if (fs.existsSync(asar)) {
  const s=fs.readFileSync(asar,'utf8');
  console.log('asar 含 1.2.36:', s.includes('1.2.36'));
  console.log('asar 含番茄    :', s.includes('番茄镜像刻录工具'));
  console.log('asar 残留 Doro :', s.includes('Doro镜像刻录工具'));
} else { console.log('asar 缺失 !!') }
console.log('VERSION.txt   :', fs.existsSync(DST+'/VERSION.txt') ? fs.readFileSync(DST+'/VERSION.txt','utf8').split('\n')[1] : '缺失 !!');
for (const n of ['修复U盘/修复U盘.ps1','修复U盘/一键修复U盘.cmd','使用说明-1.2.36.txt','更新番茄刻录工具到最新版.cmd','查看当前版本.cmd']) {
  console.log((n+'                    ').slice(0,22)+':', fs.existsSync(DST+'/'+n) ? '有' : '缺失 !!');
}
const g=fs.readdirSync(DST).filter(f=>/^界面效果-1\.2\.36/.test(f));
console.log('1.2.36 效果图  :', g.length+' 张');
"
exit $RC
