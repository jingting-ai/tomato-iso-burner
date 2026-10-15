# 重写「更新到最新版 / 查看版本」两个 .cmd（GBK + CRLF）：
#   · 安装版路径不再是 C:\Program Files\tomato-iso-burner\ —— 本机实际装在
#     C:\Program Files\doro-iso-burner\tomato-iso-burner\（历史改名留下的嵌套），
#     所以这里改成「按候选路径列表逐个找」，找不到再报错。
#   · 同时写到工程 tools/ 与用户桌面（桌面那份先备份）。
# 用法：python tools/_fix_cmds_1240.py
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESKTOP = os.path.join(os.environ['USERPROFILE'], 'Desktop')
BACKUP = os.path.join(ROOT, '..', '..', 'WorkBuddy', '2026-10-10-23-17-28', '.workbuddy', 'backup', 'cmds')
BACKUP = os.path.normpath(BACKUP)

UPDATE = '''@echo off
setlocal
title 更新 番茄镜像刻录工具 到最新版

set "SRC=E:\\番茄镜像刻录工具\\resources\\burn.ps1"
set "VER=burn-1.2.5-r7"
set "DST="

rem 安装版路径可能是嵌套的（doro-iso-burner\\tomato-iso-burner），逐个候选找
for %%P in (
  "C:\\Program Files\\doro-iso-burner\\tomato-iso-burner\\resources\\burn.ps1"
  "C:\\Program Files\\tomato-iso-burner\\resources\\burn.ps1"
  "C:\\Program Files (x86)\\tomato-iso-burner\\resources\\burn.ps1"
  "%LOCALAPPDATA%\\Programs\\tomato-iso-burner\\resources\\burn.ps1"
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
    echo       请确认 E:\\番茄镜像刻录工具 目录还在。
    goto END
)
if not defined DST (
    echo   [X] 找不到安装版目录（在下面这些位置都没找到）：
    echo       C:\\Program Files\\doro-iso-burner\\tomato-iso-burner\\resources\\
    echo       C:\\Program Files\\tomato-iso-burner\\resources\\
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
'''

CHECK = '''@echo off
setlocal EnableExtensions
title 番茄镜像刻录工具 - 版本自检
echo ============================================================
echo   番茄镜像刻录工具 - 版本自检
echo ============================================================
echo.
echo [1] 绿色版  —— 桌面「番茄镜像刻录工具」用的就是它
call :SHOW "E:\\番茄镜像刻录工具\\resources\\burn.ps1"
echo.
echo [2] 安装版  —— 开始菜单里的那个（装过才有）
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

JOBS = [
    (os.path.join(ROOT, 'tools', '更新番茄刻录工具到最新版.cmd'), UPDATE),
    (os.path.join(ROOT, 'tools', '查看当前版本.cmd'), CHECK),
    (os.path.join(DESKTOP, '更新番茄镜像刻录工具到最新版.cmd'), UPDATE),
    (os.path.join(DESKTOP, '查看番茄镜像刻录工具版本.cmd'), CHECK),
]

os.makedirs(BACKUP, exist_ok=True)
for path, text in JOBS:
    if os.path.exists(path):
        shutil.copy2(path, os.path.join(BACKUP, os.path.basename(path) + '.bak'))
        print('备份 ->', os.path.join(BACKUP, os.path.basename(path) + '.bak'))
    with open(path, 'wb') as f:
        f.write(text.replace('\n', '\r\n').encode('gbk'))
    print('写入 %-46s %d 字节' % (path, os.path.getsize(path)))
print()
print('备份目录：%s' % BACKUP)
