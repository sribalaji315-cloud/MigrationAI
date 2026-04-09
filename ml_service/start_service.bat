@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "ENV_FILE=%SCRIPT_DIR%.env"
set "VENV_PY=%PROJECT_DIR%\.venv\Scripts\python.exe"
set "LOCAL_PORT=8013"

if not exist "%VENV_PY%" (
	echo ERROR: Project virtual environment Python not found: %VENV_PY%
	exit /b 1
)

if exist "%ENV_FILE%" (
	for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
		if /I "%%A"=="LOCAL_PORT" set "LOCAL_PORT=%%B"
	)
)

cd /d "%SCRIPT_DIR%"

echo Starting ML Classification Service...
echo.
echo Service will be available at: http://127.0.0.1:%LOCAL_PORT%
echo API endpoint: http://127.0.0.1:%LOCAL_PORT%/predict
echo Health check: http://127.0.0.1:%LOCAL_PORT%/health
echo Python: %VENV_PY%
echo.
echo Press Ctrl+C to stop the service
echo.
"%VENV_PY%" -m uvicorn app:app --host 127.0.0.1 --port %LOCAL_PORT%
endlocal
