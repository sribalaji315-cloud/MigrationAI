@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "WORKSPACE_DIR=%SCRIPT_DIR%.."
set "ENV_FILE=%SCRIPT_DIR%.env"
set "VENV_PY=%SCRIPT_DIR%..\.venv\Scripts\python.exe"
set "LOCAL_PORT=8000"
cd /d "%SCRIPT_DIR%"

if not exist "%VENV_PY%" (
  echo ERROR: Workspace virtual environment Python not found: %VENV_PY%
  exit /b 1
)

if exist "%ENV_FILE%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if /I "%%A"=="LOCAL_PORT" set "LOCAL_PORT=%%B"
  )
)

set "DATA_FILE=%~1"
if "%DATA_FILE%"=="" set "DATA_FILE=training_data_template.csv"

echo ======================================================
echo Local ML: Retrain and Restart
echo Data file: %DATA_FILE%
echo ======================================================
echo.

if not exist "%DATA_FILE%" (
  echo ERROR: Training file not found: %DATA_FILE%
  echo Usage: retrain_and_restart.bat your_data.csv
  exit /b 1
)

if not exist "..\Class.csv" (
  echo ERROR: Class catalog file not found: ..\Class.csv
  echo Put Class.csv at project root and retry.
  exit /b 1
)

echo [1/3] Training model...
"%VENV_PY%" train_model.py --data "%DATA_FILE%" --class-file "..\Class.csv" --class-column Classification --text-column description --label-column class --output-dir model
if errorlevel 1 (
  echo.
  echo ERROR: Training failed.
  exit /b 1
)

echo.
echo [2/3] Stopping existing service on port %LOCAL_PORT% (if running)...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%LOCAL_PORT%" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /F >nul 2>&1
)

echo.
echo [3/3] Starting local ML API on http://127.0.0.1:%LOCAL_PORT% ...
start "Local ML Service" cmd /k "cd /d "%WORKSPACE_DIR%" && "%VENV_PY%" -m uvicorn local_ml_service.app:app --host 127.0.0.1 --port %LOCAL_PORT%"

echo.
echo Done. New service window launched.
echo Health: http://127.0.0.1:%LOCAL_PORT%/health
endlocal
