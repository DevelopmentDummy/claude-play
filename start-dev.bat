@echo off
cd /d "%~dp0"

REM Start ComfyUI submodule if installed
if exist "comfyui_submodule\main.py" (
  if exist "comfyui_submodule\venv\Scripts\python.exe" (
    echo Starting ComfyUI...
    start "ComfyUI" cmd /c "cd /d "%~dp0comfyui_submodule" && venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188"
  )
)

npm run dev
