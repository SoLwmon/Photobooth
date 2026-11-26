@echo off
title ScareBooth server  (keep this window open)
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8080
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org & pause & exit /b 1)
echo Starting ScareBooth without opening any browser windows...
node "%~dp0server\server.js"
pause
