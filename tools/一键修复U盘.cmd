@echo off
setlocal EnableExtensions
title 番茄 U盘急救修复
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [重要] 本工具需要管理员权限，正在自动申请提权...
  echo   [重要] 请在弹出的 UAC 窗口中点击「是」。
  echo.
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo   ============================================================
echo     番茄镜像刻录工具 - U 盘急救修复
echo   ============================================================
echo.
echo   作用：重建分区表 + 快速格式化
echo         （修复「未知容量」/ RAW / 无法写入 的 U 盘）
echo.
echo   目标：自动识别的 USB 盘；系统盘 / 启动盘一律拒绝操作。
echo   警告：目标磁盘上的全部数据将被清除，且不可撤销！
echo   ============================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0修复U盘.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
echo   ------------------------------------------------------------
if "%RC%"=="0" (
  echo   [结果] 修复完成。如果「此电脑」里出现了盘符，问题已解决。
) else (
  echo   [结果] 修复报告了问题（退出码 %RC%），请阅读上面的输出。
)
echo   [日志] %TEMP%\tomato-repair-latest.log
echo   ------------------------------------------------------------
echo.
pause
endlocal
exit /b %RC%
