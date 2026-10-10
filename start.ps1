<#
.SYNOPSIS
    Starts and installs Tsukumo on Windows.

.DESCRIPTION
    One script, so you don't have to remember the sequence of commands.

.EXAMPLE
    .\start.ps1 -Setup
    Creates the virtualenv, installs the Python and Node dependencies,
    downloads the Kokoro weights and builds the frontend. Run it once.

.EXAMPLE
    .\start.ps1
    Starts the backend (which also serves the frontend) on http://127.0.0.1:8770

.EXAMPLE
    .\start.ps1 -Dev
    Backend + Vite dev server with hot reload, in two separate windows.

.EXAMPLE
    .\start.ps1 -Electron
    Opens the frameless desktop window (it starts the backend by itself).

.EXAMPLE
    .\start.ps1 -Shortcut
    Creates the "Tsukumo" shortcut on the desktop (no terminal).

.EXAMPLE
    .\start.ps1 -Test
    Runs the backend tests (pytest).
#>

[CmdletBinding()]
param(
    [switch]$Setup,
    [switch]$Dev,
    [switch]$Electron,
    [switch]$Shortcut,
    [switch]$Test,
    [ValidateSet('full', 'fp16', 'int8')]
    [string]$KokoroVariant = 'full'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

$venvPython = Join-Path $root '.venv\Scripts\python.exe'

function Write-Step([string]$message) {
    Write-Host ''
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Get-Python {
    if (Test-Path $venvPython) { return $venvPython }
    $command = Get-Command python -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw 'Python not found in the PATH. Install Python 3.10 or later.'
    }
    return $command.Source
}

function Assert-Node {
    if ($null -eq (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm not found in the PATH. Install Node.js 22.12 or later (Electron needs it).'
    }
}

# ---------------------------------------------------------------- setup ----
if ($Setup) {
    Write-Step 'Creating the virtualenv (.venv)'
    if (-not (Test-Path $venvPython)) {
        python -m venv .venv
    } else {
        Write-Host '    already there, reusing it'
    }

    Write-Step 'Installing the Python dependencies'
    & $venvPython -m pip install --upgrade pip
    & $venvPython -m pip install -r requirements.txt

    Write-Step "Downloading the Kokoro weights ($KokoroVariant)"
    & $venvPython scripts\download_models.py --variant $KokoroVariant

    Assert-Node
    Write-Step 'Installing and building the frontend'
    Push-Location frontend
    npm install
    npm run build
    Pop-Location

    Write-Step 'Installing Electron (desktop window, optional)'
    Push-Location electron
    npm install
    Pop-Location

    Write-Host ''
    Write-Host 'Setup complete.' -ForegroundColor Green
    Write-Host 'Start with:  .\start.ps1 -Electron   (or .\start.ps1 -Shortcut for a desktop icon)'
    return
}

# ------------------------------------------------------------- shortcut ----
if ($Shortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell

    # The shortcut with the old name points to a script that no longer exists.
    $legacy = Join-Path $desktop 'Desk Companion.lnk'
    if (Test-Path $legacy) {
        $old = $shell.CreateShortcut($legacy)
        if ($old.Arguments -like '*Desk Companion.vbs*') {
            Remove-Item $legacy
            Write-Host "Removed the old shortcut: $legacy"
        }
    }

    $target = Join-Path $desktop 'Tsukumo.lnk'
    $link = $shell.CreateShortcut($target)
    $link.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $link.Arguments = '"' + (Join-Path $root 'Tsukumo.vbs') + '"'
    $link.WorkingDirectory = $root
    $icon = Join-Path $root 'electron\icon.ico'
    if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
    $link.Description = 'Start Tsukumo'
    $link.Save()
    Write-Host "Shortcut created: $target" -ForegroundColor Green
    return
}

# ----------------------------------------------------------------- test ----
if ($Test) {
    $python = Get-Python
    & $python -m pip show pytest *> $null
    if ($LASTEXITCODE -ne 0) { & $python -m pip install -r requirements-dev.txt }
    & $python -m pytest -q
    exit $LASTEXITCODE
}

$python = Get-Python

# Useful warnings before starting ---------------------------------------------
if (-not (Test-Path (Join-Path $root 'models\kokoro-v1.0.onnx'))) {
    Write-Host 'WARNING: Kokoro weights missing.' -ForegroundColor Yellow
    Write-Host "  Download them with:  $python scripts\download_models.py"
    Write-Host '  Without the weights the backend uses the fallback "formant" voice.'
}

# ------------------------------------------------------------- electron ----
if ($Electron) {
    Assert-Node
    if (-not (Test-Path (Join-Path $root 'electron\node_modules'))) {
        Write-Step 'Installing the Electron dependencies'
        Push-Location electron
        npm install
        Pop-Location
    }
    Write-Step 'Opening the desktop window'
    Push-Location electron
    $env:DC_PYTHON = $python
    npm start
    Pop-Location
    return
}

# ------------------------------------------------------------------ dev ----
if ($Dev) {
    Assert-Node
    Write-Step 'Starting the backend in a new window'
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-Command',
        "Set-Location '$root'; & '$python' -m backend --reload"
    )

    Write-Step 'Starting the Vite dev server (hot reload on http://localhost:5173)'
    Push-Location frontend
    if (-not (Test-Path 'node_modules')) { npm install }
    npm run dev
    Pop-Location
    return
}

# --------------------------------------------------------------- normal ----
if (-not (Test-Path (Join-Path $root 'frontend\dist\index.html'))) {
    Write-Host 'Frontend not built: building it now.' -ForegroundColor Yellow
    Assert-Node
    Push-Location frontend
    if (-not (Test-Path 'node_modules')) { npm install }
    npm run build
    Pop-Location
}

Write-Step 'Starting Tsukumo on http://127.0.0.1:8770'
& $python -m backend
