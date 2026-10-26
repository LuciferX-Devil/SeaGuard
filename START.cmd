@echo off
cd /d "%~dp0"
"%~dp0runtime\node.exe" launch.mjs
if errorlevel 1 pause
