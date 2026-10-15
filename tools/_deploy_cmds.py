# -*- coding: utf-8 -*-
"""把两个自检/更新 cmd 以 GBK + CRLF + 无 BOM 写入并部署。
.cmd 三要素（踩过坑，必须遵守）：
  1) 无 UTF-8 BOM
  2) GBK 编码
  3) CRLF 行尾（cmd.exe 只认 CRLF，用 LF 会解析错位）
  另外：绝对不要写 chcp，切换代码页会让 GBK 中文变乱码。
"""
import os
import shutil

UPDATE_CMD = r"""@echo off
setlocal
title 更新 番茄 刻录工具到最新版

set "SRC=E:\番茄镜像刻录工具-1.2.4\resources\burn.ps1"
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
    echo       请确认 E:\番茄镜像刻录工具-1.2.4 目录还在。
    goto END
)
if not exist "%DST%" (
    echo   [X] 找不到安装版目录：%DST%
    echo       若安装版已卸载则无需更新，直接用桌面「番茄镜像刻录工具 v1.2.4」即可。
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
"""

CHECK_CMD = r"""@echo off
setlocal
title 番茄 刻录工具 - 版本自检
echo ============================================================
echo   番茄镜像刻录工具 - 版本自检
echo ============================================================
echo.
echo [1] 绿色版  —— 桌面「番茄镜像刻录工具 v1.2.4」用的就是它
call :SHOW "E:\番茄镜像刻录工具-1.2.4\resources\burn.ps1"
echo.
echo [2] 安装版  —— 桌面「番茄镜像刻录工具」和开始菜单里的那个
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
if not exist "%F%" goto SHOWMISS
echo   文件: %F%
for %%I in ("%F%") do echo   日期: %%~tI    大小: %%~zI 字节
findstr /c:"burn-1.2.5-r7" "%F%" >nul 2>&1
if errorlevel 1 goto SHOWOLD
echo   版本: OK 当前是最新版 burn-1.2.5-r7
exit /b
:SHOWMISS
echo   [X] 文件不存在: %F%
exit /b
:SHOWOLD
echo   版本: 警告 不是最新版，请双击「更新番茄刻录工具到最新版.cmd」
exit /b
"""


def write_cmd(path, text):
    data = text.replace('\r\n', '\n').replace('\r', '\n').replace('\n', '\r\n')
    raw = data.encode('gbk')
    assert not raw.startswith(b'\xef\xbb\xbf'), 'must not have BOM'
    assert b'\r\n' in raw and b'\n' not in raw.replace(b'\r\n', b''), 'must be pure CRLF'
    with open(path, 'wb') as f:
        f.write(raw)
    return len(raw)


base = r'E:\番茄镜像刻录工具-1.2.4'
desktop = os.path.join(os.environ['USERPROFILE'], 'Desktop')
tools = r'E:\开发\Doro镜像刻录工具\tools'

targets = []

# 1) 更新工具：绿色版目录 + 桌面 + tools 归档
p = os.path.join(base, '更新番茄刻录工具到最新版.cmd')
n = write_cmd(p, UPDATE_CMD)
targets.append((p, n))
q = os.path.join(desktop, '更新番茄刻录工具到最新版.cmd')
shutil.copy2(p, q)
targets.append((q, os.path.getsize(q)))
r = os.path.join(tools, '更新番茄刻录工具到最新版.cmd')
shutil.copy2(p, r)
targets.append((r, os.path.getsize(r)))

# 2) 版本自检：绿色版目录 + 桌面 + tools 归档
p = os.path.join(base, '查看当前版本.cmd')
n = write_cmd(p, CHECK_CMD)
targets.append((p, n))
q = os.path.join(desktop, '查看番茄刻录工具版本.cmd')
shutil.copy2(p, q)
targets.append((q, os.path.getsize(q)))
r = os.path.join(tools, '查看当前版本.cmd')
shutil.copy2(p, r)
targets.append((r, os.path.getsize(r)))

for path, size in targets:
    b = open(path, 'rb').read()
    bom = b.startswith(b'\xef\xbb\xbf')
    crlf = b'\n' not in b.replace(b'\r\n', b'')
    try:
        b.decode('gbk')
        g = 'GBK-OK'
    except Exception:
        g = 'GBK-FAIL'
    print('%-70s %6d bytes  BOM=%s  CRLF=%s  %s' % (path, size, bom, crlf, g))
print('DONE')
