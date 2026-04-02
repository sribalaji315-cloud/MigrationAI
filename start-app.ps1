<#
.SYNOPSIS
    Start, stop, or restart the ERP Data Migrator services.

.DESCRIPTION
    Manages the backend (FastAPI/uvicorn on port 8000) and frontend (Vite on port 3000).
    Environment variables are loaded from backend/.env automatically.
    The LAN IP is detected and added to ALLOWED_ORIGINS so both localhost
    and network clients can access the app.
    PID files are stored in .pids/ for clean shutdown.

.PARAMETER Action
    start   - Launch the service(s) in new PowerShell windows
    stop    - Stop running service(s) by PID + port-based fallback
    restart - Stop then start

.PARAMETER Mode
    all      - Both backend and frontend (default)
    backend  - Backend only
    frontend - Frontend only

.EXAMPLE
    .\start-app.ps1                            # Start everything
    .\start-app.ps1 -Action start              # Same as above
    .\start-app.ps1 -Action stop               # Stop everything
    .\start-app.ps1 -Action restart            # Restart everything
    .\start-app.ps1 -Action start -Mode backend   # Start backend only
    .\start-app.ps1 -Action stop  -Mode frontend  # Stop frontend only
    .\start-app.ps1 -Action restart -Mode backend  # Restart backend only

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

    [ValidateSet("all", "backend", "frontend")]
    [string]$Mode = "all"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $root "backend"
$venvPython = Join-Path $root ".venv\Scripts\python.exe"
$pidDir = Join-Path $root ".pids"
$backendPidFile = Join-Path $pidDir "backend.pid"
$frontendPidFile = Join-Path $pidDir "frontend.pid"

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

    $backendCommand = @"
Set-Location '$backendPath'
`$env:SECRET_KEY       = '$($env:SECRET_KEY)'
`$env:ADMIN_EMAIL      = '$($env:ADMIN_EMAIL)'
`$env:ADMIN_PASSWORD   = '$($env:ADMIN_PASSWORD)'
`$env:ALLOWED_ORIGINS  = '$($env:ALLOWED_ORIGINS)'
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
        if ($Mode -in "all", "backend")  { Stop-Backend }
        if ($Mode -in "all", "frontend") { Stop-Frontend }
    }
    "start" {
        if ($Mode -in "all", "backend")  { Start-Backend }
        if ($Mode -in "all", "frontend") { Start-Frontend }
    }
    "restart" {
        if ($Mode -in "all", "backend")  { Stop-Backend;  Start-Sleep 2; Start-Backend }
        if ($Mode -in "all", "frontend") { Stop-Frontend; Start-Sleep 2; Start-Frontend }
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
