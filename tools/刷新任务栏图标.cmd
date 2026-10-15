@echo off
chcp 936 >nul
title 刷新图标缓存 - 番茄镜像刻录工具
echo.
echo  番茄镜像刻录工具 —— 刷新任务栏 / 桌面图标缓存
echo.
echo  什么时候用：换了新版本之后，任务栏或者桌面上的图标还是旧的那一张。
echo  为什么：Windows 会把图标缓存起来，程序路径没变时它不一定重新读文件里的新图标。
echo.
echo  运行过程：任务栏会消失几秒再自己回来（正常现象），期间不要关这个窗口。
echo.
pause
echo.
echo  [1/3] 关闭资源管理器 ...
taskkill /f /im explorer.exe >nul 2>&1
echo  [2/3] 删除图标缓存 ...
del /a /f /q "%localappdata%\IconCache.db" >nul 2>&1
del /a /f /q "%localappdata%\Microsoft\Windows\Explorer\iconcache*" >nul 2>&1
echo  [3/3] 重新启动资源管理器 ...
timeout /t 2 /nobreak >nul
start "" explorer.exe
echo.
echo  完成。图标如果还是旧的，注销一次或者重启电脑即可。
echo.
pause
