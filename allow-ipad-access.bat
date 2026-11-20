@echo off
rem Adds a Windows Firewall rule so the iPad can reach ScareBooth on this PC.
rem Needs administrator rights (it will ask).
if "%PORT%"=="" set PORT=8080

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

netsh advfirewall firewall delete rule name="ScareBooth (TCP %PORT%)" >nul 2>&1
netsh advfirewall firewall add rule name="ScareBooth (TCP %PORT%)" dir=in action=allow protocol=TCP localport=%PORT% profile=private,domain,public
if errorlevel 1 (
  echo.
  echo   Could not add the firewall rule. Ask your IT admin to allow inbound TCP port %PORT%.
) else (
  echo.
  echo   Done. The iPad can now connect to this PC on port %PORT%.
  echo   If it still can't, make sure the PC and iPad are on the SAME Wi-Fi network and that
  echo   "client isolation" / "guest mode" is off on the router.
)
echo.
pause
