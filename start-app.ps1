param(
    [ValidateSet("all", "backend", "frontend")]
    [string]$Mode = "all"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $root "backend"
$venvPython = Join-Path $root ".venv\Scripts\python.exe"

function Start-Backend {
    if (Test-Path $venvPython) {
        $backendCommand = "Set-Location '$backendPath'; & '$venvPython' -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"
    }
    else {
        $backendCommand = "Set-Location '$backendPath'; uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"
    }

    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-Command", $backendCommand | Out-Null
    Write-Host "Backend started in a new PowerShell window at http://localhost:8000"
}

function Start-Frontend {
    $frontendCommand = "Set-Location '$root'; npm run dev"
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-Command", $frontendCommand | Out-Null
    Write-Host "Frontend started in a new PowerShell window (usually http://localhost:5173)"
}

switch ($Mode) {
    "backend" {
        Start-Backend
    }
    "frontend" {
        Start-Frontend
    }
    "all" {
        Start-Backend
        Start-Frontend
    }
}
