@echo off
title SCAdmin
cd /d "%~dp0"
echo Starting SCAdmin on http://localhost:8080
node server.js
pause
