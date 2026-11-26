@echo off
setlocal EnableExtensions
title ScareBooth server  (keep this window open)
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  ScareBooth launcher
rem   1. checks Node.js
rem   2. starts the local server
rem   3. opens the booth display full-screen (kiosk) and the operator console
rem
rem  Optional settings (edit here, or set them before running):
rem    PORT                    web port (default 8080)
rem    SCAREBOOTH_DISPLAY_POS  "x,y" desktop position of the booth monitor, e.g. 1920,0
rem                            (leave empty to use the main Windows display)
rem    SCAREBOOTH_BROWSER      chrome | edge   (default: Chrome if installed, else Edge)
rem    SCAREBOOTH_NO_KIOSK     set to 1 to open the display in a normal window
rem ---------------------------------------------------------------------------
if "%PORT%"=="" set PORT=8080

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ERROR: Node.js is not installed.
  echo.
  echo   Install the free "LTS" version from https://nodejs.org  ^(one-time, needs internet^),
  echo   then double-click start-scarebooth.bat again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 18 (
  echo.
  echo   ERROR: Node.js 18 or newer is required ^(found:
  node -v
  echo   ^). Please install the current LTS from https://nodejs.org
  echo.
  pause
  exit /b 1
)

rem Already running? Then don't start a second server (it would fail: the port is taken).
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:%PORT%/api/state | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo   ScareBooth is already running ^(another server window is open^).
  echo   Opening the operator console. Close this window.
  echo.
  start "" "http://localhost:%PORT%/admin"
  timeout /t 6 >nul
  exit /b 0
)

rem Open the browsers once the server is answering (runs in the background).
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-browsers.ps1" -Port %PORT%

node "%~dp0server\server.js"

echo.
echo   The ScareBooth server has stopped.
pause
