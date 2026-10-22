@echo off
rem Starts Edulet on http://localhost:3000 and opens it in the default browser.
rem Needs Node.js 22.13 or newer. Data is kept in the data folder next to this file.
setlocal
where node >nul 2>nul || (echo Node.js 22.13+ is required: https://nodejs.org & pause & exit /b 1)
if "%EDULET_PORT%"=="" set "EDULET_PORT=3000"
start "" "http://localhost:%EDULET_PORT%/b/practice"
node --disable-warning=ExperimentalWarning "%~dp0server\index.js"
pause
