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
npm run tauri build                # release: app/src-tauri/target/release/app.exe (+ installers)
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

## Phase 2: manage pods and warm-up instances from the app

- **MultiWhatsApp**: Nuevo pod (runs `pods.ps1 nuevo <name> -NoInteractivo`, 9 steps, about 12-15 minutes, shown as a step list with a
  progress bar; BlueStacks may be closed and reopened), Editar (rename + phone) and Borrar (typed-name confirmation).
  `-NoInteractivo` makes the script fail with a message instead of waiting for the keyboard or for manual steps.
  All PowerShell output is UTF-8.
- **Numeros**: one row per normalised phone (57XXXXXXXXXX and XXXXXXXXXX are the same line) with pod, tester, linked session, profiles
  and groups. Source: `pod`, `pod sin calentar` (pod number with no tester) or `externo` (tester with no pod).
- **Calentador Bots**: Nueva instancia wizard, Editar and Eliminar. The rules live in the engine
  (`engines/warmup/perfil-api.js`, a JSON CLI: `node perfil-api.js <list|registry|create|update|delete|set-group> --stdin`), so the app
  and the engine never diverge. Deleting a profile never deletes testers or sessions. The running profile cannot be edited.

Safety: JSON writes are atomic (temp file + rename) and the previous `config.json`, `profiles.json` and `pods-wsp.json` are copied to
`backups/` (next to each file) with a timestamp before every write.

## Phase 3: link pods, line health, keep-alive and embedded view

### Auto-link pods (Calentador Bots > Iniciar)

When you press **Iniciar**, testers whose phone belongs to a pod and have no saved session are linked first, one pod at a time:

1. power the pod on (`pods.ps1 prender`) if it is off;
2. `pod-driver-cli.js ready`: adb online, Android booted, `com.whatsapp.w4b` in the foreground (it launches it if needed);
3. `link-session-cli.js --tester <id>` starts a Baileys client for that phone and prints the 8-character pairing code as JSON lines;
4. `pod-driver-cli.js link` drives WhatsApp Business through `uiautomator dump` + `input tap/text`:
   Menu (3 dots) > Dispositivos vinculados > Vincular un dispositivo > Vincular con el número de teléfono > type the code;
5. wait until `creds.json` holds the paired account, then power the pod off again if it was off before.

### Linking is always by pairing code

The warm-up engine never prints a QR. When a session is not linked (never linked, or WhatsApp logged it out), `startClient` resolves the
phone in this order: `config.json` tester `phone` > phone in the current session creds > newest `.baileys_auth/_logged_out/<id>-*` or
`_unlinked/<id>-*` backup (only `me.id` is read) > `LINK_PHONES` (JSON map `{"tester1":"3162135114"}`, for phones the app knows).
The 8-character code is printed as `[id] Pairing code: XXXX-XXXX`; when it expires a new one is requested (max 5 per session and run).
A phone found in a session/backup is saved to `config.json` (timestamped backup in `backups/`, atomic write, done by the engine process itself).
With no phone anywhere the tester is skipped with `[id] needs a phone number to link by code: set it in the app (Editar instancia / Números)`.
Emergency escape hatch: `LINK_MODE=qr` restores the old terminal QR.

Pods whose number is already linked are not touched and do not need to be on. Progress is shown per number; when a screen cannot be
driven the dialog shows the code big, says which screen to finish by hand, and keeps the pod on while it waits.
The dialog has **Solo simular** (dry-run): it never powers anything, never opens a WhatsApp session and only reads the screen of pods
that are already on.

The UI-driving code is separate and tested without a device: `engines/warmup/pod-ui.js` (selector map in Spanish, English and
Portuguese, screen recognition), `pod-driver.js` (the loop and the adb wrapper) and XML fixtures in `engines/warmup/fixtures/uia/`.
If WhatsApp changes a label, edit `SELECTORS` in `pod-ui.js` and add a fixture. Offline check of a real dump:

```bash
adb -s emulator-5564 shell uiautomator dump /sdcard/x.xml && adb -s emulator-5564 shell cat /sdcard/x.xml > dump.xml
node engines/warmup/pod-driver-cli.js link --fixture dump.xml --code ABCD-1234 --dry-run
```

BlueStacks gotchas respected: never `adb reboot`; HD-Adb may print results on stderr; serials are `emulator-<port-1>`.
The fixtures are modelled on the WhatsApp Business screens, not captured from a pod: validate with a real pod before relying on it.

### Line health and strength

`node perfil-api.js line-health` (also `line_health` in the app) returns, per tester, a traffic light and a 0-100 score computed in
`engines/warmup/line-health.js` from `results/events.jsonl`, `results/activity-<id>.jsonl`, `results/run-*.csv` and `creds.json`.
The window is 14 days. Not linked = 0 and red. Otherwise the score is the sum of:

| Part | Max | Rule |
| --- | --- | --- |
| Antigüedad | 35 | days since first activity (first `ready`, first CSV row or first sent message), `min(days, 14) / 14` |
| Volumen | 20 | messages sent + received in the window, `min(n, 60) / 60` |
| Respuestas recibidas | 15 | `min(received / sent, 1)`; 0 when nothing was sent |
| Estabilidad | 20 | `20 - min(12, 4 x disconnects) - 10 x relinks - 10 x auth failures`, never below 0 |
| Actividad reciente | 10 | last activity <= 24 h: 10, <= 72 h: 6, <= 7 days: 3, older or never: 0 |

Light: green from 70, yellow from 40, red below. A logout (`logged_out_relink`) or `auth_failure` in the last 72 h forces red.
These are community heuristics, not official WhatsApp numbers. Hover a badge in Números or on a profile card for the breakdown.

### Phone of each linked session

When a tester has no `phone` in `config.json`, the registry reads it from its session (`.baileys_auth/<id>/creds.json`, only the digits of `me.id`) and shows it as the effective phone. `config.json` is never written for this. If the configured phone and the session phone differ, the tester is flagged as a mismatch. Two or more testers (or a tester and the bot) with the same number are reported in `registry.duplicates` and shown with an amber warning in Calentador Bots and Números.

### Auto revisión de números en los pods (keep-alive)

MultiWhatsApp header switch (Sí/No, OFF by default, saved in the app settings). When ON, a Rust scheduler records the last time
each pod was seen running (`pods-last-on.json` in the app config folder, updated whenever the pod list is read and when the app
turns a pod on) and, every 30 minutes, builds a queue of **stopped pods with a phone number** that have been off for more than 24 h
(a pod the app has never seen on counts as the oldest). It processes ONE pod at a time: power on, keep it on 15 minutes, power off,
then wait until the pod reads as stopped and free memory is back within 400 MB of the level measured before it started (120 s
timeout, never fatal). It never runs a pod when another pod operation is active (it takes the same job slot as create / rename /
delete / phone / link), and a pod that is already on when its turn comes is only recorded and skipped. Turning the switch off, or
closing the app, powers the pod off right away. Status ("Revisando wa-pod2: 7 min restantes", queue, last run) is shown in MultiWhatsApp.
The pure queue and timing logic is unit-tested with a fake clock (`app/src-tauri/src/keepalive.rs`).

### Embedded BlueStacks view (experimental)

MultiWhatsApp > Vista embebida, behind its own Sí/No flag (OFF by default). Each running pod gets a tab; the active tab shows its
BlueStacks window (`HD-Player.exe`, title `wa-<pod>`) as a child of the app window (Win32 `SetParent`, caption and borders stripped,
resized with the layout). Other tabs are hidden with `ShowWindow(SW_HIDE)`; dialogs hide the view too (a native window is always
drawn on top of the web content). Closing a tab, the **Abrir en ventana aparte** button, turning the flag off or closing the app
restores the original parent, style and position. Windows only. The re-parenting code is tested with dummy windows, not with BlueStacks.

