@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local_dev.ps1" -Action Stop
if errorlevel 1 pause
