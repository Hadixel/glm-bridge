# glm-bridge — local OpenAI/Anthropic bridge for Z.ai GLM (ZCode start plan)
# Cross-platform CLI wrapper for Windows.
# Usage: glm-bridge.cmd start|stop|restart|status|logs [n]|run
@echo off
setlocal
set "SCRIPT=%~dp0glm-bridge.js"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found in PATH. Install Node 22+ and reopen the terminal.
  exit /b 1
)
node "%SCRIPT%" %*
endlocal
