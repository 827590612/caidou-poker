@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Poker Server
echo Starting poker server...
echo.
node server.js
echo.
echo Server stopped.
pause
