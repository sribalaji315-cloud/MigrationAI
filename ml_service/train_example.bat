@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "VENV_PY=%SCRIPT_DIR%..\.venv\Scripts\python.exe"

if not exist "%VENV_PY%" (
	echo ERROR: Workspace virtual environment Python not found: %VENV_PY%
	exit /b 1
)

cd /d "%SCRIPT_DIR%"

echo Training classifier with example data...
echo.
if not exist "..\Class.csv" (
	echo ERROR: Class catalog file not found at ..\Class.csv
	echo Place Class.csv at project root before training.
	exit /b 1
)

echo Python: %VENV_PY%
echo.
"%VENV_PY%" train_model.py --data training_data_template.csv --class-file "..\Class.csv" --class-column Classification --text-column description --label-column class --output-dir model
echo.
echo Training complete! Model saved to model/
echo.
pause
endlocal
