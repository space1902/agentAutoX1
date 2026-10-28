// CLI used by the desktop app: node link-session-cli.js --tester <id> [--dry-run]
// Prints one JSON object per line: {"event":"code","code":"ABCD-1234"}, {"event":"linked"}, {"event":"already-linked"},
// {"event":"error","code","message"}, and always ends with {"event":"exit","status"}.
// --dry-run only reports the phone and whether the tester is already linked: it never opens a WhatsApp session.
import { AUTH_DIR, RESULTS_DIR, loadConfig } from './lib.js';
import { linkSession } from './link-session.js';
import { hasSavedSession } from './session-selection.js';
import { WaClient } from './wa-client.js';
import { resolveSessionPhone } from './wa-messages.js';

const print = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

async function main() {
  const id = argValue('--tester');
  if (!id) return { status: 'error', code: 'BAD_ARGS', message: 'Falta --tester <id>.' };

  let phone;
  try {
    phone = resolveSessionPhone(loadConfig(), id);
  } catch (error) {
    return { status: 'error', code: 'NO_CONFIG', message: error.message };
  }
  const hasSession = (sessionId) => hasSavedSession(AUTH_DIR, sessionId);

  if (process.argv.includes('--dry-run')) {
    print({ event: 'dry-run', tester: id, phone, linked: hasSession(id) });
    return { status: 'dry-run' };
  }

  return linkSession({
    id,
    phone,
    authRoot: AUTH_DIR,
    resultsDir: RESULTS_DIR,
    hasSession,
    clientFactory: (options) => new WaClient(options),
    emit: print,
  });
}

for (const signal of ['SIGINT', 'SIGBREAK', 'SIGTERM']) {
  process.on(signal, () => {
    print({ event: 'exit', status: 'aborted' });
    process.exit(1);
  });
}

const result = await main();
if (result.status === 'error') print({ event: 'error', code: result.code, message: result.message });
print({ event: 'exit', status: result.status });
// The Baileys sockets and timers are gone by now; do not wait for stray handles.
process.exit(result.status === 'error' ? 1 : 0);
