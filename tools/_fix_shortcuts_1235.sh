#!/usr/bin/env bash
# v1.2.35：桌面快捷方式与快捷脚本改名为「番茄」。
# 旧件一律先备份（.workbuddy/backup/lnk/），再移出桌面 —— 可随时还原，不丢东西。
set -u
cd "E:/开发/Doro镜像刻录工具" || exit 1

EXE="E:/番茄镜像刻录工具/番茄镜像刻录工具.exe"
WD="E:/番茄镜像刻录工具"
PY="C:/Users/jingt/.workbuddy/binaries/python/versions/3.13.12/python.exe"
BAK=".workbuddy/backup/lnk"
RC=0

echo "=== 1. 新建快捷方式 ==="
for D in "C:/Users/jingt/Desktop" "C:/Users/Public/Desktop"; do
  if "$PY" tools/make-shortcut.py write "$D/番茄镜像刻录工具.lnk" "$EXE" "$WD" "" "番茄镜像刻录工具" >/tmp/_lnk_out 2>&1; then
    echo "  OK  $D/番茄镜像刻录工具.lnk"
  else
    echo "  !!  失败: $D"; head -3 /tmp/_lnk_out | sed 's/^/       /'; RC=1
  fi
done

echo
echo "=== 2. 旧的 Doro 快捷方式移出桌面（备份已在 $BAK）==="
for D in "C:/Users/jingt/Desktop" "C:/Users/Public/Desktop"; do
  F="$D/Doro镜像刻录工具.lnk"
  if [ -f "$F" ]; then
    TAG=$(echo "$D" | grep -q Public && echo "公共桌面" || echo "桌面")
    if [ -f "$BAK/$TAG-Doro镜像刻录工具.lnk.bak" ] && mv "$F" "$BAK/$TAG-Doro镜像刻录工具.lnk.retired"; then
      echo "  已移出: $F"
    else
      echo "  !!  移出失败（备份不存在或占用）: $F"; RC=1
    fi
  fi
done

echo
echo "=== 3. 桌面快捷脚本换成番茄那两份 ==="
for D in "C:/Users/jingt/Desktop"; do
  for F in "更新Doro刻录工具到最新版.cmd" "查看Doro刻录工具版本.cmd"; do
    if [ -f "$D/$F" ]; then
      cp "$D/$F" "$BAK/$F.bak" && mv "$D/$F" "$BAK/$F.retired" && echo "  已移出: $F"
    fi
  done
  cp "tools/更新番茄刻录工具到最新版.cmd" "$D/更新番茄镜像刻录工具到最新版.cmd" && echo "  已放入: 更新番茄镜像刻录工具到最新版.cmd"
  cp "tools/查看当前版本.cmd"             "$D/查看番茄镜像刻录工具版本.cmd" && echo "  已放入: 查看番茄镜像刻录工具版本.cmd"
done

echo
echo "=== 4. 结果核对 ==="
"$PY" tools/make-shortcut.py read "C:/Users/jingt/Desktop/番茄镜像刻录工具.lnk" 2>&1 | sed 's/^/  /'
echo "  --- 桌面现存相关文件 ---"
ls "C:/Users/jingt/Desktop/" | grep -iE "刻录|Doro|番茄" | sed 's/^/    /'
echo "  --- 公共桌面 ---"
ls "C:/Users/Public/Desktop/" | grep -iE "刻录|Doro|番茄" | sed 's/^/    /'
echo "  --- 备份目录 ---"
ls "$BAK" | sed 's/^/    /'
exit $RC
