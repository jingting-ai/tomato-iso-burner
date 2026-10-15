#!/usr/bin/env bash
# 把 v1.2.33 铺到桌面快捷方式指向的 E:\DoroBurner-1.2.4，
# 以及上一轮建的 E:\DoroBurner-1.2.32 —— 两个都刷成新版，
# 免得 E 盘上还留着一份「看起来最新其实过期」的副本。
# 只用 additive 复制，绝不删除目标目录里已有的东西。
set -e
cd "E:/开发/Doro镜像刻录工具"

V=1.2.33
SRC="dist/win-unpacked"
DIRS=("E:/DoroBurner-1.2.4" "E:/DoroBurner-1.2.32")

for DST in "${DIRS[@]}"; do
  echo "=== 写入 $DST ==="
  mkdir -p "$DST/安装包"
  cp -r "$SRC/." "$DST/"
  cp "dist/Doro镜像刻录工具-$V-win-x64.exe"  "$DST/安装包/"
  cp "dist/Doro镜像刻录工具-$V-portable.exe" "$DST/安装包/"
  cp "dist/Doro镜像刻录工具-$V-win-x64.zip"  "$DST/安装包/"
  cp dist/_uicheck/gallery/界面效果-$V*.png   "$DST/"
  cp "dist/_uicheck/repro/logo-v2-各尺寸.png" "$DST/新logo-各尺寸.png"
  cp "tools/_readme_1233.txt"                 "$DST/使用说明-$V.txt"
  cp "dist/DoroIsoBurner-win32-x64-v$V/VERSION.txt" "$DST/VERSION.txt"
  if [ ! -d "$DST/修复U盘" ]; then cp -r "E:/DoroBurner-1.2.4/修复U盘" "$DST/"; fi
  echo "  文件数: $(find "$DST" -type f | wc -l)"
done

echo "=== 校验 ==="
node -e "
const fs=require('fs');
for (const d of ['E:/DoroBurner-1.2.33','E:/DoroBurner-1.2.4','E:/DoroBurner-1.2.32']) {
  const p = d + '/resources/app.asar';
  if (!fs.existsSync(p)) { console.log(d, '-> 不存在，跳过'); continue }
  const s = fs.readFileSync(p).toString('latin1');
  console.log(d, '-> asar 含 1.2.33:', s.includes('1.2.33'));
}
"
echo DONE
