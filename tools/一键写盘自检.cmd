@echo off
setlocal EnableExtensions
title 番茄 Burn Self-Test
pushd "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo [!] This tool needs Administrator privileges.
  echo [!] Requesting elevation - please click "Yes" on the UAC dialog.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  popd
  exit /b
)

echo.
echo ==================================================================
echo   番茄 Burn Self-Test   -   running as ADMINISTRATOR
echo ==================================================================
echo.
echo   Uses TWO VIRTUAL disks. It does NOT touch any real USB stick.
echo.
echo   Case A : virtual disk formatted with a drive letter
echo            (checks the "lock and dismount volume" path)
echo   Case B : virtual disk with a partition but NO drive letter,
echo            NOT mounted by Windows
echo            (this is exactly the state of a USB stick that was
echo             written with a Linux ISO, or that got damaged)
echo.
echo   Both cases must PASS.
echo ==================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0selftest-vhd.ps1" -BurnScript "%~dp0burn.ps1"
set RC=%errorlevel%

echo.
echo ------------------------------------------------------------------
if "%RC%"=="0" (
  echo [RESULT] PASS  - the burn path works in both cases.
) else (
  echo [RESULT] FAIL  - please send the output above to the developer.
)
echo [exit code: %RC%]
echo [log file : %TEMP%\tomato-selftest-latest.log]
echo ------------------------------------------------------------------
echo.
popd
pause
endlocal
