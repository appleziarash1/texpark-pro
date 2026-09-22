@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo ============================================
  echo  First-time setup - installing app packages
  echo  This needs internet and takes a few minutes
  echo ============================================
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo INSTALL FAILED. Please install Node.js LTS first:
    echo https://nodejs.org
    pause
    exit /b 1
  )
)
echo Starting Texpark Pro Business Manager...
start "Texpark Pro Business Manager" cmd /c "npm.cmd start"
