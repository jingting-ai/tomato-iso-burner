# -*- coding: utf-8 -*-
"""重写 tools 下两个硬编码了旧部署路径的 .cmd，指向统一的 E:\\番茄镜像刻录工具。
.cmd 走 GBK 编码（cmd.exe 按系统 ANSI 代码页读）。"""
import os

ROOT = r"E:\开发\Doro镜像刻录工具"

UPDATE = r'''@echo off
setlocal
title 更新 番茄镜像刻录工具 到最新版

set "SRC=E:\番茄镜像刻录工具\resources\burn.ps1"
set "DST=C:\Program Files\tomato-iso-burner\resources\burn.ps1"
set "VER=burn-1.2.5-r7"

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
if not exist "%DST%" (
    echo   [X] 找不到安装版目录：%DST%
    echo       若安装版已卸载则无需更新，直接用桌面「番茄镜像刻录工具」即可。
    goto END
)

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
'''

CHECK = r'''@echo off
setlocal
title 番茄镜像刻录工具 - 版本自检
echo ============================================================
echo   番茄镜像刻录工具 - 版本自检
echo ============================================================
echo.
echo [1] 绿色版  —— 桌面「番茄镜像刻录工具」用的就是它
call :SHOW "E:\番茄镜像刻录工具\resources\burn.ps1"
echo.
echo [2] 安装版  —— 开始菜单里的那个（装过才有）
call :SHOW "C:\Program Files\tomato-iso-burner\resources\burn.ps1"
echo.
echo ============================================================
echo   最新版本标记是 burn-1.2.5-r7
echo   上面每一处都显示 OK，就说明点哪个图标都是最新版。
echo ============================================================
echo.
pause
exit /b

:SHOW
set "F=%~1"
if not exist "%F%" (
    echo     (不存在，跳过)  %F%
    goto :eof
)
findstr /c:"burn-1.2.5-r7" "%F%" >nul 2>&1
if errorlevel 1 (
    echo     [旧] %F%
) else (
    echo     [OK] %F%
)
goto :eof
'''

for name, text in [("更新番茄刻录工具到最新版.cmd", UPDATE),
                   ("查看当前版本.cmd", CHECK)]:
    p = os.path.join(ROOT, "tools", name)
    data = text.replace("\n", "\r\n").encode("gbk")
    open(p, "wb").write(data)
    print("写出 %s  (%d B, GBK)" % (name, len(data)))
