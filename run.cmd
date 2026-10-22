@echo off
rem Starts Edulet on http://localhost:3000 and opens it in the default browser.
rem Needs Node.js 22.13 or newer. Data is kept in the data folder next to this file.
setlocal
rem Always run from this folder: the data folder (./data) is created relative to where the server is started,
rem so starting from a shortcut/taskbar/another folder would otherwise create a NEW empty data folder.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.13+ is required: https://nodejs.org & pause & exit /b 1)
if "%EDULET_PORT%"=="" set "EDULET_PORT=3000"
start "" "http://localhost:%EDULET_PORT%/b/practice"
echo Other PCs and phones on the same Wi-Fi or LAN: open the address printed below the local one.
echo If it does not open, allow Node.js in Windows Firewall.
node --disable-warning=ExperimentalWarning "%~dp0server\index.js"
pause
