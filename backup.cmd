@echo off
rem Makes a safe backup of the Edulet data (database + uploaded files) in the backups folder next to this file.
rem Safe to run while the server is on: the original data is only read, never changed. Needs Node.js 22.13 or newer.
rem Exit code: 0 = complete backup, 1 = failed (nothing left behind), 2 = backup made but with warnings (some files may be missing).
setlocal
rem Always run from this folder (same reason as run.cmd): the tool finds the data folder from its own location.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.13+ is required: https://nodejs.org & pause & exit /b 1)
node --disable-warning=ExperimentalWarning tools\backup.mjs %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="2" (echo Backup finished WITH WARNINGS - read the messages above.) else if not "%RC%"=="0" (echo Backup FAILED - see the message above. Nothing was left behind and your data was not changed.)
echo Safe to run while the server is on. Backups are in the backups folder.
pause
exit /b %RC%
