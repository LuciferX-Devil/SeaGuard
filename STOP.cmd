@echo off
cd /d "%~dp0"
"%~dp0runtime\node.exe" launch.mjs stop
pause
