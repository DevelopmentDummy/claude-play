@echo off
cd /d "%~dp0"

REM Start ComfyUI submodule if installed
if exist "comfyui_submodule\main.py" (
  if exist "comfyui_submodule\venv\Scripts\python.exe" (
    echo Starting ComfyUI...
    start "ComfyUI" "%~dp0start-comfyui.bat"
  ) else (
    echo [warn] ComfyUI found but venv missing. Run: cd comfyui_submodule ^&^& python -m venv venv ^&^& venv\Scripts\pip install -r requirements.txt
  )
)

echo Building...
call npm run build
if errorlevel 1 (
  echo Build failed!
  pause
  exit /b 1
)
echo Starting production server...
npm run start
