@echo off
rem Doble clic para abrir el menú de pods de WhatsApp.
set "PS=powershell"
where pwsh >nul 2>&1 && set "PS=pwsh"
%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0pods.ps1" %*
if "%~1"=="" pause
