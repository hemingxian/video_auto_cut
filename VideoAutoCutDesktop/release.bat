@echo off
setlocal
cd /d "%~dp0"
title VideoAutoCut Release Tool

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] npm was not found. Install Node.js first.
  goto :failed
)

if not exist "release-upload.local.json" (
  echo.
  echo [ERROR] release-upload.local.json was not found.
  echo Configure Tencent COS before publishing.
  goto :failed
)

call npm ls --depth=0 >nul 2>nul
if errorlevel 1 (
  echo.
  echo [INFO] Installing missing release dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [ERROR] Release dependencies could not be installed.
    goto :failed
  )
)

call npm run build:scripts
if errorlevel 1 (
  echo.
  echo [ERROR] Release scripts could not be compiled.
  goto :failed
)

:menu
cls
echo ========================================
echo          VideoAutoCut Release Tool
echo ========================================
echo.
echo   1. Package and upload desktop app
echo   2. Package and upload video engine
echo   3. Package and upload both
echo.
echo   4. Package desktop app only
echo   5. Package video engine only
echo   6. Package both without uploading
echo.
echo   0. Exit
echo.
set "RELEASE_COMMAND="
set "RELEASE_CHOICE="
set "RELEASE_DESKTOP="
set "RELEASE_RUNTIME="
set /p "RELEASE_CHOICE=Select an option: "
if not defined RELEASE_CHOICE exit /b 0

if "%RELEASE_CHOICE%"=="1" (
  set "RELEASE_COMMAND=dist:publish"
  set "RELEASE_DESKTOP=1"
)
if "%RELEASE_CHOICE%"=="2" (
  set "RELEASE_COMMAND=runtime:publish"
  set "RELEASE_RUNTIME=1"
)
if "%RELEASE_CHOICE%"=="3" (
  set "RELEASE_COMMAND=release"
  set "RELEASE_DESKTOP=1"
  set "RELEASE_RUNTIME=1"
)
if "%RELEASE_CHOICE%"=="4" (
  set "RELEASE_COMMAND=release:pack:desktop"
  set "RELEASE_DESKTOP=1"
)
if "%RELEASE_CHOICE%"=="5" (
  set "RELEASE_COMMAND=runtime:pack"
  set "RELEASE_RUNTIME=1"
)
if "%RELEASE_CHOICE%"=="6" (
  set "RELEASE_COMMAND=release:pack"
  set "RELEASE_DESKTOP=1"
  set "RELEASE_RUNTIME=1"
)
if "%RELEASE_CHOICE%"=="0" exit /b 0

if not defined RELEASE_COMMAND (
  echo.
  echo [NOTICE] Enter a number from 0 to 6.
  pause >nul
  goto :menu
)

if defined RELEASE_DESKTOP (
  for /f "delims=" %%V in ('node dist-scripts/release-version.js current-desktop') do set "CURRENT_VERSION=%%V"
) else (
  for /f "delims=" %%V in ('node dist-scripts/release-version.js current-runtime') do set "CURRENT_VERSION=%%V"
)

echo.
set "RELEASE_VERSION="
set /p "RELEASE_VERSION=Version [%CURRENT_VERSION%]: "
if not defined RELEASE_VERSION set "RELEASE_VERSION=%CURRENT_VERSION%"
node dist-scripts/release-version.js validate "%RELEASE_VERSION%" >nul
if errorlevel 1 goto :failed

if defined RELEASE_DESKTOP (
  node dist-scripts/release-version.js set-desktop "%RELEASE_VERSION%" >nul
  if errorlevel 1 goto :failed
)
if defined RELEASE_RUNTIME set "VIDEOAUTO_RUNTIME_VERSION=%RELEASE_VERSION%"

echo.
echo [START] Version %RELEASE_VERSION% - npm run %RELEASE_COMMAND%
echo.
call npm run %RELEASE_COMMAND%
if errorlevel 1 goto :failed

echo.
echo ========================================
echo [DONE] Release task completed successfully.
echo ========================================
echo.
pause
exit /b 0

:failed
echo.
echo ========================================
echo [FAILED] Review the error output above.
echo ========================================
echo.
pause
exit /b 1
