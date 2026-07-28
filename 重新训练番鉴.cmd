@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\retrain-expanded.ps1"
if errorlevel 1 (
  echo.
  echo Retraining failed. See runtime\retrain-expanded-state.json.
  pause
)
