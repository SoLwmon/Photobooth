@echo off
rem Downloads Cloudflare's free tunnel tool (cloudflared) so guests can download photos
rem from any phone (mobile data or any Wi-Fi). Needs internet once. No account needed.
setlocal
cd /d "%~dp0"
title ScareBooth - install online sharing

if exist "tools\cloudflared.exe" (
  echo cloudflared is already installed:
  "tools\cloudflared.exe" --version
  goto done
)

echo.
echo   Downloading cloudflared from Cloudflare's official GitHub releases...
echo.
if not exist tools mkdir tools
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'tools\cloudflared.exe'; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"

if not exist "tools\cloudflared.exe" (
  echo.
  echo   Download failed. Check the internet connection and try again.
  echo   You can also download "cloudflared-windows-amd64.exe" yourself from
  echo   https://github.com/cloudflare/cloudflared/releases , rename it to cloudflared.exe
  echo   and put it in the "tools" folder inside ScareBooth.
  echo.
  pause
  exit /b 1
)
"tools\cloudflared.exe" --version

:done
echo.
echo   Done. Restart ScareBooth. The operator console shows "Internet link online"
echo   when guests can download from any phone.
echo.
pause
