# Instalar agentAutoX1 en otra PC

## 1. Programas necesarios (una sola vez)

| Programa | Para qué | Dónde |
| --- | --- | --- |
| Git | Descargar y actualizar el proyecto | https://git-scm.com/download/win |
| Node.js 20 o superior (LTS) | Motores y pantalla de la app | https://nodejs.org |
| Rust | Compilar la app de escritorio | https://rustup.rs |
| Visual Studio 2022 Build Tools | Lo necesita Rust en Windows. Marca "Desarrollo para el escritorio con C++" | https://visualstudio.microsoft.com/es/downloads/ |
| GitHub CLI (opcional) | Iniciar sesión en GitHub fácil | https://cli.github.com |

Opcionales según lo que vayas a usar en esa PC: BlueStacks 5 (pods), Ollama (IA local del calentamiento) y Claude Code (agentes).

## 2. Descargar el proyecto

El repositorio es privado: primero inicia sesión con tu cuenta de GitHub y deja que git use esa sesión (así el botón
de actualizar funciona sin pedir contraseña):

```powershell
gh auth login
gh auth setup-git
```

Luego, en PowerShell:

```powershell
mkdir "$HOME\Proyectos\ventas automaticas"
cd "$HOME\Proyectos\ventas automaticas"
git clone https://github.com/space1902/agentAutoX1.git
cd agentAutoX1
powershell -ExecutionPolicy Bypass -File .\instalar.ps1
```

`instalar.ps1` revisa los programas, instala las dependencias y crea al lado del proyecto las carpetas de datos
vacías (`whatsapp-bot-tester` y `whatsapp-pods\apk`).

## 3. Abrir la app

```powershell
cd app
npm run tauri dev
```

La primera vez tarda varios minutos porque compila la parte de Rust.

## 4. Configurar esa PC (los datos no viajan con el proyecto)

El repositorio solo tiene el código. Tokens, sesiones de WhatsApp, base de anuncios y ajustes quedan en cada PC:

- **Anuncios → Configuración**: crea el portafolio y pega el token de Meta.
- **IA**: guarda la clave de OpenRouter si usas el calentamiento con IA.
- **Pods**: copia los APK de WhatsApp Business a `whatsapp-pods\apk`.
- **Agentes**: inicia sesión en Claude Code en esa PC.

**Importante:** no uses los mismos números de WhatsApp (calentamiento o pods) en las dos PC a la vez. Una sesión
copiada y abierta en dos lugares se desincroniza y WhatsApp puede cerrarla o suspender el número.

## 5. Recibir actualizaciones

**Desde la app:** en **Ajustes → Actualizaciones** toca **Buscar actualizaciones** y luego **Actualizar**. La app se
recarga sola (si cambió la parte de Rust, se recompila y vuelve a abrir en 1 o 2 minutos). Si la actualización trae
dependencias nuevas, la app te lo dice: en ese caso usa el script de abajo.

**Con el script** (la primera vez, o cuando la app lo pida):

1. Cierra la app (`Ctrl+C` en su terminal).
2. En la carpeta `agentAutoX1`:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\actualizar.ps1
   ```

3. Abre la app otra vez (`cd app` y `npm run tauri dev`).

`actualizar.ps1` baja lo último de `main` y reinstala dependencias solo si cambiaron. Si en esa PC se editó algún
archivo del proyecto, no actualiza y te avisa, para no borrar esos cambios.
