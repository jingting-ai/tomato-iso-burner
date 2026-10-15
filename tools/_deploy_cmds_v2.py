# -*- coding: utf-8 -*-
"""
部署两个辅助 cmd（查看当前版本 / 更新安装版）到指定目录。
统一编码：GBK + CRLF + 无 BOM（cmd.exe 只认这套）。
用法：python _deploy_cmds_v2.py <目标目录1> [目标目录2 ...]
"""
import sys, os

VER = "burn-1.2.5-r7"

UPDATE_CMD = """@echo off
setlocal
title 更新 番茄 刻录工具到最新版

set "SRC=%~dp0resources\\burn.ps1"
set "DST=C:\\Program Files\\tomato-iso-burner\\resources\\burn.ps1"
set "VER={ver}"

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
    echo       请确认本文件与 resources 文件夹在同一目录。
    goto END
)
if not exist "%DST%" (
    echo   [X] 找不到安装版目录：%DST%
    echo       若安装版已卸载则无需更新，直接用绿色版即可。
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
""".format(ver=VER)

VERSION_CMD = """@echo off
setlocal
title 番茄 刻录工具 - 版本自检
echo ============================================================
echo   番茄镜像刻录工具 - 版本自检
echo ============================================================
echo.
echo [1] 绿色版（本目录）
call :SHOW "%~dp0resources\\burn.ps1"
echo.
echo [2] 安装版  C:\\Program Files\\tomato-iso-burner\\
call :SHOW "C:\\Program Files\\tomato-iso-burner\\resources\\burn.ps1"
echo.
echo ============================================================
echo   最新版本标记是 {ver}
echo   每一处都显示 OK，就说明点哪个图标都是最新版。
echo ============================================================
echo.
pause
exit /b

:SHOW
set "F=%~1"
if not exist "%F%" goto SHOWMISS
echo   文件: %F%
for %%I in ("%F%") do echo   日期: %%~tI    大小: %%~zI 字节
findstr /c:"{ver}" "%F%" >nul 2>&1
if errorlevel 1 goto SHOWOLD
echo   版本: OK 当前是最新版 {ver}
exit /b
:SHOWMISS
echo   [X] 文件不存在: %F%
exit /b
:SHOWOLD
echo   版本: 警告 不是最新版，请双击「更新番茄刻录工具到最新版.cmd」
exit /b
""".format(ver=VER)


def write_gbk_crlf(path, text):
    data = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
    raw = data.encode("gbk")  # 无 BOM
    with open(path, "wb") as f:
        f.write(raw)
    return len(raw)


def main():
    targets = sys.argv[1:]
    if not targets:
        print("用法: python _deploy_cmds_v2.py <目标目录> [...]")
        return 1
    for d in targets:
        os.makedirs(d, exist_ok=True)
        n1 = write_gbk_crlf(os.path.join(d, "更新番茄刻录工具到最新版.cmd"), UPDATE_CMD)
        n2 = write_gbk_crlf(os.path.join(d, "查看当前版本.cmd"), VERSION_CMD)
        print("[OK] %s  更新cmd=%d字节  查看cmd=%d字节" % (d, n1, n2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
