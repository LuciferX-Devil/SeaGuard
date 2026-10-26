@echo off
cd /d "%~dp0"
"%~dp0runtime\node.exe" verify.mjs
pause
