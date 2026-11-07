# Pulls the latest main and reinstalls npm dependencies only when their lockfile changed.
# Close the app (Ctrl+C in its terminal) before running it.
# Usage:  powershell -ExecutionPolicy Bypass -File .\actualizar.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$dirty = git status --porcelain --untracked-files=no
if ($dirty) {
    Write-Host 'Hay cambios locales en archivos del proyecto; no actualizo para no pisarlos:' -ForegroundColor Red
    Write-Host $dirty
    throw 'Guarda o descarta esos cambios (pide ayuda si no sabes cuáles son) y vuelve a intentarlo.'
}

$before = git rev-parse HEAD
git fetch origin main
$after = git rev-parse origin/main
if ($before -eq $after) { Write-Host 'Ya tienes la última versión.' -ForegroundColor Green; return }

Write-Host "Cambios nuevos:" -ForegroundColor Cyan
git log --oneline "$before..$after"
git merge --ff-only origin/main

$changed = git diff --name-only $before $after
foreach ($lock in @('app/package-lock.json', 'engines/warmup/package-lock.json')) {
    if ($changed -contains $lock) {
        $dir = Split-Path $lock -Parent
        Write-Host "Reinstalando dependencias en $dir..." -ForegroundColor Cyan
        Push-Location $dir; npm ci; Pop-Location
    }
}

Write-Host "`nActualizado. Abre la app de nuevo:  cd app ; npm run tauri dev" -ForegroundColor Green
if ($changed -match '^app/src-tauri/') { Write-Host 'Esta vez cambió la parte de Rust: el primer arranque tarda un poco más.' }
