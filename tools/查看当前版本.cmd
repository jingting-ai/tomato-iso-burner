@echo off
setlocal EnableExtensions
title 番茄镜像刻录工具 - 版本自检
echo ============================================================
echo   番茄镜像刻录工具 - 版本自检
echo ============================================================
echo.
echo [1] 绿色版单文件  E:\番茄镜像刻录工具-绿色版.exe
echo      桌面「番茄镜像刻录工具」用的就是它。
if exist "E:\番茄镜像刻录工具-绿色版.exe" (
    echo      [有]  单文件绿色版在
) else (
    echo      [缺失] 找不到单文件绿色版
)
echo      写盘脚本打包在 exe 里面，跟着程序版本一起更新，不用单独同步。
echo.
echo [2] 绿色版目录    （完整目录版，带 修复U盘 工具包）
call :SHOW "E:\番茄镜像刻录工具\resources\burn.ps1"
echo.
echo [3] 安装版  —— 开始菜单里的那个（装过才有）
call :SHOW "C:\Program Files\doro-iso-burner\tomato-iso-burner\resources\burn.ps1"
call :SHOW "C:\Program Files\tomato-iso-burner\resources\burn.ps1"
call :SHOW "%LOCALAPPDATA%\Programs\tomato-iso-burner\resources\burn.ps1"
echo.
echo ============================================================
echo   最新版本标记是 burn-1.2.6-r1
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
findstr /c:"burn-1.2.6-r1" "%F%" >nul 2>&1
if errorlevel 1 (
    echo     [旧] %F%
) else (
    echo     [OK] %F%
)
goto :eof
