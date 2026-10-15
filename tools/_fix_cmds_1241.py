# -*- coding: utf-8 -*-
"""
v1.2.41：把「查看当前版本」脚本里那句已经过期的说明改掉。

原来写的是「[1] 绿色版 —— 桌面『番茄镜像刻录工具』用的就是它: E:\\番茄镜像刻录工具\\」，
但 v1.2.41 之后桌面图标已经改指**单文件绿色版** E:\\番茄镜像刻录工具-绿色版.exe。
不改的话，用户点开自检脚本会看到一条对不上的说明。

输出一律 GBK + CRLF（cmd 窗口才不会乱码）。
"""
import os
import shutil

ROOT = r'E:\开发\Doro镜像刻录工具'
BACKUP = r'C:\Users\jingt\WorkBuddy\2026-10-10-23-17-28\.workbuddy\backup\cmds'

NEW = '''@echo off
setlocal EnableExtensions
title 番茄镜像刻录工具 - 版本自检
echo ============================================================
echo   番茄镜像刻录工具 - 版本自检
echo ============================================================
echo.
echo [1] 绿色版单文件  E:\\番茄镜像刻录工具-绿色版.exe
echo      桌面「番茄镜像刻录工具」用的就是它。
if exist "E:\\番茄镜像刻录工具-绿色版.exe" (
    echo      [有]  单文件绿色版在
) else (
    echo      [缺失] 找不到单文件绿色版
)
echo      写盘脚本打包在 exe 里面，跟着程序版本一起更新，不用单独同步。
echo.
echo [2] 绿色版目录    （完整目录版，带 修复U盘 工具包）
call :SHOW "E:\\番茄镜像刻录工具\\resources\\burn.ps1"
echo.
echo [3] 安装版  —— 开始菜单里的那个（装过才有）
call :SHOW "C:\\Program Files\\doro-iso-burner\\tomato-iso-burner\\resources\\burn.ps1"
call :SHOW "C:\\Program Files\\tomato-iso-burner\\resources\\burn.ps1"
call :SHOW "%LOCALAPPDATA%\\Programs\\tomato-iso-burner\\resources\\burn.ps1"
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


def main():
    os.makedirs(BACKUP, exist_ok=True)
    targets = [
        os.path.join(ROOT, 'tools', '查看当前版本.cmd'),
        r'C:\Users\jingt\Desktop\查看番茄镜像刻录工具版本.cmd',
    ]
    data = NEW.replace('\n', '\r\n')
    if not data.endswith('\r\n'):
        data += '\r\n'
    blob = data.encode('gbk')

    for t in targets:
        if os.path.exists(t):
            bak = os.path.join(BACKUP, os.path.basename(t) + '.1241.bak')
            if not os.path.exists(bak):
                shutil.copy2(t, bak)
            print('  备份 ->', bak)
        with open(t, 'wb') as f:
            f.write(blob)
        print('  写出 %s (%d B)' % (t, os.path.getsize(t)))
        with open(t, 'rb') as f:
            raw = f.read()
        assert b'\r\n' in raw, t
        print('    GBK 可解:', raw.decode('gbk')[:40].splitlines()[0])


if __name__ == '__main__':
    main()
