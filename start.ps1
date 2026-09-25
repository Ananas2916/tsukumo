<#
.SYNOPSIS
    Avvio e installazione di Tsukumo su Windows.

.DESCRIPTION
    Uno script unico per non dover ricordare la sequenza dei comandi.

.EXAMPLE
    .\start.ps1 -Setup
    Crea il virtualenv, installa le dipendenze Python e Node, scarica i pesi
    di Kokoro e compila il frontend. Da eseguire una volta sola.

.EXAMPLE
    .\start.ps1
    Avvia il backend (che serve anche il frontend) su http://127.0.0.1:8770

.EXAMPLE
    .\start.ps1 -Dev
    Backend + dev server Vite con hot reload, in due finestre separate.

.EXAMPLE
    .\start.ps1 -Electron
    Apre la finestra desktop senza cornice (avvia da sola il backend).

.EXAMPLE
    .\start.ps1 -Shortcut
    Crea sul desktop il collegamento "Tsukumo" (niente terminale).

.EXAMPLE
    .\start.ps1 -Test
    Esegue i test del backend (pytest).
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
        throw 'Python non trovato nel PATH. Installa Python 3.10 o superiore.'
    }
    return $command.Source
}

function Assert-Node {
    if ($null -eq (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm non trovato nel PATH. Installa Node.js 18 o superiore.'
    }
}

# ---------------------------------------------------------------- setup ----
if ($Setup) {
    Write-Step 'Creo il virtualenv (.venv)'
    if (-not (Test-Path $venvPython)) {
        python -m venv .venv
    } else {
        Write-Host '    gia presente, lo riuso'
    }

    Write-Step 'Installo le dipendenze Python'
    & $venvPython -m pip install --upgrade pip
    & $venvPython -m pip install -r requirements.txt

    Write-Step "Scarico i pesi di Kokoro ($KokoroVariant)"
    & $venvPython scripts\download_models.py --variant $KokoroVariant

    Assert-Node
    Write-Step 'Installo e compilo il frontend'
    Push-Location frontend
    npm install
    npm run build
    Pop-Location

    Write-Step 'Installo Electron (finestra desktop, opzionale)'
    Push-Location electron
    npm install
    Pop-Location

    Write-Host ''
    Write-Host 'Setup completato.' -ForegroundColor Green
    Write-Host 'Ricordati di copiare un avatar in frontend\public\models\avatar.vrm'
    Write-Host 'Poi avvia con:  .\start.ps1'
    return
}

# ------------------------------------------------------------- shortcut ----
if ($Shortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell

    # Il collegamento del vecchio nome punta a uno script che non c'e' piu'.
    $legacy = Join-Path $desktop 'Desk Companion.lnk'
    if (Test-Path $legacy) {
        $old = $shell.CreateShortcut($legacy)
        if ($old.Arguments -like '*Desk Companion.vbs*') {
            Remove-Item $legacy
            Write-Host "Rimosso il vecchio collegamento: $legacy"
        }
    }

    $target = Join-Path $desktop 'Tsukumo.lnk'
    $link = $shell.CreateShortcut($target)
    $link.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $link.Arguments = '"' + (Join-Path $root 'Tsukumo.vbs') + '"'
    $link.WorkingDirectory = $root
    $icon = Join-Path $root 'electron\icon.ico'
    if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
    $link.Description = 'Avvia Tsukumo'
    $link.Save()
    Write-Host "Collegamento creato: $target" -ForegroundColor Green
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

# Avvisi utili prima di partire ------------------------------------------------
if (-not (Test-Path (Join-Path $root 'models\kokoro-v1.0.onnx'))) {
    Write-Host 'ATTENZIONE: pesi Kokoro mancanti.' -ForegroundColor Yellow
    Write-Host "  Scaricali con:  $python scripts\download_models.py"
    Write-Host '  Senza pesi il backend usa la voce di servizio "formant".'
}

$avatars = @(Get-ChildItem -Path (Join-Path $root 'frontend\public\models') -Filter *.vrm -ErrorAction SilentlyContinue)
if ($avatars.Count -eq 0) {
    Write-Host 'ATTENZIONE: nessun file .vrm in frontend\public\models\.' -ForegroundColor Yellow
    Write-Host '  Copiane uno (chiamalo avatar.vrm) o trascinalo sulla finestra.'
}

# ------------------------------------------------------------- electron ----
if ($Electron) {
    Assert-Node
    if (-not (Test-Path (Join-Path $root 'electron\node_modules'))) {
        Write-Step 'Installo le dipendenze di Electron'
        Push-Location electron
        npm install
        Pop-Location
    }
    Write-Step 'Apro la finestra desktop'
    Push-Location electron
    $env:DC_PYTHON = $python
    npm start
    Pop-Location
    return
}

# ------------------------------------------------------------------ dev ----
if ($Dev) {
    Assert-Node
    Write-Step 'Avvio il backend in una nuova finestra'
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-Command',
        "Set-Location '$root'; & '$python' -m backend --reload"
    )

    Write-Step 'Avvio il dev server Vite (hot reload su http://localhost:5173)'
    Push-Location frontend
    if (-not (Test-Path 'node_modules')) { npm install }
    npm run dev
    Pop-Location
    return
}

# --------------------------------------------------------------- normale ---
if (-not (Test-Path (Join-Path $root 'frontend\dist\index.html'))) {
    Write-Host 'Frontend non compilato: lo compilo adesso.' -ForegroundColor Yellow
    Assert-Node
    Push-Location frontend
    if (-not (Test-Path 'node_modules')) { npm install }
    npm run build
    Pop-Location
}

Write-Step 'Avvio Tsukumo su http://127.0.0.1:8770'
& $python -m backend
