@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist .venv (
  echo 正在创建虚拟环境...
  python -m venv .venv
)
.venv\Scripts\python.exe -m pip install -q -r requirements.txt
set PYTHONPATH=%~dp0
echo.
echo ============================================
echo   AI 视觉小说生成器已启动： http://127.0.0.1:8765
echo   关闭此窗口即停止服务
echo ============================================
.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8765
pause
