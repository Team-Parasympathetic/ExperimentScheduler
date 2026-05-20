@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\setup-lab-app.ps1"

if errorlevel 1 (
  echo.
  echo Setup failed. Check the messages above.
  pause
  exit /b 1
)

echo.
echo Setup complete. You can launch Experiment Scheduler from the Desktop or Start Menu shortcut.
pause
