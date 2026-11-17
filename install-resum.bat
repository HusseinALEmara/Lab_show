@echo off
chcp 65001 >nul
title Lab show - Auto Installer (With Auto-Resume)

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
cd /d "%ROOT_DIR%"

set "CONTAINER_DIR=%ROOT_DIR%\.container"
set "NODE_BASE=%CONTAINER_DIR%\node"
set "NPM_CACHE=%CONTAINER_DIR%\npm-cache"
set "ELECTRON_CACHE=%CONTAINER_DIR%\electron-cache"
set "BUILDER_CACHE=%CONTAINER_DIR%\builder-cache"

if not exist "%CONTAINER_DIR%" mkdir "%CONTAINER_DIR%"
if not exist "%NODE_BASE%" mkdir "%NODE_BASE%"
if not exist "%NPM_CACHE%" mkdir "%NPM_CACHE%"
if not exist "%ELECTRON_CACHE%" mkdir "%ELECTRON_CACHE%"
if not exist "%BUILDER_CACHE%" mkdir "%BUILDER_CACHE%"

echo ==================================================
echo   Lab show - Auto-Resume Container Installer
echo ==================================================

:: 1. البحث عن Node.js داخل الحاوية
set "NODE_BIN="
for /r "%NODE_BASE%" %%F in (node.exe) do (
    if exist "%%F" (
        set "NODE_BIN=%%~dpF"
        goto :NODE_READY
    )
)

:GET_NODE_URL
echo [1/4] Checking latest Node.js LTS version...
set "NODE_URL="
for /f "usebackq delims=" %%U in (powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $r = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.lts -ne $false -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1; if ($r) { Write-Output ('https://nodejs.org/dist/' + $r.version + '/node-' + $r.version + '-win-x64.zip') }") do (
    set "NODE_URL=%%U"
)

if "%NODE_URL%"=="" (
    echo [WAIT] No internet connection. Retrying in 5 seconds...
    timeout /t 5 /nobreak >nul
    goto :GET_NODE_URL
)

set "ZIP_PATH=%CONTAINER_DIR%\node.zip"

:DOWNLOAD_NODE
echo [1/4] Downloading Node.js (resumes automatically if disconnected)...
curl.exe -L -C - --connect-timeout 15 --speed-time 20 --speed-limit 1024 -o "%ZIP_PATH%" "%NODE_URL%"
if %errorlevel% EQU 0 goto :EXTRACT_NODE
if %errorlevel% EQU 33 goto :EXTRACT_NODE
echo [WAIT] Connection lost. Resuming download from where it stopped in 5 seconds...
timeout /t 5 /nobreak >nul
goto :DOWNLOAD_NODE

:EXTRACT_NODE
echo       Extracting Node.js into .container...
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP_PATH%' -DestinationPath '%NODE_BASE%' -Force"
if errorlevel 1 (
    echo [RETRY] Archive incomplete or damaged. Re-downloading...
    if exist "%ZIP_PATH%" del /f /q "%ZIP_PATH%"
    goto :DOWNLOAD_NODE
)
if exist "%ZIP_PATH%" del /f /q "%ZIP_PATH%"

for /r "%NODE_BASE%" %%F in (node.exe) do (
    if exist "%%F" (
        set "NODE_BIN=%%~dpF"
        goto :NODE_READY
    )
)
echo [ERROR] node.exe not found after extraction.
pause
exit /b 1

:NODE_READY
if "%NODE_BIN:~-1%"=="\" set "NODE_BIN=%NODE_BIN:~0,-1%"
echo [1/4] Node.js ready inside .container.

:: عزل المسارات والذاكرة المؤقتة داخل .container
set "PATH=%NODE_BIN%;%PATH%"
set "npm_config_cache=%NPM_CACHE%"
set "npm_config_fetch_retries=10"
set "npm_config_fetch_retry_mintimeout=5000"
set "npm_config_fetch_retry_maxtimeout=30000"
set "ELECTRON_CACHE=%ELECTRON_CACHE%"
set "ELECTRON_BUILDER_CACHE=%BUILDER_CACHE%"
set "CSC_IDENTITY_AUTO_DISCOVERY=false"

:: 2. تثبيت المكتبات مع إعادة المحاولة التلقائية من الكاش عند الانقطاع
:INSTALL_DEPS
echo [2/4] Installing app packages (auto-resumes on disconnect)...
call "%NODE_BIN%\npm.cmd" install --no-audit --no-fund
if errorlevel 1 (
    echo [WAIT] Download interrupted. Retrying from cache in 5 seconds...
    timeout /t 5 /nobreak >nul
    goto :INSTALL_DEPS
)

:: 3. بناء ملف التثبيت exe مع إعادة المحاولة التلقائية عند الانقطاع
:BUILD_APP
echo [3/4] Building Lab show Windows Installer (.exe)...
call "%NODE_BIN%\npm.cmd" run build
if errorlevel 1 (
    echo [WAIT] Build interrupted. Retrying in 5 seconds...
    timeout /t 5 /nobreak >nul
    goto :BUILD_APP
)

:: 4. إنشاء run.bat وتشغيل معالج التثبيت النهائي
(
    echo @echo off
    echo set "PATH=%NODE_BIN%;%%PATH%%"
    echo cd /d "%%~dp0"
    echo start "" "%NODE_BIN%\npm.cmd" start
) > "%ROOT_DIR%\run.bat"
set "SETUP_EXE="
for %%E in ("%ROOT_DIR%\dist\*Setup*.exe") do set "SETUP_EXE=%%E"

if not "%SETUP_EXE%"=="" (
    echo [4/4] Done! Launching installer: %SETUP_EXE%
    start "" "%SETUP_EXE%"
) else (
    echo [4/4] Build finished. Check the dist folder.
)

echo.
pause