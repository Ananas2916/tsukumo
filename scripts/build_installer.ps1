<#
.SYNOPSIS
    Crea l'installer di Tsukumo per Windows (electron\dist\Tsukumo Setup <versione>.exe).

.DESCRIPTION
    Chi installa non deve avere ne' Python ne' Node: l'installer porta con se'
    un Python "embeddable" ufficiale con le dipendenze gia' installate, il
    backend, l'interfaccia compilata, le clip, l'avatar e i pesi di Kokoro.

    Passi:
      1. compila il frontend (npm run build)
      2. prepara build\python: Python embeddable + pip + requirements.txt
      3. prepara build\app: backend, frontend compilato, avatar, clip, Kokoro
      4. electron-builder impacchetta tutto in un setup NSIS per utente
         (niente diritti di amministratore)

    Scarica da python.org, pypi.org, github.com e npmjs.com; la cache sta in
    build\cache e le build successive sono molto piu' rapide.

    ATTENZIONE: l'avatar e le clip in frontend\public finiscono nell'installer.
    Distribuiscilo solo se le loro licenze lo permettono (le clip Bandai Namco
    sono CC BY-NC: niente uso commerciale).

.PARAMETER KokoroVariant
    int8 (92 MB, predefinito: piu' veloce su CPU), fp16 (169 MB) o full (326 MB).

.PARAMETER SkipInstaller
    Si ferma a electron\dist\win-unpacked (per provare senza installare).

.EXAMPLE
    .\scripts\build_installer.ps1
#>

[CmdletBinding()]
param(
    [ValidateSet('int8', 'fp16', 'full')]
    [string]$KokoroVariant = 'int8',
    [switch]$SkipInstaller
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
$cache = Join-Path $build 'cache'
$pythonDir = Join-Path $build 'python'
$appDir = Join-Path $build 'app'

$PythonVersion = '3.11.9'
$PythonZip = "python-$PythonVersion-embed-amd64.zip"
$KokoroRelease = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
$KokoroFiles = @{ int8 = 'kokoro-v1.0.int8.onnx'; fp16 = 'kokoro-v1.0.fp16.onnx'; full = 'kokoro-v1.0.onnx' }

function Write-Step([string]$message) {
    Write-Host ''
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Get-Cached([string]$url, [string]$name) {
    $target = Join-Path $cache $name
    if (-not (Test-Path $target)) {
        Write-Host "    scarico $name"
        Invoke-WebRequest -Uri $url -OutFile "$target.part" -UseBasicParsing
        Move-Item "$target.part" $target
    }
    return $target
}

function Invoke-Checked([string]$exe, [string[]]$arguments, [string]$where = $root) {
    Push-Location $where
    # PowerShell 5.1 con "Stop" tratta ogni riga su stderr di un programma
    # esterno come un errore fatale, anche un avviso di npm: conta il codice
    # di uscita, non stderr.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $exe @arguments 2>&1 | ForEach-Object { "$_" }
        if ($LASTEXITCODE -ne 0) { throw "$exe $($arguments -join ' ') e' uscito con codice $LASTEXITCODE" }
    } finally {
        $ErrorActionPreference = $previous
        Pop-Location
    }
}

New-Item -ItemType Directory -Force $cache | Out-Null

# ---------------------------------------------------------------- frontend --
Write-Step 'Compilo il frontend'
Invoke-Checked 'npm.cmd' @('run', 'build') (Join-Path $root 'frontend')

# ------------------------------------------------------------------ python --
Write-Step "Preparo Python $PythonVersion con le dipendenze"
if (Test-Path $pythonDir) { Remove-Item -Recurse -Force $pythonDir }
Expand-Archive (Get-Cached "https://www.python.org/ftp/python/$PythonVersion/$PythonZip" $PythonZip) $pythonDir
# Il ._pth dell'embeddable decide sys.path: serve "import site" per pip, e
# "..\tsukumo" perche' "python -m backend" trovi il pacchetto nelle risorse
# (non "app": Electron cercherebbe li' la sua applicazione, prima di app.asar).
$pth = Get-ChildItem $pythonDir -Filter 'python*._pth' | Select-Object -First 1
@('python311.zip', '.', '..\tsukumo', 'import site') | Set-Content -Encoding ascii $pth.FullName
$python = Join-Path $pythonDir 'python.exe'
Invoke-Checked $python @((Get-Cached 'https://bootstrap.pypa.io/get-pip.py' 'get-pip.py'), '--no-warn-script-location', '--disable-pip-version-check')
Invoke-Checked $python @('-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check', '-r', (Join-Path $root 'requirements.txt'))
# pip e i suoi script non servono a chi usa l'app.
Get-ChildItem $pythonDir -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force

# --------------------------------------------------------------------- app --
Write-Step 'Preparo backend, interfaccia, avatar, clip e voce'
if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir }
New-Item -ItemType Directory -Force $appDir | Out-Null
robocopy (Join-Path $root 'backend') (Join-Path $appDir 'backend') /E /XD __pycache__ /NFL /NDL /NJH /NJS | Out-Null
New-Item -ItemType Directory -Force (Join-Path $appDir 'scripts') | Out-Null
Copy-Item (Join-Path $root 'scripts\tsukumo_notify.py') (Join-Path $appDir 'scripts')
robocopy (Join-Path $root 'frontend\dist') (Join-Path $appDir 'frontend\dist') /E /NFL /NDL /NJH /NJS | Out-Null
robocopy (Join-Path $root 'frontend\public\models') (Join-Path $appDir 'frontend\public\models') /E /NFL /NDL /NJH /NJS | Out-Null
robocopy (Join-Path $root 'frontend\public\animations') (Join-Path $appDir 'frontend\public\animations') /E /NFL /NDL /NJH /NJS | Out-Null
Copy-Item (Join-Path $root '.env.example') $appDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $appDir 'models') | Out-Null
$kokoro = Get-Cached "$KokoroRelease/$($KokoroFiles[$KokoroVariant])" $KokoroFiles[$KokoroVariant]
# Il backend cerca sempre kokoro-v1.0.onnx: la variante scelta prende quel nome.
Copy-Item $kokoro (Join-Path $appDir 'models\kokoro-v1.0.onnx')
Copy-Item (Get-Cached "$KokoroRelease/voices-v1.0.bin" 'voices-v1.0.bin') (Join-Path $appDir 'models')
$avatars = @(Get-ChildItem (Join-Path $appDir 'frontend\public\models') -Filter '*.vrm' -ErrorAction SilentlyContinue)
if (-not $avatars) { Write-Warning 'Nessun avatar in frontend\public\models: chi installa dovra sceglierne uno.' }
else { Write-Warning "Avatar incluso: $($avatars.Name -join ', '). Distribuisci l'installer solo se la sua licenza lo permette." }

# ---------------------------------------------------------------- electron --
Write-Step 'Impacchetto con electron-builder'
$electron = Join-Path $root 'electron'
if (-not (Test-Path (Join-Path $electron 'node_modules\electron-builder'))) {
    Invoke-Checked 'npm.cmd' @('install', '--no-audit', '--no-fund') $electron
}
# electron-builder scarica i suoi strumenti di firma in un archivio che contiene
# link simbolici per macOS: senza la Modalita' sviluppatore Windows non li crea
# e la build fallisce. Lo estraiamo noi, senza la parte macOS.
$signTools = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign\winCodeSign-2.6.0'
if (-not (Test-Path (Join-Path $signTools 'rcedit-x64.exe'))) {
    $archive = Get-Cached 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z' 'winCodeSign-2.6.0.7z'
    $sevenZip = Join-Path $electron 'node_modules\7zip-bin\win\x64\7za.exe'
    Invoke-Checked $sevenZip @('x', '-y', '-bd', $archive, "-o$signTools", '-xr!darwin')
}
$target = if ($SkipInstaller) { 'dir' } else { 'nsis' }
Invoke-Checked 'npx.cmd' @('electron-builder', '--win', $target, '--x64', '--publish', 'never') $electron

$output = Join-Path $electron 'dist'
Write-Step "Fatto: $output"
Get-ChildItem $output -Filter '*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host ("    {0}  ({1:N0} MB)" -f $_.Name, ($_.Length / 1MB))
}
