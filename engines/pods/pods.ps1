<#
  Gestor de pods de WhatsApp Business sobre BlueStacks 5 (Android 11).

  Uso:
    .\pods.ps1                          -> menú interactivo
    .\pods.ps1 instalar                 -> primera vez en un PC: instala BlueStacks y aplica la configuración
    .\pods.ps1 nuevo   <nombre>         -> crea un pod, instala WhatsApp Business y lo deja en la pantalla de bienvenida
    .\pods.ps1 listar
    .\pods.ps1 listar-json             -> lo mismo en JSON puro (sin texto extra): [{ name, instanceId, state, serial, adbPort, phone }]
    .\pods.ps1 info-json              -> rutas de HD-Adb.exe y HD-Player.exe en JSON (las usa la app)
    .\pods.ps1 prender <nombre>
    .\pods.ps1 apagar  <nombre>
    .\pods.ps1 ver     <nombre>         -> trae la ventana al frente (prende el pod si está apagado)
    .\pods.ps1 abrir-wa <nombre>       -> abre WhatsApp Business dentro del pod (debe estar prendido)
    .\pods.ps1 borrar  <nombre>         -> pide escribir el nombre para confirmar
    .\pods.ps1 renombrar <nombre> <nuevo> -> cambia solo el nombre visible (la cuenta no se toca)
    .\pods.ps1 wsp <nombre> <numero>    -> etiqueta #wsp con el número del pod (se guarda en pods-wsp.json)
    .\pods.ps1 optimizar <nombre|todos> -> aplica los ajustes de ahorro de recursos
    .\pods.ps1 reinstalar-wa <nombre>   -> reinstala WhatsApp Business SIN borrar la cuenta y lo compila (AOT)
    .\pods.ps1 prender-todos | apagar-todos

  Modo no interactivo (lo usa la app agentAutoX1): agrega -NoInteractivo a cualquier acción.
    - "borrar" no pregunta el nombre (quien llama ya lo confirmó).
    - "nuevo" y los asistentes que necesitan manos humanas (instalar BlueStacks, crear la instancia a mano) fallan con un mensaje
      en lugar de esperar. Nunca pide nada por teclado.
    - La salida siempre va en UTF-8 (sin BOM), así los acentos llegan bien a quien lee el proceso.

  Un pod es una instancia de BlueStacks (Android 11, familia Rvc64) cuyo nombre visible es "wa-<nombre>".
  Todas comparten el Root.vhd de la instancia base Rvc64 (solo lectura); cada una tiene su propio Data.vhdx,
  que es donde vive la cuenta de WhatsApp.
#>
param(
    [Parameter(Position = 0)] [string] $Accion,
    [Parameter(Position = 1)] [string] $Nombre,
    [Parameter(Position = 2)] [string] $Extra,
    [switch] $NoInteractivo
)

$ErrorActionPreference = 'Stop'

# ---------- configuración ----------

$Prefijo        = 'wa-'
$ImagenBase     = 'Rvc64'                     # Android 11 de 64 bits: es la única que corre WhatsApp Business bien
# Rutas configurables (la app agentAutoX1 las pasa por variables de entorno). Por defecto se usan los datos
# del proyecto original whatsapp-pods, para no duplicar los APK ni el mapa de numeros.
$OriginalPodsDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\whatsapp-pods'))   # agentAutoX1\engines\pods -> whatsapp-pods
$ApkRaiz        = if ($env:AGENTAUTO_APK_DIR) { $env:AGENTAUTO_APK_DIR } else { Join-Path $OriginalPodsDir 'apk' }
$ApkDir         = Join-Path $ApkRaiz 'business'
$Paquete        = 'com.whatsapp.w4b'
$ActividadWa    = 'com.whatsapp.Main'
$PuertoAdbBase  = 5565                        # el piloto usa 5555; cada pod nuevo suma 10 (serial emulator-<puerto-1>)
$EspacioMinGB   = 8

# Valores del primer arranque (con 2 GB el Android se congela al arrancar por primera vez) y valores finales.
$Arranque       = @{ cpus = '4'; ram = '3072'; fps = '20' }
$Final          = @{ cpus = '2'; ram = '2560'; fps = '10' }
$Pantalla       = @{ ancho = '540'; alto = '960'; dpi = '240' }

# Apps que se deshabilitan (reversible con "pm enable"). No se toca el launcher ni SystemUI.
$AppsInnecesarias = @(
    'com.android.vending', 'com.android.chrome', 'com.google.android.play.games',
    'gg.now.ads.service', 'gg.now.billing.interceptor', 'gg.now.billing.service', 'gg.now.billing.service2', 'gg.now.accounts',
    'com.google.android.partnersetup', 'com.google.android.onetimeinitializer', 'com.google.android.gms.setup',
    'com.google.android.syncadapters.calendar', 'com.google.android.syncadapters.contacts'
)
# Google Play services falla en bucle en este Android; apagarlo ahorra CPU y RAM y WhatsApp sigue conectado.
$AppsGoogle = @('com.google.android.gms', 'com.google.android.gsf', 'com.google.android.gsf.login', 'com.google.android.backuptransport')
$DeshabilitarGoogle = $true

# Ajustes globales de BlueStacks.
$ConfGlobal = [ordered]@{
    'bst.enable_adb_access'                       = '1'
    'bst.prefer_dedicated_gpu'                    = '0'   # GPU integrada: la dedicada gasta mucho más y WhatsApp no la necesita
    'bst.launch_store_on_boot'                    = '0'
    'bst.enable_boot_banner'                      = '0'
    'bst.feature.show_boot_banner_preference'     = '0'
    'bst.enable_programmatic_ads'                 = '0'
    'bst.feature.show_gp_ads'                     = '0'
}
# BlueStacks vuelve a poner estas en "1" cada vez que arranca (vienen de su configuración en la nube); se escriben
# cada vez que se edita el conf, pero no cuentan para decidir si hace falta cerrar BlueStacks.
$ConfGlobalVolatil = [ordered]@{
    'bst.feature.programmatic_ads'                 = '0'
    'bst.feature.show_programmatic_ads_preference' = '0'
}

# ---------- utilidades generales ----------

function Escribir([string] $texto, [string] $color = 'Gray') { Write-Host $texto -ForegroundColor $color }

function Paso([int] $n, [int] $total, [string] $texto) { Write-Host "[$n/$total] $texto" -ForegroundColor Cyan }

# Modo no interactivo: ninguna acción puede quedarse esperando teclado ni pasos manuales.
function Exigir-Interactivo([string] $motivo) {
    if ($script:NoInteractivo) { throw "Esto necesita intervención manual ($motivo) y no se puede hacer en modo automático. Hazlo desde la consola: .\pods.ps1" }
}

# La confirmación de borrado exige el nombre exacto (distingue mayúsculas).
function Test-Confirmacion([string] $nombre, [string] $escrito) { return [bool]($nombre -ceq $escrito) }

# Salida en UTF-8 sin BOM para que los acentos lleguen bien a la app (que lee el proceso como UTF-8).
function Usar-Utf8 {
    $utf8 = New-Object Text.UTF8Encoding($false)
    $script:OutputEncoding = $utf8
    $global:OutputEncoding = $utf8
    try { [Console]::OutputEncoding = $utf8 } catch { }
}

function Test-NombrePod([string] $nombre) {
    return [bool]($nombre -match '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,23}$')
}

function Test-NumeroWsp([string] $numero) {
    return [bool]($numero -match '^\+?[0-9]{7,15}$')
}

# Número de WhatsApp de cada pod, por id de instancia (no cambia aunque se renombre el pod).
$WspArchivo = if ($env:AGENTAUTO_PODS_WSP_FILE) { $env:AGENTAUTO_PODS_WSP_FILE } else { Join-Path $OriginalPodsDir 'pods-wsp.json' }

function Poner-WspEnMapa($mapa, [string] $id, [string] $numero) {
    $n = [ordered]@{}
    foreach ($k in $mapa.Keys) { if ($k -ne $id) { $n[$k] = $mapa[$k] } }
    if ($numero) { $n[$id] = $numero }
    return $n
}

function Leer-Wsp {
    $m = [ordered]@{}
    if (Test-Path $WspArchivo) {
        $d = Get-Content $WspArchivo -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($p in $d.PSObject.Properties) { $m[$p.Name] = [string]$p.Value }
    }
    return $m
}

# Escritura atómica (temporal + renombrar) y copia con fecha del archivo anterior en backups\ junto al mapa.
function Guardar-Wsp($mapa) {
    $dir = Split-Path $WspArchivo -Parent
    if (Test-Path $WspArchivo) {
        $copias = Join-Path $dir 'backups'
        New-Item -ItemType Directory -Path $copias -Force | Out-Null
        $sello = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss-fff')
        Copy-Item $WspArchivo (Join-Path $copias "pods-wsp.$sello.json")
    }
    $temporal = "$WspArchivo.$PID.tmp"
    [IO.File]::WriteAllText($temporal, ([pscustomobject]$mapa | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    Move-Item $temporal $WspArchivo -Force
}

function Nueva-GuidTexto { return [guid]::NewGuid().ToString() }

function Nuevo-AndroidId { return (-join (1..16 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })) }

# ---------- bluestacks.conf (funciones puras sobre el texto) ----------
# Formato: clave="valor", una por línea. BlueStacks lo reescribe entero mientras corre,
# por eso solo se edita con todas las instancias cerradas.

function Obtener-ConfValor([string] $texto, [string] $clave) {
    $m = [regex]::Match($texto, '(?m)^' + [regex]::Escape($clave) + '="([^"\r\n]*)"')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function Poner-ConfValor([string] $texto, [string] $clave, [string] $valor) {
    $nl = if ($texto.Contains("`r`n")) { "`r`n" } else { "`n" }
    $linea = "$clave=`"$valor`""
    $patron = '(?m)^' + [regex]::Escape($clave) + '="[^"\r\n]*"'
    if ([regex]::IsMatch($texto, $patron)) {
        $ev = [System.Text.RegularExpressions.MatchEvaluator] { param($m) $linea }
        return ([regex]$patron).Replace($texto, $ev, 1)
    }
    if ($texto.Length -gt 0 -and -not $texto.EndsWith("`n")) { $texto += $nl }
    return $texto + $linea + $nl
}

function Quitar-ConfInstancia([string] $texto, [string] $id) {
    $patron = '(?m)^bst\.instance\.' + [regex]::Escape($id) + '\.[^\r\n]*(\r?\n|$)'
    return [regex]::Replace($texto, $patron, '')
}

function Obtener-ConfIds([string] $texto) {
    $ids = @()
    foreach ($m in [regex]::Matches($texto, '(?m)^bst\.instance\.([^.=]+)\.display_name=')) { $ids += $m.Groups[1].Value }
    return $ids
}

# Líneas "bst.instance.<id>.*" de una instancia, como diccionario clave-corta -> valor (sin las "status.*", que son de ejecución).
function Obtener-ConfInstancia([string] $texto, [string] $id) {
    $d = [ordered]@{}
    foreach ($m in [regex]::Matches($texto, '(?m)^bst\.instance\.' + [regex]::Escape($id) + '\.([^=\r\n]+)="([^"\r\n]*)"')) {
        if ($m.Groups[1].Value -like 'status.*') { continue }
        $d[$m.Groups[1].Value] = $m.Groups[2].Value
    }
    return $d
}

# Inserta el bloque de claves de una instancia nueva justo después de la última línea "bst.instance.*".
function Agregar-ConfInstancia([string] $texto, [string] $id, $valores) {
    $nl = if ($texto.Contains("`r`n")) { "`r`n" } else { "`n" }
    $bloque = (($valores.Keys | ForEach-Object { "bst.instance.$id.$_=`"$($valores[$_])`"" }) -join $nl) + $nl
    $ultima = [regex]::Matches($texto, '(?m)^bst\.instance\.[^\r\n]*(\r?\n|$)')
    if ($ultima.Count -gt 0) {
        $fin = $ultima[$ultima.Count - 1].Index + $ultima[$ultima.Count - 1].Length
        return $texto.Substring(0, $fin) + $bloque + $texto.Substring($fin)
    }
    return $texto + $bloque
}

function Siguiente-PuertoAdb([string] $texto, [int] $base) {
    $usados = @()
    foreach ($m in [regex]::Matches($texto, '(?m)^bst\.instance\.[^.=]+\.(?:status\.)?adb_port="(\d+)"')) { $usados += [int]$m.Groups[1].Value }
    $p = $base
    while ($usados -contains $p) { $p += 10 }
    return $p
}

function Siguiente-IdInstancia([string] $texto, [string] $imagen) {
    $n = 1
    $ids = Obtener-ConfIds $texto
    while ($ids -contains "${imagen}_$n" -or (Test-Path (Join-Path $script:BsEngine "${imagen}_$n"))) { $n++ }
    return "${imagen}_$n"
}

# ---------- BlueStacks: rutas, procesos, conf ----------

function Detectar-BlueStacks {
    $reg = Get-ItemProperty 'HKLM:\SOFTWARE\BlueStacks_nxt' -ErrorAction SilentlyContinue
    $inst = if ($reg -and $reg.InstallDir) { $reg.InstallDir } else { 'C:\Program Files\BlueStacks_nxt' }
    $dato = if ($reg -and $reg.UserDefinedDir) { $reg.UserDefinedDir } else { 'C:\ProgramData\BlueStacks_nxt' }
    $inst = $inst.TrimEnd('\'); $dato = $dato.TrimEnd('\')
    $script:BsDir    = $inst
    $script:BsDatos  = $dato
    $script:BsConf   = Join-Path $dato 'bluestacks.conf'
    $script:BsEngine = if ($reg -and $reg.DataDir) { $reg.DataDir.TrimEnd('\') } else { Join-Path $dato 'Engine' }
    $script:HdPlayer = Join-Path $inst 'HD-Player.exe'
    $script:Adb      = Join-Path $inst 'HD-Adb.exe'
    $script:VmMgr    = Join-Path $inst 'BstkVMMgr.exe'
    $script:Mim      = Join-Path $inst 'HD-MultiInstanceManager.exe'
    return ((Test-Path $script:HdPlayer) -and (Test-Path $script:BsConf))
}

# Se lee con FileShare.ReadWrite: BlueStacks lo tiene abierto mientras corre.
function Leer-Conf {
    $fs = New-Object IO.FileStream($script:BsConf, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try { $sr = New-Object IO.StreamReader($fs, (New-Object Text.UTF8Encoding($false))); return $sr.ReadToEnd() }
    finally { $fs.Dispose() }
}

function Hay-BlueStacksAbierto {
    return [bool](Get-Process -Name 'HD-Player', 'HD-MultiInstanceManager' -ErrorAction SilentlyContinue)
}

# Guarda el conf con copia de seguridad (se conservan las últimas 5). Solo con BlueStacks cerrado.
function Guardar-Conf([string] $texto) {
    if (Hay-BlueStacksAbierto) { throw 'BlueStacks está abierto: se sobrescribiría el cambio. Ciérralo (o apaga los pods) e inténtalo de nuevo.' }
    $copia = "$($script:BsConf).bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $script:BsConf $copia
    Get-ChildItem "$($script:BsConf).bak-*" | Sort-Object Name -Descending | Select-Object -Skip 5 | Remove-Item -Force -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText($script:BsConf, $texto, (New-Object Text.UTF8Encoding($false)))
}

function Obtener-NombreVisible([string] $texto, [string] $id) { return (Obtener-ConfValor $texto "bst.instance.$id.display_name") }

# Cambia solo el nombre visible; la cuenta, el disco y el puerto adb no se tocan.
function Renombrar-ConfPod([string] $texto, [string] $id, [string] $nombre) {
    if ($null -eq (Obtener-NombreVisible $texto $id)) { throw "No encuentro la instancia $id en bluestacks.conf." }
    return (Poner-ConfValor $texto "bst.instance.$id.display_name" "$Prefijo$nombre")
}

# BstkVMMgr escribe en stderr; con ErrorActionPreference=Stop, "2>&1" lanzaría excepción en Windows PowerShell 5.1.
function Invoke-VmMgr([string[]] $argumentos) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { return (& $script:VmMgr @argumentos 2>&1 | Out-String) } finally { $ErrorActionPreference = $old }
}

# ---------- pods (instancias Rvc64*) ----------

function Obtener-Pods {
    $texto = Leer-Conf
    $pods = @()
    foreach ($id in (Obtener-ConfIds $texto)) {
        if ($id -notmatch "^$ImagenBase(_\d+)?$") { continue }
        $vis = Obtener-NombreVisible $texto $id
        if ($vis -notlike "$Prefijo*") { continue }
        $puerto = Obtener-ConfValor $texto "bst.instance.$id.adb_port"
        $pods += [pscustomobject]@{
            Nombre    = $vis.Substring($Prefijo.Length)
            Instancia = $id
            Visible   = $vis
            Puerto    = [int]$puerto
            Serial    = "emulator-$([int]$puerto - 1)"
        }
    }
    return @($pods | Sort-Object Puerto)
}

function Obtener-Pod([string] $nombre) {
    if (-not $nombre) { throw 'Falta el nombre del pod.' }
    $pod = Obtener-Pods | Where-Object { $_.Nombre -eq $nombre }
    if (-not $pod) { throw "No existe el pod '$nombre'. Usa 'listar' para ver los que hay." }
    return $pod
}

function Puerto-Escuchando([int] $puerto) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $puerto -ErrorAction SilentlyContinue)
}

# La línea de comandos de HD-Player viene vacía, así que la instancia se reconoce por el puerto adb que escucha
# o, si aún está arrancando, por el título de la ventana (= nombre visible).
function Obtener-PidPod($pod) {
    $texto = Leer-Conf
    $puertos = @($pod.Puerto)
    $rt = Obtener-ConfValor $texto "bst.instance.$($pod.Instancia).status.adb_port"
    if ($rt) { $puertos += [int]$rt }
    foreach ($p in ($puertos | Select-Object -Unique)) {
        $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) {
            $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq 'HD-Player') { return $proc.Id }
        }
    }
    $w = Get-Process -Name 'HD-Player' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq $pod.Visible } | Select-Object -First 1
    if ($w) { return $w.Id }
    return $null
}

function Pod-Prendido($pod) { return [bool](Obtener-PidPod $pod) }

# ---------- adb con tiempo límite ----------

function Quote-Arg([string] $a) {
    if ($a -match '[\s"]') { return '"' + ($a -replace '"', '\"') + '"' }
    return $a
}

function Invoke-Adb([string] $serial, [string[]] $argumentos, [int] $timeout = 20) {
    $partes = @()
    if ($serial) { $partes += '-s'; $partes += $serial }
    $partes += $argumentos
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $script:Adb
    $psi.Arguments = ($partes | ForEach-Object { Quote-Arg $_ }) -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi)
    $o = $p.StandardOutput.ReadToEndAsync()
    $e = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($timeout * 1000)) {
        try { $p.Kill() } catch { }
        return [pscustomobject]@{ Codigo = -1; Salida = ''; Error = 'tiempo agotado'; Texto = 'tiempo agotado'; Agotado = $true }
    }
    $p.WaitForExit()
    $sal = ($o.Result -replace "`r", '').Trim(); $err = ($e.Result -replace "`r", '').Trim()
    # adb de BlueStacks escribe algunos resultados (p. ej. "Success" de install) en stderr: Texto junta ambos.
    return [pscustomobject]@{ Codigo = $p.ExitCode; Salida = $sal; Error = $err; Texto = ($sal + "`n" + $err).Trim(); Agotado = $false }
}

function Adb-Shell([string] $serial, [string] $comando, [int] $timeout = 20) {
    return Invoke-Adb $serial @('shell', $comando) $timeout
}

function Android-Listo([string] $serial) {
    $r = Adb-Shell $serial 'getprop sys.boot_completed' 10
    return ($r.Salida -eq '1')
}

# Devuelve el serial adb de un pod que está corriendo, comprobando que el android_id coincida con el del conf.
function Obtener-Serial($pod) {
    $texto = Leer-Conf
    $puerto = $pod.Puerto
    $rt = Obtener-ConfValor $texto "bst.instance.$($pod.Instancia).status.adb_port"
    if ($rt) { $puerto = [int]$rt }
    $esperado = Obtener-ConfValor $texto "bst.instance.$($pod.Instancia).android_id"
    $candidatos = @("emulator-$($puerto - 1)", "127.0.0.1:$puerto")
    $lista = (Invoke-Adb $null @('devices') 10).Salida
    foreach ($c in $candidatos) {
        if ($lista -notmatch ('(?m)^' + [regex]::Escape($c) + '\s+device')) { continue }
        $id = (Adb-Shell $c 'settings get secure android_id' 10).Salida
        if (-not $esperado -or $id -eq $esperado) { return $c }
    }
    return $null
}

function Esperar-Android($pod, [int] $segundos = 240) {
    Escribir "    Esperando que Android arranque ($($pod.Visible))..."
    $limite = (Get-Date).AddSeconds($segundos)
    while ((Get-Date) -lt $limite) {
        $serial = Obtener-Serial $pod
        if ($serial -and (Android-Listo $serial)) { Start-Sleep 8; return $serial }
        if (-not (Pod-Prendido $pod)) { Start-Sleep 5; if (-not (Pod-Prendido $pod)) { throw "La ventana del pod '$($pod.Nombre)' se cerró mientras arrancaba." } }
        Start-Sleep 4
    }
    throw "Android no terminó de arrancar en $segundos s ($($pod.Visible)). Prueba 'apagar' y 'prender'; si se congela, sube la RAM a 3072 con 'optimizar'."
}

# ---------- encender / apagar ----------

function Iniciar-Pod($pod, [switch] $Oculto) {
    if (Pod-Prendido $pod) { return }
    $parametros = @('--instance', $pod.Instancia)
    if ($Oculto) { $parametros += '--hidden' }
    Start-Process -FilePath $script:HdPlayer -ArgumentList $parametros | Out-Null
    for ($i = 0; $i -lt 30 -and -not (Pod-Prendido $pod); $i++) { Start-Sleep 1 }
}

function Detener-Pod($pod) {
    $procId = Obtener-PidPod $pod
    if (-not $procId) { return }
    $serial = Obtener-Serial $pod
    if ($serial) { Adb-Shell $serial 'sync' 10 | Out-Null }   # que el Data.vhdx quede consistente
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20 -and (Get-Process -Id $procId -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
    if ($serial) { Invoke-Adb $null @('disconnect', $serial) 5 | Out-Null }
}

function Cerrar-ResidualesBlueStacks {
    Get-Process -Name 'HD-MultiInstanceManager', 'HD-Player' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20 -and (Hay-BlueStacksAbierto); $i++) { Start-Sleep -Milliseconds 500 }
}

# Cierra todos los pods y BlueStacks para poder editar el conf; devuelve los pods que estaban prendidos.
function Cerrar-PodsPrendidos {
    $prendidos = @(Obtener-Pods | Where-Object { Pod-Prendido $_ })
    if ($prendidos.Count -gt 0) { Escribir "    Cierro BlueStacks un momento para editar su configuración (volveré a abrir: $(($prendidos | ForEach-Object Nombre) -join ', '))." Yellow }
    foreach ($p in $prendidos) { Detener-Pod $p }
    Cerrar-ResidualesBlueStacks
    return $prendidos
}

function Reabrir-Pods($pods, $excepto) {
    foreach ($p in $pods) {
        if ($excepto -and $p.Instancia -eq $excepto.Instancia) { continue }
        Iniciar-Pod $p
    }
}

# ---------- listado en JSON (para la app de escritorio) ----------

# Una fila del listado JSON. Funcion pura: state es 'running' o 'stopped'; serial y phone son null si no aplican.
function Convertir-PodAFilaJson($pod, [bool] $prendido, [string] $serial, [string] $telefono) {
    return [ordered]@{
        name       = [string]$pod.Nombre
        instanceId = [string]$pod.Instancia
        state      = if ($prendido) { 'running' } else { 'stopped' }
        serial     = if ($serial) { $serial } else { $null }
        adbPort    = [int]$pod.Puerto
        phone      = if ($telefono) { $telefono } else { $null }
    }
}

# Serializa las filas siempre como arreglo JSON ("[]" si no hay pods; Windows PowerShell 5.1 aplana arreglos de 0/1 elementos con el pipe).
function Convertir-FilasAJson($filas) {
    $lista = @($filas)
    if ($lista.Count -eq 0) { return '[]' }
    return (ConvertTo-Json -InputObject $lista -Depth 4)
}

# ---------- Android: apps ----------

function Obtener-Apks {
    $apks = @(Get-ChildItem $ApkDir -Filter *.apk -ErrorAction SilentlyContinue | ForEach-Object FullName)
    if ($apks.Count -eq 0) { throw "No encuentro los APK de WhatsApp Business en $ApkDir." }
    return $apks
}

function Wa-Instalado([string] $serial) {
    $r = Adb-Shell $serial "pm path $Paquete" 15
    return ($r.Salida -match 'package:')
}

# install-multiple -r conserva los datos (no desinstala). Con -PermitirDesinstalar (solo pods nuevos, sin cuenta) reintenta limpio.
function Instalar-Wa([string] $serial, [switch] $PermitirDesinstalar) {
    $apks = Obtener-Apks
    Escribir '    Instalando WhatsApp Business (no cierres la ventana de BlueStacks)...'
    $r = Invoke-Adb $serial (@('install-multiple', '-r') + $apks) 600
    $ok = (-not $r.Agotado) -and ($r.Texto -match 'Success')
    if ($ok) { $paths = (Adb-Shell $serial "pm path $Paquete" 15).Salida -split "`n" | Where-Object { $_ -match 'package:' }; $ok = ($paths.Count -ge 3) }
    if (-not $ok -and $PermitirDesinstalar) {
        Escribir '    La instalación quedó a medias; limpio y reintento (pod sin cuenta).' Yellow
        Adb-Shell $serial "pm uninstall $Paquete" 60 | Out-Null
        $r = Invoke-Adb $serial (@('install-multiple', '-r') + $apks) 600
        $ok = (-not $r.Agotado) -and ($r.Texto -match 'Success')
    }
    if (-not $ok) { throw "No se pudo instalar WhatsApp Business: $($r.Texto). Si dice que el paquete está congelado o a medias, mira 'Solución de problemas' en el README." }
}

# Sin esta compilación AOT, el JIT de BlueStacks hace que WhatsApp se caiga con excepciones absurdas.
function Compilar-Wa([string] $serial) {
    Escribir '    Compilando WhatsApp (AOT, tarda ~5 minutos; es necesario)...'
    $r = Adb-Shell $serial "cmd package compile -m speed -f $Paquete" 1200
    if ($r.Agotado) { throw 'La compilación de WhatsApp superó los 20 minutos.' }
    if ($r.Texto -notmatch 'Success') { throw "La compilación de WhatsApp falló: $($r.Texto)" }
}

function Deshabilitar-Apps([string] $serial) {
    $lista = @($AppsInnecesarias)
    if ($DeshabilitarGoogle) { $lista += $AppsGoogle }
    $hechas = 0
    foreach ($p in $lista) {
        $r = Adb-Shell $serial "pm disable-user --user 0 $p" 20
        if ($r.Texto -match 'disabled') { $hechas++ }
    }
    Escribir "    Apps deshabilitadas: $hechas de $($lista.Count) (las que no existen se ignoran)."
    # Android guarda el estado de los paquetes con retraso (~10 s): si se cierra el pod antes, el cambio se pierde.
    Start-Sleep 15
    Adb-Shell $serial 'sync' 15 | Out-Null
}

# Si tras un reinicio las apps no quedaron deshabilitadas, se repite (idempotente).
function Asegurar-Deshabilitadas([string] $serial) {
    $d = (Adb-Shell $serial 'pm list packages -d' 20).Texto
    if ($d -notmatch 'com\.android\.vending') { Escribir '    Las apps deshabilitadas no persistieron; las repito.' Yellow; Deshabilitar-Apps $serial }
}

function Abrir-Wa([string] $serial) {
    for ($i = 0; $i -lt 3; $i++) {
        Adb-Shell $serial "am start -n $Paquete/$ActividadWa" 20 | Out-Null
        Start-Sleep 6
        $foco = (Adb-Shell $serial 'dumpsys window | grep mCurrentFocus' 20).Salida
        if ($foco -match 'com\.whatsapp') { return $true }
    }
    return $false
}

# ---------- ventana ----------

function Traer-Ventana($pod) {
    if (-not ('PodsWin' -as [type])) {
        Add-Type -Namespace '' -Name 'PodsWin' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
'@
    }
    $procId = Obtener-PidPod $pod
    if (-not $procId) { return }
    $h = (Get-Process -Id $procId).MainWindowHandle
    if ($h -ne [IntPtr]::Zero) { [PodsWin]::ShowWindow($h, 9) | Out-Null; [PodsWin]::SetForegroundWindow($h) | Out-Null }
}

# ---------- instalación de BlueStacks ----------

function Instalar-BlueStacks {
    if (Detectar-BlueStacks) { Escribir 'BlueStacks ya está instalado.' Green }
    else {
        Escribir 'BlueStacks no está instalado. Lo instalo con winget (descarga de ~3,7 GB).' Yellow
        Escribir 'Ojo: saldrá una ventana de UAC (permisos de administrador) y luego la ventana del instalador de BlueStacks.' Yellow
        Escribir 'Debes aceptar el UAC y pulsar el botón de instalar. Este script espera hasta que termine (hasta 30 minutos).' Yellow
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            throw 'No encuentro winget. Instala "App Installer" desde Microsoft Store, o descarga BlueStacks 5 de bluestacks.com y ejecútalo con: BlueStacksInstaller.exe --defaultImageName Rvc64 --imageToLaunch Rvc64'
        }
        winget install -e --id BlueStack.BlueStacks --accept-package-agreements --accept-source-agreements --override "--defaultImageName $ImagenBase --imageToLaunch $ImagenBase"
        Escribir 'Esperando a que BlueStacks termine de instalarse (Android 11)...'
        $limite = (Get-Date).AddMinutes(30)
        $listo = $false
        while ((Get-Date) -lt $limite) {
            if (Detectar-BlueStacks) {
                $t = Leer-Conf
                if ((Obtener-ConfValor $t 'bst.installed_images') -match $ImagenBase -and (Test-Path (Join-Path $script:BsEngine "$ImagenBase\Root.vhd"))) { $listo = $true; break }
            }
            Start-Sleep 10
        }
        if (-not $listo) { throw "La instalación no terminó en 30 minutos. Revisa que el instalador siga abierto o instala BlueStacks a mano (ver README) y vuelve a ejecutar 'instalar'." }
        Escribir 'BlueStacks instalado. Cierro su ventana para aplicar la configuración.' Green
        Start-Sleep 20
    }
    Preparar-Base
}

function Aplicar-ConfGlobal([string] $t) {
    foreach ($k in $ConfGlobal.Keys) { $t = Poner-ConfValor $t $k $ConfGlobal[$k] }
    foreach ($k in $ConfGlobalVolatil.Keys) { $t = Poner-ConfValor $t $k $ConfGlobalVolatil[$k] }
    return $t
}

# Ajustes globales "estables" + nombre de la instancia base (si no es ya un pod, queda como "wa-base").
function Calcular-Base([string] $t) {
    foreach ($k in $ConfGlobal.Keys) { $t = Poner-ConfValor $t $k $ConfGlobal[$k] }
    $vis = Obtener-NombreVisible $t $ImagenBase
    if ($vis -and $vis -notlike "$Prefijo*") { $t = Poner-ConfValor $t "bst.instance.$ImagenBase.display_name" "${Prefijo}base" }
    return $t
}

# Deja lista la instancia base Rvc64 y los ajustes globales. Idempotente: si no hay nada que cambiar, no toca ni cierra nada.
function Preparar-Base {
    if (-not (Detectar-BlueStacks)) { throw 'BlueStacks no está instalado. Ejecuta "instalar".' }
    $t = Leer-Conf
    if ((Obtener-ConfValor $t 'bst.installed_images') -notmatch $ImagenBase) {
        throw "BlueStacks no tiene la imagen Android 11 ($ImagenBase). Ejecuta 'instalar' (o créala desde el Administrador de instancias: Instancia nueva > Android 11)."
    }
    if ((Calcular-Base $t) -eq $t) { return }
    $prendidos = Cerrar-PodsPrendidos
    Guardar-Conf (Aplicar-ConfGlobal (Calcular-Base (Leer-Conf)))
    Escribir 'Configuración global de BlueStacks aplicada (adb activo, anuncios fuera, GPU integrada).' Green
    Reabrir-Pods $prendidos $null
}

# ---------- crear instancias (clonado de la plantilla limpia) ----------

# Plantilla limpia = Data_orig.vhdx de la imagen base (el disco de datos de fábrica, ~84 MB, sin cuentas).
# NUNCA se clona el Data.vhdx de un pod: duplicaría la cuenta de WhatsApp.
function Probar-Plantilla {
    $base = Join-Path $script:BsEngine $ImagenBase
    foreach ($f in 'Data_orig.vhdx', 'fastboot.vdi', 'Root.vhd') {
        if (-not (Test-Path (Join-Path $base $f))) { return $false }
    }
    return $true
}

function Convertir-BstkNuevo([string] $texto, [string] $id, [string] $rootVhd, [string] $uuidMaquina, [string] $uuidFast, [string] $uuidData, [string] $mac) {
    $texto = $texto -replace '\r\n', "`n"
    $ev = [System.Text.RegularExpressions.MatchEvaluator] { param($m) $m.Groups[1].Value + '{' + $uuidMaquina + '}' + $m.Groups[2].Value + $id + $m.Groups[3].Value }
    $texto = ([regex]'(<Machine uuid=")\{[^}]*\}(" name=")[^"]*(")').Replace($texto, $ev, 1)
    $f = [regex]::Match($texto, 'uuid="\{([^}]+)\}" location="fastboot\.vdi"').Groups[1].Value
    $d = [regex]::Match($texto, 'uuid="\{([^}]+)\}" location="Data\.vhdx"').Groups[1].Value
    if (-not $f -or -not $d) { throw 'La plantilla .bstk no tiene el formato esperado (fastboot/Data).' }
    $texto = $texto.Replace($f, $uuidFast).Replace($d, $uuidData)
    $texto = $texto.Replace('location="Root.vhd"', "location=`"$rootVhd`"")
    $texto = ([regex]'MACAddress="[0-9A-Fa-f]{12}"').Replace($texto, "MACAddress=`"$mac`"", 1)
    return $texto
}

function Crear-InstanciaClonada([string] $nombre) {
    if (-not (Probar-Plantilla)) { return $null }
    $texto = Leer-Conf
    $id = Siguiente-IdInstancia $texto $ImagenBase
    $base = Join-Path $script:BsEngine $ImagenBase
    $dir = Join-Path $script:BsEngine $id
    $u = @{ maq = Nueva-GuidTexto; fast = Nueva-GuidTexto; data = Nueva-GuidTexto }
    $mac = '08002701' + ('{0:X4}' -f (Get-Random -Maximum 65536))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    try {
        Copy-Item (Join-Path $base 'Data_orig.vhdx') (Join-Path $dir 'Data.vhdx')
        Copy-Item (Join-Path $base 'fastboot.vdi') (Join-Path $dir 'fastboot.vdi')
        foreach ($par in @(@('Data.vhdx', $u.data), @('fastboot.vdi', $u.fast))) {
            $out = Invoke-VmMgr @('internalcommands', 'sethduuid', (Join-Path $dir $par[0]), $par[1])
            if ($out -notmatch 'UUID changed') { throw "No pude asignar un UUID nuevo a $($par[0]): $out" }
        }
        # El .bstk sale de la instancia base ya registrada (o, si no existe, de Android.bstk.in con sus marcadores resueltos).
        $fuente = Join-Path $base "$ImagenBase.bstk"
        if (Test-Path $fuente) { $xml = [IO.File]::ReadAllText($fuente) }
        else {
            $xml = [IO.File]::ReadAllText((Join-Path $base 'Android.bstk.in'))
            $xml = $xml.Replace('@@HD_VDES_SERVICE_DLL_PATH@@', (Join-Path $script:BsDir 'HD-Vdes-Service.dll')).Replace('@@BST_VM_MEMORY_SIZE@@', '4096')
        }
        $rootVhd = Join-Path $base 'Root.vhd'      # compartido (solo lectura): ahorra 2,2 GB por pod
        $nuevo = Convertir-BstkNuevo $xml $id $rootVhd $u.maq $u.fast $u.data $mac
        [IO.File]::WriteAllText((Join-Path $dir "$id.bstk"), $nuevo, (New-Object Text.UTF8Encoding($false)))
        $in = Join-Path $base 'Android.bstk.in'
        if (Test-Path $in) {
            $nuevoIn = Convertir-BstkNuevo ([IO.File]::ReadAllText($in)) $id $rootVhd $u.maq $u.fast $u.data $mac
            [IO.File]::WriteAllText((Join-Path $dir 'Android.bstk.in'), $nuevoIn, (New-Object Text.UTF8Encoding($false)))
        }
        $out = Invoke-VmMgr @('registervm', (Join-Path $dir "$id.bstk"))
        if ((Invoke-VmMgr @('list', 'vms')) -notmatch [regex]::Escape($id)) { throw "No pude registrar la máquina virtual: $out" }
    } catch {
        Quitar-InstanciaArchivos $id
        throw
    }
    return $id
}

# Desregistra (SIN --delete: borraría también el Root.vhd compartido) y borra la carpeta de la instancia.
function Quitar-InstanciaArchivos([string] $id) {
    if ($id -eq $ImagenBase) { throw 'Protección: no se borra la instancia base (tiene el Root.vhd compartido).' }
    $vms = Invoke-VmMgr @('list', 'vms')
    if ($vms -match ('"' + [regex]::Escape($id) + '"')) { Invoke-VmMgr @('unregistervm', $id) | Out-Null }
    $dir = Join-Path $script:BsEngine $id
    if (Test-Path $dir) {
        # Seguridad extra: solo se borra una carpeta de instancia dentro de Engine, nunca la base.
        if ((Split-Path $dir -Parent) -ne $script:BsEngine) { throw "Ruta inesperada: $dir" }
        Remove-Item $dir -Recurse -Force
    }
}

# Plan B (no probado aquí): el usuario crea la instancia en el Administrador de instancias y el script la adopta.
function Crear-InstanciaGuiada([string] $nombre) {
    Exigir-Interactivo 'crear la instancia a mano en el Administrador de instancias'
    Escribir 'No encuentro la plantilla limpia, así que necesito que crees la instancia a mano (una sola vez):' Yellow
    Escribir '  1) En el Administrador de instancias (se abre ahora) pulsa "Instancia nueva".' Yellow
    Escribir '  2) Elige "Android 11" (Nueva instancia > Android 11, 64 bits) y pulsa "Siguiente".' Yellow
    Escribir '  3) Núcleos de CPU: 2. Memoria: la opción más alta hasta 3 GB (el primer arranque necesita 3 GB). Resolución: Retrato 540x960, DPI 240. ABI: x86 y ARM.' Yellow
    Escribir '  4) Pulsa "Descargar" y espera. No abras nada más.' Yellow
    $antes = Obtener-ConfIds (Leer-Conf)
    Start-Process $script:Mim | Out-Null
    $nuevo = $null
    $limite = (Get-Date).AddMinutes(30)
    while ((Get-Date) -lt $limite -and -not $nuevo) {
        Start-Sleep 5
        $ahora = Obtener-ConfIds (Leer-Conf)
        $nuevo = $ahora | Where-Object { $antes -notcontains $_ -and $_ -match "^$ImagenBase(_\d+)?$" } | Select-Object -First 1
    }
    if (-not $nuevo) { throw 'No apareció ninguna instancia Android 11 nueva en 30 minutos.' }
    Escribir "Detecté la instancia nueva '$nuevo'. Cierra el Administrador de instancias; continúo solo." Green
    for ($i = 0; $i -lt 120 -and (Get-Process -Name 'HD-MultiInstanceManager' -ErrorAction SilentlyContinue); $i++) { Start-Sleep 2 }
    Cerrar-ResidualesBlueStacks
    return $nuevo
}

# Claves de conf para una instancia nueva a partir de la base (sin identidad ni estado de ejecución).
function Armar-ConfPod([string] $texto, [string] $id, [string] $nombre, [int] $puerto) {
    $v = Obtener-ConfInstancia $texto $ImagenBase
    if ($v.Count -eq 0) { throw "No encuentro la configuración de la instancia base $ImagenBase en bluestacks.conf." }
    $v['display_name']          = "$Prefijo$nombre"
    $v['android_id']            = Nuevo-AndroidId
    $v['android_google_ad_id']  = Nueva-GuidTexto
    $v['adb_port']              = "$puerto"
    $v['first_boot']            = '1'
    $v['boot_duration']         = '-1'
    $v['cpus']                  = $Arranque.cpus
    $v['ram']                   = $Arranque.ram
    $v['max_fps']               = $Arranque.fps
    $v['fb_width']              = $Pantalla.ancho
    $v['fb_height']             = $Pantalla.alto
    $v['dpi']                   = $Pantalla.dpi
    $v['custom_resolution_selected'] = '0'
    return $v
}

function Registrar-EnMim([string] $id, [string] $nombre) {
    $ruta = Join-Path $script:BsEngine 'UserData\MimMetaData.json'
    if (-not (Test-Path $ruta)) { return }
    $d = Get-Content $ruta -Raw | ConvertFrom-Json
    $lista = @($d.Organization)
    $lista = @($lista | Where-Object { $_.InstanceName -ne $id })
    $maxId = ($lista | ForEach-Object { [int]$_.ID } | Measure-Object -Maximum).Maximum
    $lista += [pscustomobject]@{ ID = [int]$maxId + 1; Name = "$Prefijo$nombre"; IsFolder = $false; ParentFolder = -1; IsOpen = $false; IsVisible = $true; InstanceName = $id }
    $d.Organization = $lista
    [IO.File]::WriteAllText($ruta, ($d | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
}

function Renombrar-EnMim([string] $id, [string] $nombre) {
    $ruta = Join-Path $script:BsEngine 'UserData\MimMetaData.json'
    if (-not (Test-Path $ruta)) { return }
    $d = Get-Content $ruta -Raw | ConvertFrom-Json
    foreach ($e in @($d.Organization)) { if ($e.InstanceName -eq $id) { $e.Name = "$Prefijo$nombre" } }
    [IO.File]::WriteAllText($ruta, ($d | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
}

function Quitar-DeMim([string] $id) {
    $ruta = Join-Path $script:BsEngine 'UserData\MimMetaData.json'
    if (-not (Test-Path $ruta)) { return }
    $d = Get-Content $ruta -Raw | ConvertFrom-Json
    $d.Organization = @($d.Organization | Where-Object { $_.InstanceName -ne $id })
    [IO.File]::WriteAllText($ruta, ($d | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
}

# ---------- acciones ----------

function Asegurar-BlueStacks {
    if (-not (Detectar-BlueStacks)) {
        Exigir-Interactivo 'instalar BlueStacks'
        Escribir 'BlueStacks no está instalado: empiezo la instalación de primera vez.' Yellow
        Instalar-BlueStacks
        if (-not (Detectar-BlueStacks)) { throw 'BlueStacks sigue sin estar disponible tras la instalación.' }
    }
    if ((Obtener-ConfValor (Leer-Conf) 'bst.installed_images') -notmatch $ImagenBase) { Exigir-Interactivo "instalar la imagen $ImagenBase"; Instalar-BlueStacks }
}

function Listar {
    $pods = @(Obtener-Pods)
    if ($pods.Count -eq 0) { Escribir 'No hay pods todavía. Crea uno con la opción "nuevo".' Yellow; return }
    $wsp = Leer-Wsp
    $filas = foreach ($p in $pods) {
        $procId = Obtener-PidPod $p
        $serial = $null; $wa = '-'; $ram = ''
        if ($procId) {
            $serial = Obtener-Serial $p
            if ($serial) { $wa = if (Wa-Instalado $serial) { 'sí' } else { 'no' } }
            $ram = '{0} MB' -f [math]::Round((Get-Process -Id $procId).WorkingSet64 / 1MB)
        }
        [pscustomobject]@{
            Pod       = $p.Nombre
            '#wsp'    = if ($wsp.Contains($p.Instancia)) { $wsp[$p.Instancia] } else { '-' }
            Instancia = $p.Instancia
            Estado    = if ($procId) { 'PRENDIDO' } else { 'apagado' }
            Adb       = if ($serial) { $serial } else { '-' }
            WhatsApp  = $wa
            RAM       = $ram
        }
    }
    $filas | Format-Table -AutoSize | Out-Host
}

# Listado en JSON puro por stdout (misma logica de estado que Listar, sin tabla ni mensajes).
function Listar-Json {
    $wsp = Leer-Wsp
    $filas = foreach ($p in @(Obtener-Pods)) {
        $procId = Obtener-PidPod $p
        $serial = $null
        if ($procId) { $serial = Obtener-Serial $p }
        $tel = if ($wsp.Contains($p.Instancia)) { $wsp[$p.Instancia] } else { $null }
        Convertir-PodAFilaJson $p ([bool]$procId) $serial $tel
    }
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    [Console]::Out.WriteLine((Convertir-FilasAJson $filas))
}

# Rutas que la app necesita para hablar con adb (una sola linea JSON).
function Convertir-InfoAJson([string] $adb, [string] $hdPlayer) {
    return ([ordered]@{ adb = $adb; hdPlayer = $hdPlayer } | ConvertTo-Json -Compress)
}

function Info-Json {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    [Console]::Out.WriteLine((Convertir-InfoAJson $script:Adb $script:HdPlayer))
}

function Prender([string] $nombre) {
    $pod = Obtener-Pod $nombre
    if (-not (Pod-Prendido $pod)) { Iniciar-Pod $pod }
    $serial = Esperar-Android $pod
    Escribir "Pod '$nombre' prendido." Green
    # WhatsApp no tiene icono en el launcher de BlueStacks (se instala por adb): se abre solo para que no haya que buscarlo.
    try {
        if (-not (Wa-Instalado $serial)) { Escribir "    WhatsApp Business no está instalado en '$nombre'. Usa 'reinstalar-wa $nombre'." Yellow }
        elseif (-not (Abrir-Wa $serial)) { Escribir '    No pude confirmar que WhatsApp quedó en primer plano; usa el botón WhatsApp de la app o 'abrir-wa'.' Yellow }
    } catch { Escribir "    No pude abrir WhatsApp automáticamente: $($_.Exception.Message)" Yellow }
}

function Abrir-WaPod([string] $nombre) {
    $pod = Obtener-Pod $nombre
    if (-not (Pod-Prendido $pod)) { throw "El pod '$nombre' está apagado. Prende el pod primero (acción 'prender')." }
    $serial = Obtener-Serial $pod
    if (-not $serial -or -not (Android-Listo $serial)) { $serial = Esperar-Android $pod 45 }
    if (-not (Wa-Instalado $serial)) { throw "WhatsApp Business no está instalado en el pod '$nombre'. Usa 'reinstalar-wa $nombre' para instalarlo sin perder la cuenta." }
    if (Abrir-Wa $serial) { Escribir "WhatsApp Business abierto en el pod '$nombre'." Green }
    else { throw "No pude confirmar que WhatsApp Business quedó abierto en '$nombre'. Revisa la ventana del pod o inténtalo de nuevo." }
}

function Apagar([string] $nombre) {
    $pod = Obtener-Pod $nombre
    Detener-Pod $pod
    Escribir "Pod '$nombre' apagado. La cuenta queda guardada." Green
}

function Ver([string] $nombre) {
    $pod = Obtener-Pod $nombre
    $estaba = Pod-Prendido $pod
    if (-not $estaba) { Prender $nombre }
    Traer-Ventana $pod
    Escribir "Ventana del pod '$nombre' al frente." Green
}

function Todos([string] $accion) {
    foreach ($pod in Obtener-Pods) {
        if ($accion -eq 'prender') { Prender $pod.Nombre } else { Apagar $pod.Nombre }
    }
}

function Borrar([string] $nombre) {
    $pod = Obtener-Pod $nombre
    if ($pod.Instancia -eq $ImagenBase) {
        throw "El pod '$nombre' es la instancia base ($ImagenBase): aloja el Root.vhd que comparten todos los pods, así que no se puede borrar desde aquí."
    }
    Escribir "Esto BORRA el pod '$nombre' y la cuenta de WhatsApp que tenga dentro. No se puede deshacer." Red
    if (-not $script:NoInteractivo) {
        $confirmacion = Read-Host 'Escribe el nombre del pod para confirmar'
        if (-not (Test-Confirmacion $nombre $confirmacion)) { Escribir 'Cancelado.' Yellow; return }
    }
    $prendidos = Cerrar-PodsPrendidos
    Quitar-InstanciaArchivos $pod.Instancia
    Guardar-Conf (Quitar-ConfInstancia (Leer-Conf) $pod.Instancia)
    Quitar-DeMim $pod.Instancia
    Guardar-Wsp (Poner-WspEnMapa (Leer-Wsp) $pod.Instancia '')
    Reabrir-Pods $prendidos $pod
    Escribir "Pod '$nombre' borrado." Green
}

function Renombrar([string] $nombre, [string] $nuevo) {
    $pod = Obtener-Pod $nombre
    if (-not (Test-NombrePod $nuevo)) { throw 'El nombre solo puede tener letras, números, guion y guion bajo (máximo 24 caracteres).' }
    if ($nuevo -eq $nombre) { Escribir 'Es el mismo nombre; no hay nada que cambiar.' Yellow; return }
    if (Obtener-Pods | Where-Object { $_.Nombre -eq $nuevo }) { throw "Ya existe un pod llamado '$nuevo'." }
    $prendidos = Cerrar-PodsPrendidos
    Guardar-Conf (Renombrar-ConfPod (Leer-Conf) $pod.Instancia $nuevo)
    Renombrar-EnMim $pod.Instancia $nuevo
    Reabrir-Pods $prendidos
    Escribir "Pod '$nombre' renombrado a '$nuevo' (la cuenta de WhatsApp no se tocó)." Green
}

# Solo es una etiqueta para identificar el pod: no toca BlueStacks ni la cuenta.
function Poner-Wsp([string] $nombre, [string] $numero) {
    $pod = Obtener-Pod $nombre
    $numero = $numero.Trim()
    if ($numero -and -not (Test-NumeroWsp $numero)) { throw 'El número solo puede tener dígitos (7 a 15), con + al inicio si quieres. Sin espacios.' }
    Guardar-Wsp (Poner-WspEnMapa (Leer-Wsp) $pod.Instancia $numero)
    if ($numero) { Escribir "Pod '$nombre': #wsp $numero." Green } else { Escribir "Pod '$nombre' quedó sin #wsp." Green }
}

function Aplicar-Final($pod) {
    # Ajustes de ahorro en el conf (con BlueStacks cerrado); devuelve los pods que había que reabrir.
    $id = $pod.Instancia
    $prendidos = Cerrar-PodsPrendidos
    $t = Leer-Conf
    $t = Poner-ConfValor $t "bst.instance.$id.cpus" $Final.cpus
    $t = Poner-ConfValor $t "bst.instance.$id.ram" $Final.ram
    $t = Poner-ConfValor $t "bst.instance.$id.max_fps" $Final.fps
    $t = Aplicar-ConfGlobal $t
    Guardar-Conf $t
    return $prendidos
}

function Nuevo([string] $nombre) {
    if (-not $nombre) { throw 'Falta el nombre del pod.' }
    if (-not (Test-NombrePod $nombre)) { throw 'El nombre solo puede tener letras, números, guion y guion bajo (máximo 24 caracteres).' }
    $total = 9
    Paso 1 $total 'Comprobando requisitos'
    Asegurar-BlueStacks
    if (Obtener-Pods | Where-Object { $_.Nombre -eq $nombre }) { throw "Ya existe un pod llamado '$nombre'." }
    Obtener-Apks | Out-Null
    $libre = (Get-PSDrive -Name ($script:BsEngine.Substring(0, 1))).Free / 1GB
    if ($libre -lt $EspacioMinGB) { throw "Poco espacio en disco ($([math]::Round($libre, 1)) GB libres); se recomiendan al menos $EspacioMinGB GB." }

    Paso 2 $total 'Creando la instancia de BlueStacks (clon de la plantilla limpia)'
    $prendidos = @(Obtener-Pods | Where-Object { Pod-Prendido $_ })
    if ($prendidos.Count -gt 0) { Escribir "    Cierro BlueStacks un momento (volveré a abrir: $(($prendidos | ForEach-Object Nombre) -join ', '))." Yellow }
    foreach ($p in $prendidos) { Detener-Pod $p }
    Cerrar-ResidualesBlueStacks

    $id = Crear-InstanciaClonada $nombre
    if (-not $id) { $id = Crear-InstanciaGuiada $nombre }

    $texto = Leer-Conf
    $puerto = Siguiente-PuertoAdb $texto $PuertoAdbBase
    $texto = Quitar-ConfInstancia $texto $id
    $texto = Agregar-ConfInstancia $texto $id (Armar-ConfPod $texto $id $nombre $puerto)
    $texto = Poner-ConfValor $texto 'bst.next_vm_id' ([string]([int](Obtener-ConfValor $texto 'bst.next_vm_id') + 1))
    $texto = Aplicar-ConfGlobal $texto
    Guardar-Conf $texto
    Registrar-EnMim $id $nombre
    $pod = Obtener-Pod $nombre

    Paso 3 $total "Primer arranque ($($Arranque.cpus) núcleos, $($Arranque.ram) MB; después baja a $($Final.cpus) núcleos y $($Final.ram) MB)"
    Reabrir-Pods $prendidos $pod
    Iniciar-Pod $pod
    try {
        $serial = Esperar-Android $pod

        Paso 4 $total 'Instalando WhatsApp Business'
        Instalar-Wa $serial -PermitirDesinstalar

        Paso 5 $total 'Compilando WhatsApp (AOT)'
        Compilar-Wa $serial

        Paso 6 $total 'Deshabilitando apps innecesarias'
        Deshabilitar-Apps $serial
    } catch {
        Escribir "Falló la creación del pod '$nombre': $($_.Exception.Message)" Red
        Escribir "El pod quedó creado a medias. Puedes reintentar con 'reinstalar-wa $nombre' o borrarlo con 'borrar $nombre'." Yellow
        throw
    }

    Paso 7 $total 'Bajando a los recursos finales (reinicia BlueStacks un momento)'
    $prendidos = Aplicar-Final $pod
    Paso 8 $total 'Reiniciando el pod'
    Reabrir-Pods $prendidos $null
    Iniciar-Pod $pod
    $serial = Esperar-Android $pod

    Paso 9 $total 'Abriendo WhatsApp Business'
    Asegurar-Deshabilitadas $serial
    if (-not (Abrir-Wa $serial)) { Escribir '    No pude confirmar que WhatsApp quedó en primer plano; ábrelo desde la ventana.' Yellow }
    Traer-Ventana $pod
    Escribir "Pod '$nombre' listo. Registra el número a mano en la ventana de BlueStacks (pantalla de bienvenida de WhatsApp)." Green
}

function Optimizar-Uno($pod) {
    $id = $pod.Instancia
    $texto = Leer-Conf
    $ya = ((Obtener-ConfValor $texto "bst.instance.$id.cpus") -eq $Final.cpus) -and ((Obtener-ConfValor $texto "bst.instance.$id.ram") -eq $Final.ram) -and ((Obtener-ConfValor $texto "bst.instance.$id.max_fps") -eq $Final.fps)
    $estaba = Pod-Prendido $pod
    if (-not $ya) {
        Escribir "    $($pod.Nombre): ajustando CPU/RAM/FPS..."
        $prendidos = Aplicar-Final $pod
        Reabrir-Pods $prendidos $null
    }
    if (-not (Pod-Prendido $pod)) { Iniciar-Pod $pod }
    $serial = Esperar-Android $pod
    Escribir "    $($pod.Nombre): deshabilitando apps innecesarias..."
    Deshabilitar-Apps $serial
    Asegurar-Deshabilitadas $serial
    if (-not $estaba) { Detener-Pod $pod }
}

function Optimizar([string] $nombre) {
    if (-not (Detectar-BlueStacks)) { throw 'BlueStacks no está instalado.' }
    Preparar-Base
    $objetivo = if ($nombre -eq 'todos') { @(Obtener-Pods) } else { @(Obtener-Pod $nombre) }
    foreach ($p in $objetivo) { Optimizar-Uno $p }
    Escribir 'Optimización aplicada.' Green
}

function Reinstalar-Wa([string] $nombre) {
    $pod = Obtener-Pod $nombre
    $estaba = Pod-Prendido $pod
    if (-not $estaba) { Iniciar-Pod $pod }
    $serial = Esperar-Android $pod
    Instalar-Wa $serial           # -r: conserva datos; nunca desinstala
    Compilar-Wa $serial
    Escribir "WhatsApp reinstalado y compilado en '$nombre' (la cuenta no se tocó)." Green
    if (-not $estaba) { Detener-Pod $pod }
}

function Menu {
    while ($true) {
        Write-Host ''
        Escribir '=== Pods de WhatsApp (BlueStacks) ===' Cyan
        try { Listar } catch { Escribir "Error: $($_.Exception.Message)" Red }
        Write-Host '1) Nuevo pod      2) Prender       3) Apagar        4) Ver ventana'
        Write-Host '5) Prender todos  6) Apagar todos  7) Optimizar     8) Reinstalar WhatsApp'
        Write-Host '9) Borrar pod     10) Instalar BlueStacks (primera vez)   11) Renombrar pod'
        Write-Host '12) Actualizar lista (o solo Enter)   13) Poner #wsp (número del pod)'
        Write-Host '0) Salir'
        $op = Read-Host 'Opción'
        try {
            switch ($op) {
                '1'  { Nuevo (Read-Host 'Nombre del pod (ej. bebidas1)') }
                '2'  { Prender (Read-Host 'Pod') }
                '3'  { Apagar (Read-Host 'Pod') }
                '4'  { Ver (Read-Host 'Pod') }
                '5'  { Todos 'prender' }
                '6'  { Todos 'apagar' }
                '7'  { Optimizar (Read-Host 'Pod (o "todos")') }
                '8'  { Reinstalar-Wa (Read-Host 'Pod') }
                '9'  { Borrar (Read-Host 'Pod') }
                '10' { Instalar-BlueStacks }
                '11' { Renombrar (Read-Host 'Pod actual') (Read-Host 'Nombre nuevo (ej. pod1-3042374349)') }
                '13' { Poner-Wsp (Read-Host 'Pod') (Read-Host 'Número de WhatsApp (vacío para quitarlo)') }
                '12' { }   # el bucle vuelve a mostrar la lista
                ''   { }
                '0'  { return }
                default { Escribir 'Opción no válida.' Yellow }
            }
        } catch { Escribir "Error: $($_.Exception.Message)" Red }
    }
}

# ---------- entrada ----------

# Con "dot-sourcing" (. .\pods.ps1) solo se cargan las funciones (lo usan las pruebas).
if ($MyInvocation.InvocationName -eq '.') { return }

Usar-Utf8
$script:NoInteractivo = [bool]$NoInteractivo

if ($Accion -ne 'instalar') {
    if (-not (Detectar-BlueStacks)) {
        if ($Accion -eq 'nuevo') { Escribir 'BlueStacks no está instalado.' Yellow }
        elseif ($Accion) { throw 'BlueStacks no está instalado. Ejecuta primero: .\pods.ps1 instalar' }
    }
}

switch ($Accion) {
    ''              { if (-not (Detectar-BlueStacks)) { Escribir 'BlueStacks no está instalado; elige la opción 10 para instalarlo.' Yellow }; Menu }
    'instalar'      { Instalar-BlueStacks }
    'listar'        { Listar }
    'listar-json'   { Listar-Json }
    'info-json'     { Info-Json }
    'nuevo'         { Nuevo $Nombre }
    'prender'       { Prender $Nombre }
    'apagar'        { Apagar $Nombre }
    'ver'           { Ver $Nombre }
    'abrir-wa'      { Abrir-WaPod $Nombre }
    'borrar'        { Borrar $Nombre }
    'renombrar'     { Renombrar $Nombre $Extra }
    'wsp'           { Poner-Wsp $Nombre $Extra }
    'optimizar'     { Optimizar $Nombre }
    'reinstalar-wa' { Reinstalar-Wa $Nombre }
    'prender-todos' { Todos 'prender' }
    'apagar-todos'  { Todos 'apagar' }
    default         { throw "Acción desconocida '$Accion'. Usa: instalar, nuevo, listar, listar-json, info-json, prender, apagar, ver, abrir-wa, borrar, renombrar, wsp, optimizar, reinstalar-wa, prender-todos, apagar-todos." }
}
