@echo off
cd /d "%~dp0comfyui_submodule"
echo ComfyUI starting on http://127.0.0.1:8188
venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188
