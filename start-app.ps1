<#
.SYNOPSIS
    Start, stop, or restart the ERP Data Migrator services.

.DESCRIPTION
    Manages the backend (FastAPI/uvicorn on port 8000), the standalone ML prediction
    service (port 8014), and frontend (Vite on port 3000).
    Environment variables are loaded from backend/.env automatically.
    The LAN IP is detected and added to ALLOWED_ORIGINS so both localhost
    and network clients can access the app.
    PID files are stored in .pids/ for clean shutdown.

.PARAMETER Action
    start   - Launch the service(s) in new PowerShell windows
    stop    - Stop running service(s) by PID + port-based fallback
    restart - Stop then start

.PARAMETER Mode
    all       - Backend, frontend, and ML service (default)
    backend   - Backend only
    frontend  - Frontend only
    mlservice - ML classification service only

.EXAMPLE
    .\start-app.ps1                            # Start everything
    .\start-app.ps1 -Action start              # Same as above
    .\start-app.ps1 -Action stop               # Stop everything
    .\start-app.ps1 -Action restart            # Restart everything
    .\start-app.ps1 -Action start -Mode backend   # Start backend only
    .\start-app.ps1 -Action stop  -Mode frontend  # Stop frontend only
    .\.\start-app.ps1 -Action restart -Mode backend    # Restart backend only
    .\.\start-app.ps1 -Action start -Mode mlservice   # Start ML service only

.NOTES
    Prerequisites:
      - Python venv at .venv\  (python -m venv .venv)
      - pip install -r backend\requirements.txt
      - npm install
      - backend\.env with SECRET_KEY, ADMIN_EMAIL, ADMIN_PASSWORD
#>
param(
    [ValidateSet("start", "stop", "restart")]
    [string]$Action = "start",

    [ValidateSet("all", "backend", "frontend", "mlservice")]
    [string]$Mode = "all"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $root "backend"
$venvPython = Join-Path $root ".venv\Scripts\python.exe"
$pidDir = Join-Path $root ".pids"
$backendPidFile = Join-Path $pidDir "backend.pid"
$frontendPidFile = Join-Path $pidDir "frontend.pid"
$mlservicePidFile = Join-Path $pidDir "mlservice.pid"
$mlservicePath = Join-Path $root "ml_predict_service"

# Ensure .pids directory exists
if (-not (Test-Path $pidDir)) {
    New-Item -ItemType Directory -Path $pidDir -Force | Out-Null
}

# ---------------------------------------------------------------------------
# Detect the first non-loopback IPv4 address for LAN access
# ---------------------------------------------------------------------------
function Get-LanIP {
    $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -ne '127.0.0.1' -and
            $_.PrefixOrigin -notin @('WellKnown', 'LinkLocal') -and
            $_.AddressState -eq 'Preferred'
        } |
        Select-Object -ExpandProperty IPAddress
    if ($candidates -is [array]) { return $candidates[0] }
    if ($candidates) { return $candidates }
    return $null
}

# ---------------------------------------------------------------------------
# Load backend/.env into the environment so uvicorn picks up SECRET_KEY etc.
# ---------------------------------------------------------------------------
function Import-DotEnv {
    $envFile = Join-Path $backendPath ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith("#")) {
                $parts = $line -split "=", 2
                if ($parts.Count -eq 2) {
                    [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
                }
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Ensure ALLOWED_ORIGINS includes the LAN address
# ---------------------------------------------------------------------------
function Merge-AllowedOrigins {
    $lanIP = Get-LanIP
    if (-not $lanIP) { return }

    $script:LanIP = $lanIP
    $lanOrigin = "http://${lanIP}:3000"
    $current = $env:ALLOWED_ORIGINS
    if (-not $current) {
        $current = "http://localhost:3000,http://localhost:5173"
    }
    if ($current -notlike "*$lanOrigin*") {
        $env:ALLOWED_ORIGINS = "$current,$lanOrigin"
    }
}

# ---------------------------------------------------------------------------
# Stop helpers
# ---------------------------------------------------------------------------
function Stop-ServiceByPidFile([string]$pidFile, [string]$label) {
    if (Test-Path $pidFile) {
        $savedPid = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
        if ($savedPid) {
            # Kill entire process tree (parent shell + child python/node)
            Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $_.ParentProcessId -eq [int]$savedPid } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
            Write-Host "$label stopped (PID $savedPid)"
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    else {
        Write-Host "${label}: no PID file found, attempting port-based cleanup"
    }
}

function Stop-PortProcesses([int]$port) {
    # Two passes to catch child processes that re-bind after the parent dies
    for ($i = 0; $i -lt 2; $i++) {
        $pids = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
            Where-Object { $_.State -in @('Listen', 'Bound') } |
            Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($p in $pids) {
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        }
        if ($pids) { Start-Sleep -Milliseconds 500 }
    }
}

function Stop-Backend {
    Stop-ServiceByPidFile $backendPidFile "Backend"
    Stop-PortProcesses 8000
}

function Stop-Frontend {
    Stop-ServiceByPidFile $frontendPidFile "Frontend"
    Stop-PortProcesses 3000
    Stop-PortProcesses 5173
}

function Stop-MLService {
    Stop-ServiceByPidFile $mlservicePidFile "ML Service"
    Stop-PortProcesses 8014
}

# ---------------------------------------------------------------------------
# Start helpers
# ---------------------------------------------------------------------------
function Start-Backend {
    Import-DotEnv
    Merge-AllowedOrigins

    if (-not (Test-Path $venvPython)) {
        Write-Error "Python venv not found at $venvPython. Run: python -m venv .venv && .venv\Scripts\pip install -r backend\requirements.txt"
        return
    }

    # Run Alembic migrations before starting the server
    Write-Host "Running database migrations..."
    Push-Location $backendPath
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $alembicResult = & $venvPython -m alembic upgrade head 2>&1
    $alembicExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    Pop-Location
    # alembic prints info to stderr on SQLite, so only fail on actual errors
    $alembicErrors = $alembicResult | Where-Object { $_ -match "(?i)(error|exception|traceback|FAILED)" }
    if ($alembicExit -ne 0 -and $alembicErrors) {
        Write-Error "Alembic migration failed:`n$($alembicResult -join "`n")"
        return
    }
    $alembicResult | ForEach-Object { Write-Host "  $_" }
    Write-Host "Migrations complete."

    $backendCommand = @"
Set-Location '$backendPath'
`$env:SECRET_KEY            = '$($env:SECRET_KEY)'
`$env:ADMIN_EMAIL           = '$($env:ADMIN_EMAIL)'
`$env:ADMIN_PASSWORD        = '$($env:ADMIN_PASSWORD)'
`$env:ALLOWED_ORIGINS       = '$($env:ALLOWED_ORIGINS)'
`$env:ML_SERVICE_API_KEY    = '$($env:ML_SERVICE_API_KEY)'
`$env:ML_SERVICE_URL        = '$($env:ML_SERVICE_URL)'
& '$venvPython' -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
"@

    $proc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoExit", "-Command", $backendCommand `
        -PassThru
    $proc.Id | Out-File -FilePath $backendPidFile -Force

    Write-Host ""
    Write-Host "Backend started (PID $($proc.Id))"
    Write-Host "  Local:   http://localhost:8000"
    if ($script:LanIP) {
        Write-Host "  Network: http://$($script:LanIP):8000"
    }
}

function Start-MLService {
    if (-not (Test-Path $venvPython)) {
        Write-Error "Python venv not found at $venvPython."
        return
    }

    # Pre-run the service module once to ensure .env (with API_KEY) is generated
    $mlservicePathFwd = $mlservicePath -replace '\\', '/'
    & $venvPython -c "import sys; sys.path.insert(0,'$mlservicePathFwd'); from app import ensure_env_file; ensure_env_file()" 2>$null

    $mlCommand = @"
Set-Location '$mlservicePath'
& '$venvPython' -m uvicorn app:app --host 127.0.0.1 --port 8014
"@

    $proc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoExit", "-Command", $mlCommand `
        -PassThru
    $proc.Id | Out-File -FilePath $mlservicePidFile -Force

    Write-Host ""
    Write-Host "ML Service started (PID $($proc.Id))"
    Write-Host "  Local:   http://localhost:8014"
}

# ---------------------------------------------------------------------------
# Sync ML service API key into backend/.env so the backend can authenticate
# ---------------------------------------------------------------------------
function Sync-MLServiceApiKey {
    $mlEnvFile = Join-Path $mlservicePath ".env"
    $backendEnvFile = Join-Path $backendPath ".env"

    if (-not (Test-Path $mlEnvFile)) {
        Write-Host "ML Service .env not found at $mlEnvFile — skipping API key sync"
        return
    }

    # Read API_KEY from ml_predict_service/.env
    $mlApiKey = $null
    foreach ($rawLine in (Get-Content $mlEnvFile)) {
        $line = $rawLine.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line -split "=", 2
            if ($parts.Count -eq 2 -and $parts[0].Trim() -eq "API_KEY") {
                $mlApiKey = $parts[1].Trim()
            }
        }
    }

    if (-not $mlApiKey) {
        Write-Host "No API_KEY found in ML service .env — skipping sync"
        return
    }

    # Upsert ML_SERVICE_API_KEY and ML_SERVICE_URL in backend/.env
    $keysToSync = @{
        "ML_SERVICE_API_KEY" = $mlApiKey
        "ML_SERVICE_URL"     = "http://localhost:8014"
    }

    if (-not (Test-Path $backendEnvFile)) {
        # Create a minimal backend .env with just these keys
        $lines = @()
        foreach ($k in $keysToSync.Keys) {
            $lines += "$k=$($keysToSync[$k])"
        }
        # Write UTF-8 without BOM (PS 5.1's -Encoding utf8 adds BOM which breaks pydantic)
        [System.IO.File]::WriteAllText($backendEnvFile, ($lines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
        Write-Host "Created backend/.env with ML_SERVICE_API_KEY and ML_SERVICE_URL"
        return
    }

    $content = Get-Content $backendEnvFile -Raw
    foreach ($k in $keysToSync.Keys) {
        $v = $keysToSync[$k]
        if ($content -match "(?m)^$k=") {
            # Replace existing line
            $content = $content -replace "(?m)^$k=.*$", "$k=$v"
        } else {
            # Append
            if (-not $content.EndsWith("`n")) { $content += "`n" }
            $content += "$k=$v`n"
        }
    }
    # Write UTF-8 without BOM
    [System.IO.File]::WriteAllText($backendEnvFile, $content, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "DEBUG: Syncing API KEY: '$mlApiKey'" ; Write-Host "Synced ML_SERVICE_API_KEY and ML_SERVICE_URL into backend/.env"

    # Also set in current process so child inherits correct values
    foreach ($k in $keysToSync.Keys) {
        [Environment]::SetEnvironmentVariable($k, $keysToSync[$k], "Process")
    }
}

function Start-Frontend {
    $frontendCommand = "Set-Location '$root'; npm run dev"

    $proc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoExit", "-Command", $frontendCommand `
        -PassThru
    $proc.Id | Out-File -FilePath $frontendPidFile -Force

    Write-Host ""
    Write-Host "Frontend started (PID $($proc.Id))"
    Write-Host "  Local:   http://localhost:3000"
    if ($script:LanIP) {
        Write-Host "  Network: http://$($script:LanIP):3000"
    }
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
$script:LanIP = Get-LanIP

switch ($Action) {
    "stop" {
        if ($Mode -in "all", "backend")   { Stop-Backend }
        if ($Mode -in "all", "mlservice") { Stop-MLService }
        if ($Mode -in "all", "frontend")  { Stop-Frontend }
    }
    "start" {
        if ($Mode -in "all", "mlservice") { Start-MLService }
        if ($Mode -in "all", "backend")  { Write-Host "Skipping ML Sync to prevent wipe" ; Start-Backend }
        if ($Mode -in "all", "frontend") { Start-Frontend }
    }
    "restart" {
        if ($Mode -in "all", "mlservice") { Stop-MLService;  Start-Sleep 2; Start-MLService }
        if ($Mode -in "all", "backend")  { Stop-Backend;    Start-Sleep 2; Write-Host "Skipping ML Sync to prevent wipe" ; Start-Backend }
        if ($Mode -in "all", "frontend") { Stop-Frontend;   Start-Sleep 2; Start-Frontend }
    }
}

if ($Action -in "start", "restart") {
    Write-Host ""
    Write-Host "CORS allowed origins: $($env:ALLOWED_ORIGINS)"
    if ($script:LanIP) {
        Write-Host ""
        Write-Host "Share this with your team on the same WiFi network:"
        Write-Host "  http://$($script:LanIP):3000"
    }
}
