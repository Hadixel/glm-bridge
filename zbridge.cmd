@echo off
rem zbridge — interactive dashboard & CLI wrapper for glm-bridge
setlocal
set "SCRIPT=%~dp0zbridge.js"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found in PATH. Install Node 22+ and reopen the terminal.
  exit /b 1
)
node "%SCRIPT%" %*
endlocal
