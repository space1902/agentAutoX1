# agentAutoX1

Windows desktop app that unifies two existing projects behind one UI:

- **MultiWhatsApp**: WhatsApp Business pods on BlueStacks 5 (`engines/pods`, PowerShell).
- **Calentador Bots**: Baileys WhatsApp warm-up profiles (`engines/warmup`, Node).

Stack: Tauri 2 (Rust) + React + TypeScript (Vite), framer-motion, lucide-react, Inter bundled locally.

## Layout

```
app/              Tauri 2 + React UI (src/ = frontend, src-tauri/ = Rust commands)
engines/warmup/   copy of whatsapp-bot-tester CODE (no data, no sessions) + AGENTAUTO_DATA_DIR support
engines/pods/     copy of pods.ps1 + Pester tests + the new `listar-json` action
```

## Where data lives (nothing is duplicated)

| What | Default location | How to change |
| --- | --- | --- |
| Warm-up data: `config.json`, `profiles.json`, `.baileys_auth/`, `results/`, `.env` | `..\whatsapp-bot-tester` | env `AGENTAUTO_DATA_DIR` or Ajustes |
| WhatsApp Business APKs | `..\whatsapp-pods\apk` | env `AGENTAUTO_APK_DIR` or Ajustes |
| Pod number map | `..\whatsapp-pods\pods-wsp.json` | env `AGENTAUTO_PODS_WSP_FILE` or Ajustes |
| App settings | Tauri app config dir (`%APPDATA%\com.agentautox1.app\settings.json`) | Ajustes |

WhatsApp (Signal) sessions are never copied: two copies of a session diverge and break. The app passes
the paths to the engines through those environment variables. Note that `pods.ps1 wsp ...` writes to the
configured `pods-wsp.json` (the original file by default), same as the original tool.

## Develop

Requirements: Node 20+, Rust + cargo, Visual Studio 2022 Build Tools, WebView2.

```bash
# engines
cd engines/warmup && npm install && npm test                    # node --test
cd engines/pods   && powershell -NoProfile -Command "Invoke-Pester .\tests"   # Pester 3+

# app
cd app && npm install
npm run tauri dev          # desktop window with hot reload
npm run build              # frontend only (tsc + vite)
cd src-tauri && cargo test # Rust unit tests (incl. Ctrl+Break / taskkill checks with a dummy Node child)
```

## Build the .exe

```bash
cd app
npm run tauri build -- --debug     # fast debug build
npm run tauri build                # release: app/src-tauri/target/release/agentAutoX1.exe (+ installers)
```

The executable finds the engines by walking up from its own location looking for `engines/warmup`,
so keep it inside the project folder (or adjust the paths in Ajustes).

## Pods listing

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File engines/pods/pods.ps1 listar-json
# [{ "name", "instanceId", "state": "running|stopped", "serial", "adbPort", "phone" }]
```

## Stopping a profile

Stop sends Ctrl+Break to the profile's hidden console (the engine closes its Baileys sessions on SIGBREAK),
then `taskkill /PID <pid> /T`, and only then `taskkill /PID <pid> /T /F`. Closing the window also stops a running profile.

## Phase 1 limits

- The embedded BlueStacks view is a placeholder ("Vista embebida (próximamente)").
- Creating, renaming or deleting pods, and creating profiles, are still done from the original tools.
- Unlinked testers print a QR as terminal text in the log panel; linking is easier from the original CLI.
