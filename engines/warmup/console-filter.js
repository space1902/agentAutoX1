// libsignal (inside Baileys) prints its session rotation with console.log/info, dumping key
// material to the terminal ("Closing session: SessionEntry {...}"). It is normal Signal behaviour,
// not an error, so these calls are dropped; everything else passes through untouched.
const SILENCED_PREFIXES = [
  'Closing session:',
  'Opening session:',
  'Removing old closed session:',
  'Closing open session in favor of incoming prekey bundle',
  'Migrating session to:',
  'Session already closed',
  'Session already open',
  'Decrypted message with closed session',
];

const FILTERED_METHODS = ['log', 'info', 'warn'];
const INSTALLED = Symbol.for('whatsapp-bot-tester.console-filter');

export function shouldSilence(args) {
  const first = args?.[0];
  return typeof first === 'string' && SILENCED_PREFIXES.some((prefix) => first.startsWith(prefix));
}

export function installConsoleFilter(target = console) {
  if (target[INSTALLED]) return;
  Object.defineProperty(target, INSTALLED, { value: true, enumerable: false });

  for (const method of FILTERED_METHODS) {
    const original = target[method]?.bind(target);
    if (!original) continue;
    target[method] = (...args) => {
      if (!shouldSilence(args)) original(...args);
    };
  }
}
