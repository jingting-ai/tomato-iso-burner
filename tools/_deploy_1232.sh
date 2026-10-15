#!/usr/bin/env bash
# 把 v1.2.32 铺到两个位置：新建的 E:\DoroBurner-1.2.32（干净记录版）
# 和桌面快捷方式指向的 E:\DoroBurner-1.2.4（用户实际双击的那份）。
# 只用 additive 复制（cp -r src/. dst/），绝不删除目标目录里已有的东西。
set -e
cd "E:/开发/Doro镜像刻录工具"

V=1.2.32
SRC="dist/win-unpacked"
NEW="E:/DoroBurner-$V"
OLD="E:/DoroBurner-1.2.4"

for DST in "$NEW" "$OLD"; do
  echo "=== 写入 $DST ==="
  mkdir -p "$DST/安装包"
  cp -r "$SRC/." "$DST/"
  cp "dist/Doro镜像刻录工具-$V-win-x64.exe"    "$DST/安装包/"
  cp "dist/Doro镜像刻录工具-$V-portable.exe"   "$DST/安装包/"
  cp "dist/Doro镜像刻录工具-$V-win-x64.zip"    "$DST/安装包/"
  cp dist/_uicheck/gallery/界面效果-$V*.png     "$DST/"
  cp "tools/_readme_1232.txt"                   "$DST/使用说明-$V.txt"
  # 辅助脚本从老目录带过去（新目录才需要）
  if [ ! -d "$DST/修复U盘" ]; then cp -r "$OLD/修复U盘" "$DST/"; fi
  for f in "更新Doro刻录工具到最新版.cmd" "查看当前版本.cmd"; do
    if [ ! -f "$DST/$f" ] && [ -f "$OLD/$f" ]; then cp "$OLD/$f" "$DST/"; fi
  done
  echo "  文件数: $(find "$DST" -type f | wc -l)"
done

echo "=== exe / asar 版本自检 ==="
node -e "
const fs=require('fs');
for (const d of ['E:/DoroBurner-1.2.32','E:/DoroBurner-1.2.4']) {
  const a = d + '/resources/app.asar';
  const s = fs.readFileSync(a).toString('latin1');
  const ok = s.includes('1.2.32');
  console.log(d, '-> asar 含 1.2.32:', ok, '| app.asar', (fs.statSync(a).size/1048576).toFixed(1)+'MB');
}
"
echo DONE
