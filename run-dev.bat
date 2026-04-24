@echo off
setlocal

REM Run the ReEdit dev server (Vite + Electron) from a fresh console.
REM
REM We unset ELECTRON_RUN_AS_NODE first because a global user env var by
REM that name makes Electron boot as plain Node, which leaves `app` /
REM `BrowserWindow` undefined and crashes with:
REM    TypeError: Cannot read properties of undefined (reading 'isPackaged')
REM at electron/main.js:21. Wiping it for this shell only is harmless if
REM it wasn't set in the first place.

set "ELECTRON_RUN_AS_NODE="

cd /d "%~dp0"
if errorlevel 1 (
  echo Could not cd into script directory "%~dp0".
  pause
  exit /b 1
)

echo ==========================================
echo Starting ReEdit dev server ^(Vite + Electron^)
echo Working dir: %CD%
echo ==========================================

call npm run electron:dev

REM If Electron quits (user closes the window), keep the console open so
REM any error messages stay readable instead of vanishing instantly.
echo.
echo ==========================================
echo ReEdit dev server exited.
echo ==========================================
pause
