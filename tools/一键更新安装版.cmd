@echo off
setlocal EnableExtensions
title 番茄 同步最新脚本到安装版
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
echo     番茄镜像刻录工具 - 同步最新脚本到安装版
echo   ============================================================
echo.
echo   作用：把最新版 burn.ps1 / repair.ps1 同步进安装目录
echo         （C:\Program Files\tomato-iso-burner\resources\），
echo         消除「开始菜单/桌面快捷方式里跑的仍是旧脚本」的问题。
echo.
echo   只替换写盘/修复脚本这两个文件，不动其他任何文件；旧版会备份为 .bak。
echo   ============================================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0同步脚本到安装版.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
echo   ------------------------------------------------------------
if "%RC%"=="0" (
  echo   [结果] 同步完成（或已是最新）。现在从任意入口启动都是最新脚本。
) else (
  echo   [结果] 同步报告了问题（退出码 %RC%），请阅读上面的输出。
)
echo   ------------------------------------------------------------
echo.
pause
endlocal
exit /b %RC%
