#!/usr/bin/env bash
# 把 v1.2.34 铺到桌面快捷方式指向的 E:\DoroBurner-1.2.4，
# 以及上一轮建的 E:\DoroBurner-1.2.32（若未被占用）。
# 只做 additive 复制，绝不删除目标目录里已有的东西。
set -u
cd "E:/开发/Doro镜像刻录工具"

V=1.2.34
SRC="dist/win-unpacked"
DIRS=("E:/DoroBurner-1.2.4" "E:/DoroBurner-1.2.32")
RC=0

for DST in "${DIRS[@]}"; do
  echo "=== 写入 $DST ==="
  mkdir -p "$DST/安装包"
  if cp -r "$SRC/." "$DST/" 2>/tmp/_deploy_err; then
    cp "dist/Doro镜像刻录工具-$V-win-x64.exe"  "$DST/安装包/"
    cp "dist/Doro镜像刻录工具-$V-portable.exe" "$DST/安装包/"
    cp "dist/Doro镜像刻录工具-$V-win-x64.zip"  "$DST/安装包/"
    cp dist/_uicheck/gallery/界面效果-$V*.png   "$DST/"
    cp "tools/_readme_1234.txt"                 "$DST/使用说明-$V.txt"
    cp "dist/DoroIsoBurner-win32-x64-v$V/VERSION.txt" "$DST/VERSION.txt"
    if [ ! -d "$DST/修复U盘" ]; then cp -r "E:/DoroBurner-1.2.4/修复U盘" "$DST/"; fi
    echo "  OK，文件数: $(find "$DST" -type f | wc -l)"
  else
    echo "  !! 写入失败（目标被占用？）。前几条错误："
    head -3 /tmp/_deploy_err | sed 's/^/     /'
    RC=1
  fi
done

echo "=== 校验 ==="
node -e "
const fs=require('fs');
for (const d of ['E:/DoroBurner-1.2.4','E:/DoroBurner-1.2.32']) {
  const p = d + '/resources/app.asar';
  if (!fs.existsSync(p)) { console.log(d, '-> 目录不存在'); continue }
  const s = fs.readFileSync(p).toString('latin1');
  console.log(d, '-> asar 含 1.2.34:', s.includes('1.2.34'));
}
"
exit $RC
