@echo off
cd /d "%~dp0"
python -c "import websockets" 2>nul
if errorlevel 1 (
  echo Installing the local room server dependency...
  python -m pip install "websockets>=15,<17"
  if errorlevel 1 goto failed
)
python lan_server.py
if errorlevel 1 goto failed
exit /b
:failed
echo The local server could not start. Keep this message for troubleshooting.
pause
