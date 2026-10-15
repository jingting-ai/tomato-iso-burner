@echo off
setlocal
title 更新 番茄镜像刻录工具 到最新版

set "SRC=E:\番茄镜像刻录工具\resources\burn.ps1"
set "VER=burn-1.2.6-r1"
set "DST="

rem 安装版路径可能是嵌套的（doro-iso-burner\tomato-iso-burner），逐个候选找
for %%P in (
  "C:\Program Files\doro-iso-burner\tomato-iso-burner\resources\burn.ps1"
  "C:\Program Files\tomato-iso-burner\resources\burn.ps1"
  "C:\Program Files (x86)\tomato-iso-burner\resources\burn.ps1"
  "%LOCALAPPDATA%\Programs\tomato-iso-burner\resources\burn.ps1"
) do if not defined DST if exist "%%~P" set "DST=%%~P"

net session >nul 2>&1
if errorlevel 1 (
    echo.
    echo   需要管理员权限，正在弹出授权窗口，请点「是」...
    echo.
    powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ============================================================
echo   正在把最新写盘脚本同步到安装版
echo ============================================================
echo.

if not exist "%SRC%" (
    echo   [X] 找不到最新脚本：%SRC%
    echo       请确认 E:\番茄镜像刻录工具 目录还在。
    goto END
)
if not defined DST (
    echo   [X] 找不到安装版目录（在下面这些位置都没找到）：
    echo       C:\Program Files\doro-iso-burner\tomato-iso-burner\resources\
    echo       C:\Program Files\tomato-iso-burner\resources\
    echo       若安装版已卸载则无需更新，直接用桌面「番茄镜像刻录工具」即可。
    goto END
)

echo   目标：%DST%
echo.
copy /y "%DST%" "%DST%.bak" >nul 2>&1
copy /y "%SRC%" "%DST%" >nul
if errorlevel 1 (
    echo   [X] 复制失败：文件可能被占用，请先完全关闭刻录工具再试一次。
    goto END
)

findstr /c:"%VER%" "%DST%" >nul 2>&1
if errorlevel 1 (
    echo   [!] 复制完成但校验未通过，请把本窗口截图反馈。
    goto END
)

echo   [OK] 安装版已更新为最新脚本 %VER%
echo.
echo   现在无论点哪个图标启动，用的都是最新版。
echo   （原文件已备份为 burn.ps1.bak）

:END
echo.
pause
