@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title m3u8-Helfer

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 helper.py %*
    goto ende
)
where python >nul 2>nul
if %errorlevel%==0 (
    python helper.py %*
    goto ende
)

echo.
echo Python wurde nicht gefunden.
echo Bitte Python 3 installieren: https://www.python.org/downloads/
echo Beim Installieren "Add python.exe to PATH" ankreuzen.
echo.

:ende
echo.
echo Der Helfer wurde beendet.
pause
