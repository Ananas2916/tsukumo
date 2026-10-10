<#
.SYNOPSIS
    Builds Tsukumo's Windows installer (electron\dist\Tsukumo Setup <version>.exe).

.DESCRIPTION
    Whoever installs it needs neither Python nor Node: the installer carries
    an official "embeddable" Python with the dependencies already installed,
    the backend, the built interface and the Kokoro weights. Tsukumo herself
    is all geometry: no models or images to ship.

    Steps:
      1. build the frontend (npm run build)
      2. prepare build\python: embeddable Python + pip + requirements.txt
      3. prepare build\app: backend, built frontend, Kokoro, LICENSE and
         THIRD-PARTY-NOTICES.txt; scripts\package_audit.py checks that
         nothing else got in (settings, state, personal files)
      4. electron-builder packs everything into a per-user NSIS setup
         (no administrator rights)

    It downloads from python.org, pypi.org, github.com and npmjs.com; the cache
    lives in build\cache and later builds are much faster.

.PARAMETER KokoroVariant
    int8 (92 MB, default: faster on CPU), fp16 (169 MB) or full (326 MB).

.PARAMETER SkipInstaller
    Stops at electron\dist\win-unpacked (to try it without installing).

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
        Write-Host "    downloading $name"
        Invoke-WebRequest -Uri $url -OutFile "$target.part" -UseBasicParsing
        Move-Item "$target.part" $target
    }
    return $target
}

function Invoke-Checked([string]$exe, [string[]]$arguments, [string]$where = $root) {
    Push-Location $where
    # PowerShell 5.1 with "Stop" treats every stderr line of an external
    # program as a fatal error, even an npm warning: the exit code counts,
    # not stderr.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $exe @arguments 2>&1 | ForEach-Object { "$_" }
        if ($LASTEXITCODE -ne 0) { throw "$exe $($arguments -join ' ') exited with code $LASTEXITCODE" }
    } finally {
        $ErrorActionPreference = $previous
        Pop-Location
    }
}

New-Item -ItemType Directory -Force $cache | Out-Null

# ---------------------------------------------------------------- frontend --
Write-Step 'Building the frontend'
Invoke-Checked 'npm.cmd' @('run', 'build') (Join-Path $root 'frontend')

# ------------------------------------------------------------------ python --
Write-Step "Preparing Python $PythonVersion with the dependencies"
if (Test-Path $pythonDir) { Remove-Item -Recurse -Force $pythonDir }
Expand-Archive (Get-Cached "https://www.python.org/ftp/python/$PythonVersion/$PythonZip" $PythonZip) $pythonDir
# The embeddable's ._pth decides sys.path: "import site" is needed for pip, and
# "..\tsukumo" so that "python -m backend" finds the package in the resources
# (not "app": Electron would look there for its application, before app.asar).
$pth = Get-ChildItem $pythonDir -Filter 'python*._pth' | Select-Object -First 1
@('python311.zip', '.', '..\tsukumo', 'import site') | Set-Content -Encoding ascii $pth.FullName
$python = Join-Path $pythonDir 'python.exe'
Invoke-Checked $python @((Get-Cached 'https://bootstrap.pypa.io/get-pip.py' 'get-pip.py'), '--no-warn-script-location', '--disable-pip-version-check')
Invoke-Checked $python @('-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check', '-r', (Join-Path $root 'requirements.txt'))
# pip and its scripts are of no use to whoever uses the app.
Get-ChildItem $pythonDir -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force

# --------------------------------------------------------------------- app --
Write-Step 'Preparing backend, interface and voice'
if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir }
New-Item -ItemType Directory -Force $appDir | Out-Null
robocopy (Join-Path $root 'backend') (Join-Path $appDir 'backend') /E /XD __pycache__ /NFL /NDL /NJH /NJS | Out-Null
New-Item -ItemType Directory -Force (Join-Path $appDir 'scripts') | Out-Null
# The scripts Claude Code and Codex launch: notifications and status line (the plan's limits).
foreach ($script in 'tsukumo_notify.py', 'tsukumo_statusline.py') {
    Copy-Item (Join-Path $root "scripts\$script") (Join-Path $appDir 'scripts')
}
# Only the built pages: a folder an older version left in dist stays out (package_audit checks it).
robocopy (Join-Path $root 'frontend\dist') (Join-Path $appDir 'frontend\dist') /E /XD models animations /NFL /NDL /NJH /NJS | Out-Null
Copy-Item (Join-Path $root 'LICENSE') $appDir
Copy-Item (Join-Path $root '.env.example') $appDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $appDir 'models') | Out-Null
$kokoro = Get-Cached "$KokoroRelease/$($KokoroFiles[$KokoroVariant])" $KokoroFiles[$KokoroVariant]
# The backend always looks for kokoro-v1.0.onnx: the chosen variant takes that name.
Copy-Item $kokoro (Join-Path $appDir 'models\kokoro-v1.0.onnx')
Copy-Item (Get-Cached "$KokoroRelease/voices-v1.0.bin" 'voices-v1.0.bin') (Join-Path $appDir 'models')

Write-Step 'Licences and contents'
$audit = Join-Path $root 'scripts\package_audit.py'
# With the installer's Python: it lists exactly the packages that end up inside.
Invoke-Checked $python @($audit, 'notices', $appDir, (Join-Path $appDir 'THIRD-PARTY-NOTICES.txt'))
Invoke-Checked $python @($audit, 'contents', $appDir)

# ---------------------------------------------------------------- electron --
Write-Step 'Packing with electron-builder'
$electron = Join-Path $root 'electron'
if (-not (Test-Path (Join-Path $electron 'node_modules\electron-builder'))) {
    Invoke-Checked 'npm.cmd' @('install', '--no-audit', '--no-fund') $electron
}
# electron-builder downloads its signing tools in an archive that contains
# symbolic links for macOS: without Developer Mode Windows doesn't create them
# and the build fails. We extract it ourselves, without the macOS part.
$signTools = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign\winCodeSign-2.6.0'
if (-not (Test-Path (Join-Path $signTools 'rcedit-x64.exe'))) {
    $archive = Get-Cached 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z' 'winCodeSign-2.6.0.7z'
    $sevenZip = Join-Path $electron 'node_modules\7zip-bin\win\x64\7za.exe'
    Invoke-Checked $sevenZip @('x', '-y', '-bd', $archive, "-o$signTools", '-xr!darwin')
}
$target = if ($SkipInstaller) { 'dir' } else { 'nsis' }
$builderArgs = @('electron-builder', '--win', $target, '--x64', '--publish', 'never')
Invoke-Checked 'npx.cmd' $builderArgs $electron

$output = Join-Path $electron 'dist'
Write-Step "Done: $output"
Get-ChildItem $output -Filter '*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host ("    {0}  ({1:N0} MB)" -f $_.Name, ($_.Length / 1MB))
}
