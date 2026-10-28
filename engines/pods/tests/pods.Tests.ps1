# Pruebas de las funciones puras de pods.ps1 (Pester 3 o 5).  Ejecutar:  Invoke-Pester .\tests
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path (Split-Path $aqui -Parent) 'pods.ps1')

$conf = "bst.country=`"CO`"`nbst.instance.Rvc64.adb_port=`"5555`"`nbst.instance.Rvc64.display_name=`"wa-piloto`"`nbst.instance.Rvc64.cpus=`"2`"`nbst.instance.Rvc64.status.adb_port=`"5555`"`nbst.key_controls=`"1`"`n"

Describe 'Test-NombrePod' {
    It 'acepta nombres validos' {
        Test-NombrePod 'bebidas1' | Should Be $true
        Test-NombrePod 'a_b-c' | Should Be $true
    }
    It 'rechaza nombres invalidos' {
        Test-NombrePod '' | Should Be $false
        Test-NombrePod '-x' | Should Be $false
        Test-NombrePod 'con espacio' | Should Be $false
        Test-NombrePod 'ñandú' | Should Be $false
        Test-NombrePod ('a' * 25) | Should Be $false
    }
}

Describe 'conf' {
    It 'lee un valor' { Obtener-ConfValor $conf 'bst.instance.Rvc64.cpus' | Should Be '2' }
    It 'devuelve null si no existe' { Obtener-ConfValor $conf 'bst.nada' | Should Be $null }
    It 'cambia un valor existente sin tocar el resto' {
        $n = Poner-ConfValor $conf 'bst.instance.Rvc64.cpus' '4'
        Obtener-ConfValor $n 'bst.instance.Rvc64.cpus' | Should Be '4'
        Obtener-ConfValor $n 'bst.country' | Should Be 'CO'
    }
    It 'agrega una clave nueva' {
        $n = Poner-ConfValor $conf 'bst.nueva' 'x'
        Obtener-ConfValor $n 'bst.nueva' | Should Be 'x'
    }
    It 'tolera $ en el valor' {
        $n = Poner-ConfValor $conf 'bst.country' 'a$1b'
        Obtener-ConfValor $n 'bst.country' | Should Be 'a$1b'
    }
    It 'lista ids y claves de instancia (sin status)' {
        (Obtener-ConfIds $conf) -join ',' | Should Be 'Rvc64'
        $d = Obtener-ConfInstancia $conf 'Rvc64'
        $d['cpus'] | Should Be '2'
        $d.Contains('status.adb_port') | Should Be $false
    }
    It 'agrega y quita una instancia' {
        $v = Obtener-ConfInstancia $conf 'Rvc64'
        $v['display_name'] = 'wa-x'
        $n = Agregar-ConfInstancia $conf 'Rvc64_1' $v
        Obtener-ConfValor $n 'bst.instance.Rvc64_1.display_name' | Should Be 'wa-x'
        Obtener-ConfValor $n 'bst.key_controls' | Should Be '1'
        $q = Quitar-ConfInstancia $n 'Rvc64_1'
        $q | Should Be $conf
    }
    It 'elige un puerto adb libre' {
        Siguiente-PuertoAdb $conf 5555 | Should Be 5565
        Siguiente-PuertoAdb $conf 5565 | Should Be 5565
    }
}

Describe 'Renombrar-ConfPod' {
    It 'cambia solo el nombre visible de la instancia' {
        $n = Renombrar-ConfPod $conf 'Rvc64' 'pod1-3042374349'
        Obtener-ConfValor $n 'bst.instance.Rvc64.display_name' | Should Be 'wa-pod1-3042374349'
        Obtener-ConfValor $n 'bst.instance.Rvc64.adb_port' | Should Be '5555'
        Obtener-ConfValor $n 'bst.instance.Rvc64.cpus' | Should Be '2'
        ($n -replace 'wa-pod1-3042374349', 'wa-piloto') | Should Be $conf
    }
    It 'falla si la instancia no existe' {
        { Renombrar-ConfPod $conf 'Rvc64_9' 'x' } | Should Throw
    }
}

Describe 'Test-NumeroWsp' {
    It 'acepta numeros de telefono' {
        Test-NumeroWsp '3042374349' | Should Be $true
        Test-NumeroWsp '+573042374349' | Should Be $true
    }
    It 'rechaza lo que no es un numero' {
        Test-NumeroWsp '' | Should Be $false
        Test-NumeroWsp '304 237' | Should Be $false
        Test-NumeroWsp 'abc' | Should Be $false
        Test-NumeroWsp '123' | Should Be $false
    }
}

Describe 'Poner-WspEnMapa' {
    It 'guarda, cambia y borra el numero de una instancia sin tocar las otras' {
        $m = Poner-WspEnMapa @{} 'Rvc64' '3042374349'
        $m = Poner-WspEnMapa $m 'Rvc64_1' '3110000000'
        $m['Rvc64'] | Should Be '3042374349'
        $m = Poner-WspEnMapa $m 'Rvc64' '3200000000'
        $m['Rvc64'] | Should Be '3200000000'
        $m = Poner-WspEnMapa $m 'Rvc64' ''
        $m.Contains('Rvc64') | Should Be $false
        $m['Rvc64_1'] | Should Be '3110000000'
    }
}

Describe 'Convertir-PodAFilaJson / Convertir-FilasAJson' {
    $pod = [pscustomobject]@{ Nombre = 'pod1'; Instancia = 'Rvc64_1'; Visible = 'wa-pod1'; Puerto = 5565; Serial = 'emulator-5564' }
    It 'marca un pod prendido con serial y telefono' {
        $f = Convertir-PodAFilaJson $pod $true 'emulator-5564' '3042374349'
        $f.name | Should Be 'pod1'
        $f.instanceId | Should Be 'Rvc64_1'
        $f.state | Should Be 'running'
        $f.serial | Should Be 'emulator-5564'
        $f.adbPort | Should Be 5565
        $f.phone | Should Be '3042374349'
    }
    It 'marca un pod apagado con serial y telefono nulos' {
        $f = Convertir-PodAFilaJson $pod $false '' ''
        $f.state | Should Be 'stopped'
        $f.serial | Should Be $null
        $f.phone | Should Be $null
    }
    It 'devuelve [] sin pods' {
        Convertir-FilasAJson @() | Should Be '[]'
    }
    It 'devuelve un arreglo JSON aunque haya un solo pod' {
        $json = Convertir-FilasAJson @(Convertir-PodAFilaJson $pod $false '' '')
        $json.TrimStart().StartsWith('[') | Should Be $true
        $datos = $json | ConvertFrom-Json
        @($datos).Count | Should Be 1
        $datos.instanceId | Should Be 'Rvc64_1'
    }
    It 'devuelve varios pods en orden' {
        $otro = [pscustomobject]@{ Nombre = 'pod2'; Instancia = 'Rvc64_2'; Visible = 'wa-pod2'; Puerto = 5575; Serial = 'emulator-5574' }
        $datos = (Convertir-FilasAJson @((Convertir-PodAFilaJson $pod $true 'e' '1'), (Convertir-PodAFilaJson $otro $false '' ''))) | ConvertFrom-Json
        @($datos).Count | Should Be 2
        $datos[1].name | Should Be 'pod2'
    }
}
