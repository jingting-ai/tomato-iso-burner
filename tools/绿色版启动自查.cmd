@echo off
chcp 936 >nul
setlocal EnableExtensions
title 番茄镜像刻录工具 - 绿色版启动自查
set "EXE=E:\番茄镜像刻录工具-绿色版.exe"
set "LOGDIR=%TEMP%\tomato-iso-burner-portable"
set "TL=%TEMP%\_tomato_tasklist.txt"

echo ============================================================
echo   番茄镜像刻录工具 - 绿色版启动自查
echo ============================================================
echo.
echo [1] 程序文件
if exist "%EXE%" (
    for %%A in ("%EXE%") do echo     [有]  %%~nxA   %%~zA 字节   修改时间 %%~tA
) else (
    echo     [缺失] 找不到 %EXE%
    echo            请确认这个文件还在。
    goto END
)
echo.
echo [2] 启动前，已经在跑的实例
call :COUNT
echo.
echo [3] 现在启动它，等 10 秒看看进程起没起来...
start "" "%EXE%"
timeout /t 10 /nobreak >nul
echo.
echo [4] 启动后的实例
call :COUNT
echo.
echo [5] 异常日志（绿色版平时不产生日志；这里有东西 = 真出过问题）
if exist "%LOGDIR%\startup.log" (
    echo     找到 %LOGDIR%\startup.log
    echo     ------------------------------------------------
    type "%LOGDIR%\startup.log"
    echo     ------------------------------------------------
) else (
    echo     没有日志文件。
    echo     - 如果上面第 4 步显示了进程、并且窗口出来了 → 一切正常，本来就不该有日志。
    echo     - 如果进程也没起来、窗口也没有 → 进程根本没被创建，
    echo       问题在 Windows 拉起 exe 这一步（不是程序内部），
    echo       请把本窗口整个截图发给开发者。
)
echo.
echo ============================================================
echo   把本窗口整个截图发出来即可定位。
echo ============================================================
:END
echo.
pause
exit /b

:COUNT
tasklist /nh > "%TL%" 2>nul
findstr /c:"番茄镜像刻录工具" "%TL%" >nul 2>&1
if errorlevel 1 (
    echo     没有「番茄镜像刻录工具」进程
) else (
    echo     有以下进程：
    findstr /c:"番茄镜像刻录工具" "%TL%"
)
del "%TL%" >nul 2>&1
goto :eof
