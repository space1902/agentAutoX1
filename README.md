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

Light: green from 70, yellow from 40, red below. A logout (the number is paused and nothing is relinked automatically) or an `auth_failure` in the last 72 h forces red. Older runs also logged `logged_out_relink`; those events still count the same way.
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


## Phase 4: choose the AI (section "IA")

The warm-up writes its messages with a **local model** (default, unchanged: Ollama `qwen2.5:7b`) or an **external OpenAI-compatible API** with a daily spend limit. Configuration lives in `config.json` under `ai`; without that key the engine behaves exactly as before with `localModel`.

```json
"ai": { "provider": "ollama" | "openai-compatible", "preset": "openrouter", "baseUrl": "...", "model": "...",
        "dailyBudgetUsd": 1, "onBudgetExceeded": "fallback-local" | "stop", "fallbackLocalModel": "gemma3:1b",
        "localGpu": "auto" | "cpu", "prices": { "inUsd": 0.1, "outUsd": 0.1 } }
```

- **API key**: never in `config.json`, logs or files. The app stores one key per provider in the Windows Credential Manager (service `agentAutoX1`, user `ai-key:<preset>`) and injects it into the profile process as `AGENTAUTO_AI_KEY`.
- **Presets** (data-driven, `engines/warmup/ai-presets.js`, prices as of 2026-10-29): OpenRouter and Mistral (recommended, cheapest), then DeepSeek (peak/off-peak pricing: weekdays 01-04 and 06-10 UTC), OpenAI, Gemini and any OpenAI-compatible URL. Adding a provider is just a base URL, a model list and prices. Reasoning models get minimal effort (`gpt-5-nano`: `reasoning_effort: minimal`, `max_completion_tokens`; DeepSeek: `thinking: {type: disabled}`; Gemini: `reasoning_effort: none`).
- **Spend control**: tokens come from the API `usage` (fallback chars/4); per-day totals per provider/model in `<data>/ai-usage.json` (atomic writes). At `dailyBudgetUsd` the engine either switches to the local fallback model or stops the run (same clean path as Ctrl+C).
- **Local models**: the section lists installed Ollama models (size, parameters, quantization, fit for your GPU), deletes them (blocked while a running profile uses them), downloads recommended or any valid tag with progress and cancel, detects LM Studio / llama.cpp / Jan / LocalAI / vLLM and installs Ollama (winget first, direct installer as fallback, after confirmation).
- **GPU policy**: dedicated card detected (`nvidia-smi` + WMI) -> Ollama default (GPU). Otherwise the UI saves `localGpu: "cpu"` and the engine sends `options.num_gpu = 0`.
- **Live usage**: `/api/ps` (share on GPU vs CPU), VRAM from `nvidia-smi`, system RAM; "Probar" runs 5 sample messages and reports latency, tokens and estimated cost at 4,000 messages/day.

Engine CLI: `node ai-cli.js <presets|config-get|config-save|ai-usage|ai-test|local-detect|local-resources|local-delete|local-pull> --stdin`.

## Anuncios (ads) section

Meta spend (live, Marketing API v26.0) joined with valid payments from the "Comprobantes" Google Sheet.

- Engine: `engines/ads/` (Node >= 22.13, `node:sqlite`, tests with `npm test`). `ads-cli.js` commands: `sync --from --to`, `report --from --to [--group ct|campaign|ad]`, `status`, `test-token`, `config-get`, `config-set`.
- Data: `<data dir>/ads/ads.db` (daily insights per ad, ad metadata with `first_spend_date`, budget history, payments cache) and `<data dir>/ads/config.json` (atomic write + backups in `ads/backups/`).
- "Day 1" of an ad is its first day with spend > 0, not `created_time`. The first time an older ad is seen, sync looks back to its creation date once.
- The Meta token lives only in the Windows Credential Manager (service `agentAutoX1`, entry `meta-token`) and reaches the engine through `AGENTAUTO_META_TOKEN`. Import it from the meta-ads-monitor `.env` or paste it in the section's settings.
- Join rules (ported from the Apps Script): key = `date|adId`; Resultado = Valor - Gasto, ROAS = Valor / Gasto SIN IVA (`spendNet`; the other metrics use the spend with Meta's IVA), Costo por mensaje = Gasto / Mensajes (also a column of the performance table), Ticket = Valor / Ventas, % conversión = Ventas / Mensajes, Costo por venta = Gasto / Ventas (0 when the divisor is 0).
- Suggested action: spend < 15000 Esperar; ROAS >= 3 and sales >= 3 Escalar y duplicar; >= 2 Escalar; >= 1.3 Mantener; >= 1 Vigilar; otherwise Apagar (all configurable).

- Search ("Buscar"): comma-separated terms, OR-ed, matched anywhere (contains, case and accent insensitive) in the ad, ad set or campaign name. The localStorage key (`ads.nameFilter`) is unchanged.
- Corrected payment amount: `comprobante-value --key K --valor N` (1 to 100,000,000; no value removes it) stores the amount in `comprobante_value_overrides`, apart from the synced rows. Report, `v_sales` and decisions use it; the vouchers list shows "Monto corregido (hoja: $X)". The sheet is never written.
- Hour window: `report --hours 8-14` (start inclusive, end exclusive, `22-6` wraps midnight, `0-24` = whole day) counts only the sales whose registration hour (sheet text, America/Bogota) is inside, and the spend Meta delivered inside it (hourly spend, last 7 days, one extra request per account per sync; days without hourly rows fall back to whole-day spend with a note). Messages are not split by hour, so messages, cost per message and conversion are N/D (null) under a window. The report also returns `hourly` (24 buckets of sales and value for the same scope, whatever the window) for the "Ventas por hora" chart.

### Decisiones (daily decisions)

- Day counting is in the ad account timezone; day 1 of an ad is its first day with spend. On day `testNotifyDay` (4) at `testNotifyAt` (20:00) every ad and CT gets a verdict from the configured thresholds (days 1..4). When a daily budget goes up (ad set, or campaign for CBO), the day of the change is day 1 and on day `postBudgetNotifyDay` (2) at 20:00 the days since the raise are compared with the `windowDays` (3) before it: "Subir más", "Mantener y esperar" or "Bajar presupuesto". The app never changes budgets or pauses ads; "Hecho" and "Ignorar" only mark the card.
- Scheduler: a plain thread inside the app process (`ads::spawn_scheduler`) calls the one-shot `ads-cli.js tick` every 5 minutes. The engine decides what is due, dedupes each decision by key in SQLite (`decisions.key`), takes a budget snapshot at most every 30 minutes and only syncs when something is due. If the app was closed at 20:00, the decision is issued on the next start up to `lateDays` later and marked "atrasada". A Windows toast (hidden PowerShell, `notify.rs`) and an in-app banner announce new decisions; with `notifyWhatsapp` the text is queued in `wa_outbox` and sent by the alerts monitor when it is connected.
- Budget changes are exact when Meta's `/activities` log exposes `update_ad_set_budget` / `update_campaign_budget`; otherwise they are detected by comparing budget snapshots and dated at the next reading (best effort).

### Presupuestos (budget timeline and suggested next budget)

- Tab next to Resumen / Decisiones / Alertas. `budget-plan --from --to [--accounts --country --name]` (engine `budget-plan.js`, pure, reads only stored data: no Meta request, nothing is ever changed in Meta). Same account / country / search filters as the report; the search only selects campaigns (a term may match the ad, ad set or campaign name) and the metrics shown are the whole campaign's. The range limits the timeline rows; the learning and "last change" always use the full history.
- Per campaign: current budget (latest of the last snapshot and the last logged change), days since the last change (campaign or one of its ad sets) and one row per budget change (raises and cuts, newest first): date, from -> to, % change, days since, result and spend (with IVA), sales, ROAS (without IVA), cost per sale and conversion as "before -> after".
- Windows reuse `lifecycle`: after = `postBudgetDays` (3) starting ON the day of the change (day 1), before = the `windowDays` (3) days before it. Result: "en evaluación (día N de 3)", "funcionó" (ROAS >= `minRoasToScale`, sales >= `minSales`, cost per sale not worse than `maxCpaWorsenPct`), "empeoró" (ROAS < `keepRoas` with spend >= `minSpend`, or cost per sale worse than `lowerCpaWorsenPct` with enough sales), "BAJÓ" (cut), "mezclado con otro cambio", "sin datos".
- Measured raise = complete window, spend after it, and no other budget change (campaign or its ad sets) inside the after window; earlier changes do not matter (raising every 3 days is the normal ladder). Same-day changes of an entity are merged into the net change. Snapshot amounts are divided by the account's minor unit (zero-decimal currencies such as COP are not).
- Suggestion (active campaigns only): wait until 3 days passed since the last change ("Esperar (día N de 3)"); then on the last 3 complete days: back to the previous budget ("Bajar a $X", only when the last change was a raise) if ROAS < `keepRoas` (spend >= `minSpend`) or cost per sale worsened more than `lowerCpaWorsenPct`; +`raisePct` (capped by `maxRaisePct`) if ROAS >= `minRoasToScale`, sales >= `minSales` and cost per sale did not worsen more than `maxCpaWorsenPct` (after a cut the cost per sale is not compared and a cut is never reverted); otherwise "Mantener". Amounts are rounded to the nearest 1,000 (COP-like; 10 MXN; 1 otherwise; finer when the budget has fewer than 5 steps) and always move at least one unit.
- Learning: fewer than 8 measured raises (account scope) = "Aprendiendo (N de 8 subidas medidas): sugerencia estándar +20 % cada 3 días". With >= 8 the raise SIZE comes from the bucket (<=15 %, 16-25 %, >25 %) with the best share of raises that kept ROAS >= `minRoasToScale` (ranked by the Wilson lower bound of the success rate, ties -> larger sample, then smaller raise; a bucket needs >= 3 cases), using the median size of that bucket, still capped by `maxRaisePct`; the when/whether gates above are unchanged.
- Also: `comprobante-ad` is now in the app allowlist (`ads.rs`) with Tauri command `ads_comprobante_ad`.

### Alertas (alerts monitor inside the app)

- `engines/ads/monitor/` is a copy of meta-ads-monitor (rules, baseline, messages, commands, poll loop, store) plus: sales from the payments sheet (`salesSource`: `sheet` | `meta` | `both`), alert-only mode by default (`allowActions` off keeps the Meta connection read-only and never offers pause/budget requests), editable thresholds in `ads/alerts-config.json`, and a WhatsApp client that links only by pairing code.
- `monitor-cli.js run` (long-lived) and `monitor-cli.js link --phone N` are spawned by `alerts.rs`. Stop = Ctrl+Break so the WhatsApp session closes cleanly, then `taskkill` of that pid only. The monitor is OFF by default and asks for confirmation when the standalone monitor's `data/monitor.log` changed in the last 20 minutes; the app never stops the standalone monitor.
- The WhatsApp session lives in `<data dir>/ads/.baileys_auth/alerts`. "Importar sesión" copies (never moves) the standalone one; one session must not be used by two processes at once.

### History, countries and follow-up

- The SQLite database (`<data dir>/ads/ads.db`) is the full history. `sync --auto` (the "Actualizar" button and the auto-refresh) backfills from "Historial desde" (default: the earliest day found in the sheet or in Meta, month by month) the first time and afterwards only re-syncs the last 3 days plus today. Payments are keyed by when they arrived plus who paid; rows that disappear from the sheet are flagged ("fuera de la hoja") and kept.
- Meta insights come with `breakdowns=country`; sales get their country from the customer's phone prefix, then the ad's campaign words (`countryWords`), then the flow name, and a manual override per payment is stored apart. Per-country currency, exchange rate to COP, fee %, cost per sale and tax % live in Configuración; the report shows gross margin = value - spend - fees - costs - taxes.
- Budget history is backfilled from the account `/activities` log (`update_campaign_budget`, extra_data = nested JSON strings, whole-peso amounts). "Seguimiento" shows day counters only (days since it started spending, days since a raise); verdicts remain automatic (day 4 and day 2 at 20:00, with the 2-day catch-up).
