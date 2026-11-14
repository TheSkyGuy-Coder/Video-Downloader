@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title m3u8-Helfer bauen

where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% --version >nul 2>nul || (echo Python 3 nicht gefunden. https://www.python.org/downloads/ & pause & exit /b 1)

echo [1/5] Virtuelle Umgebung...
if not exist .venv %PY% -m venv .venv || goto fehler
call .venv\Scripts\activate.bat

echo [2/5] Pakete installieren...
python -m pip install --upgrade pip >nul
python -m pip install -r requirements-build.txt || goto fehler

echo [3/5] Symbol erzeugen...
python make_icon.py || goto fehler

echo [4/5] App bauen (PyInstaller)...
pyinstaller --noconfirm --clean --windowed --onedir --name "m3u8-Helfer" --icon icon.ico --add-data "dashboard.html;." app.py || goto fehler

echo [5/5] yt-dlp und ffmpeg in den Ordner "tools" legen...
set OUT=dist\m3u8-Helfer
if not exist "%OUT%\tools" mkdir "%OUT%\tools"
if not exist "%OUT%\tools\yt-dlp.exe" (
    powershell -NoProfile -Command "Invoke-WebRequest https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -OutFile '%OUT%\tools\yt-dlp.exe'" || echo   yt-dlp konnte nicht geladen werden - bitte yt-dlp.exe von Hand in "%OUT%\tools" legen.
)
if not exist "%OUT%\tools\ffmpeg.exe" (
    where ffmpeg >nul 2>nul && (
        echo   ffmpeg ist im PATH, wird von dort benutzt.
    ) || (
        echo   Lade ffmpeg ^(ca. 150 MB^)...
        powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip -OutFile ffmpeg.zip; Expand-Archive ffmpeg.zip -DestinationPath ffmpeg_tmp -Force; Copy-Item (Get-ChildItem ffmpeg_tmp -Recurse -Filter ffmpeg.exe | Select -First 1).FullName '%OUT%\tools\ffmpeg.exe'; Copy-Item (Get-ChildItem ffmpeg_tmp -Recurse -Filter ffprobe.exe | Select -First 1).FullName '%OUT%\tools\ffprobe.exe'; Remove-Item ffmpeg.zip, ffmpeg_tmp -Recurse -Force" || echo   ffmpeg konnte nicht geladen werden - bitte ffmpeg.exe von Hand in "%OUT%\tools" legen.
    )
)

echo.
echo Fertig: %OUT%\m3u8-Helfer.exe
echo Den ganzen Ordner "%OUT%" kannst du verschieben, z. B. nach C:\Programme\.
pause
exit /b 0

:fehler
echo.
echo Das Bauen ist fehlgeschlagen. Meldung oben beachten.
pause
exit /b 1
