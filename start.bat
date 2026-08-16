@echo off
cd /d "%~dp0"

REM ComfyUI is launched by server.ts when COMFYUI_AUTOSTART=true (path: COMFYUI_DIR in .env.local)

echo Starting production server...
npm run start
