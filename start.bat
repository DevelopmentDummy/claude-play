@echo off
cd /d "%~dp0"
echo Building...
call npm run build
if errorlevel 1 (
  echo Build failed!
  pause
  exit /b 1
)
echo Starting production server...
npm run start
