# First-time setup on a new Windows PC: checks the toolchain, installs npm dependencies and creates the
# sibling data folders the app expects (empty: sessions, tokens and data are never copied between PCs).
# Usage (PowerShell, inside the cloned folder):  powershell -ExecutionPolicy Bypass -File .\instalar.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "Falta '$cmd'. $hint" -ForegroundColor Red
        $script:missing = $true
    } else {
        Write-Host ("OK  {0}: {1}" -f $cmd, ((& $cmd --version 2>$null | Select-Object -First 1) -join ''))
    }
}

Step 'Revisando programas necesarios'
$missing = $false
Need 'git'   'Instálalo desde https://git-scm.com/download/win'
Need 'node'  'Instala Node.js 20 o superior (LTS) desde https://nodejs.org'
Need 'npm'   'Viene con Node.js.'
Need 'cargo' 'Instala Rust desde https://rustup.rs (y Visual Studio 2022 Build Tools con "Desarrollo para el escritorio con C++").'
if ($missing) { throw 'Instala lo que falta, cierra y vuelve a abrir PowerShell, y ejecuta este script otra vez.' }
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Tu Node es $(node -v); necesitas 20 o superior." }

Step 'Instalando dependencias de la app'
Push-Location app; npm ci; Pop-Location
Step 'Instalando dependencias del calentamiento'
Push-Location engines\warmup; npm ci; Pop-Location

Step 'Creando carpetas de datos (vacías)'
$parent = Split-Path $PSScriptRoot -Parent
foreach ($dir in @('whatsapp-bot-tester', 'whatsapp-pods\apk')) {
    $path = Join-Path $parent $dir
    if (Test-Path $path) { Write-Host "Ya existe: $path" }
    else { New-Item -ItemType Directory -Path $path | Out-Null; Write-Host "Creada: $path" }
}

Write-Host "`nListo. Para abrir la app:" -ForegroundColor Green
Write-Host '  cd app'
Write-Host '  npm run tauri dev'
Write-Host 'La primera vez tarda varios minutos porque compila la parte de Rust.'
