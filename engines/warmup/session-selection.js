// Which tester numbers to start: quick count mode (--count N) and named warm-up profiles.
// Pure helpers (file access is injected or limited to profiles.json), so they are unit-tested.
// Messages the user reads in the terminal are in neutral Spanish (tuteo).
import fs from 'node:fs';
import path from 'node:path';

export const PROFILE_COMMANDS = ['crear', 'usar', 'lista', 'borrar', 'grupo'];
const RESERVED_NAMES = [...PROFILE_COMMANDS, 'ayuda'];

// Input errors the user can fix; entry points print only the message, without a stack trace.
export class SelectionError extends Error {
  name = 'SelectionError';
}

const quoteList = (items) => items.join(', ');

export function testerIds(testers) {
  return (Array.isArray(testers) ? testers : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
    .filter((id) => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim());
}

// Strict integer in 1..max; anything else is a clear error instead of a silent default.
export function parseCount(value, max) {
  const text = String(value ?? '').trim();
  const count = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(count) || count < 1 || count > max) {
    throw new SelectionError(
      `El número de WhatsApps debe ser un entero entre 1 y ${max}; recibimos "${text}".`,
    );
  }
  return count;
}

// First N entries in config order (tester1..N).
export const pickFirst = (testers, count) => testers.slice(0, count);

// Configured tester entries for the given ids, in the requested order.
export function selectTesters(testers, ids) {
  if (!ids.length) throw new SelectionError('Elige al menos un tester.');

  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) {
    throw new SelectionError(`Hay testers repetidos: ${quoteList([...new Set(duplicates)])}.`);
  }

  const available = testerIds(testers);
  const unknown = ids.filter((id) => !available.includes(id));
  if (unknown.length) {
    throw new SelectionError(
      `Estos testers no existen en config.json: ${quoteList(unknown)}. ` +
        `Disponibles: ${quoteList(available)}.`,
    );
  }

  return ids.map((id) => testers.find((entry) => (typeof entry === 'string' ? entry : entry?.id) === id));
}

// Value of a flag given as "--name value", "--name=value" or a short alias; null when absent.
function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) {
        const next = args[i + 1];
        return next === undefined || next.startsWith('-') ? '' : next;
      }
      if (name.startsWith('--') && args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
  return null;
}

// run.js / tester.js: "--count 3" or "-n 3" starts only the first 3 testers.
// "--group \"name\"" picks the WhatsApp group for this run (default: config.groupName).
export const parseRunArgs = (argv) => ({
  count: flagValue(argv, ['--count', '-n']),
  group: flagValue(argv, ['--group']),
});

// perfil.js: perfil -- crear "prueba 1" [--count 3 | --testers a,b] [--group "Nombre"] [--force]
//            perfil -- grupo "prueba 1" "Nombre del grupo"
export function parsePerfilArgs(argv) {
  const valueFlags = ['--count', '-n', '--testers', '--group'];
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valueFlags.includes(arg)) {
      i++;
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }

  const testers = flagValue(argv, ['--testers']);
  const groupFlag = flagValue(argv, ['--group']);
  const options = {
    count: flagValue(argv, ['--count', '-n']),
    testers: testers === null ? null : testers.split(',').map((id) => id.trim()).filter(Boolean),
    force: argv.includes('--force') || argv.includes('-f'),
  };

  if (!positionals.length) return { command: 'ayuda', name: '', group: groupFlag, ...options };
  if (PROFILE_COMMANDS.includes(positionals[0])) {
    const group = positionals[0] === 'grupo' ? (positionals[2] ?? groupFlag) : groupFlag;
    return { command: positionals[0], name: positionals[1] ?? '', group, ...options };
  }
  return { command: 'usar', name: positionals[0], group: groupFlag, ...options };
}

export function splitByCreds(ids, hasCreds) {
  return {
    linked: ids.filter((id) => hasCreds(id)),
    pending: ids.filter((id) => !hasCreds(id)),
  };
}

// A session counts as linked when Baileys saved credentials that include the paired account.
export function hasSavedSession(authRoot, id, readFile = fs.readFileSync) {
  try {
    const creds = JSON.parse(readFile(path.join(authRoot, id, 'creds.json'), 'utf8'));
    return Boolean(creds?.me?.id);
  } catch {
    return false;
  }
}

export function describeSelection(ids, hasCreds) {
  const { linked, pending } = splitByCreds(ids, hasCreds);
  const lines = [`Se usarán ${ids.length} número(s) de WhatsApp, en este orden: ${quoteList(ids)}.`];
  if (linked.length) lines.push(`Ya vinculados (se reutilizan sin QR): ${quoteList(linked)}.`);
  lines.push(
    pending.length
      ? `Falta escanear el QR de: ${quoteList(pending)}.`
      : 'Todos están vinculados: no hace falta escanear ningún QR.',
  );
  return lines;
}

const cleanName = (name) => String(name ?? '').trim();

export function addProfile(profiles, name, ids, { force = false, now = new Date(), groupName = '' } = {}) {
  const key = cleanName(name);
  if (!key) throw new SelectionError('Indica el nombre del perfil.');
  if (RESERVED_NAMES.includes(key.toLowerCase())) {
    throw new SelectionError(`"${key}" es un nombre reservado; elige otro nombre para el perfil.`);
  }
  if (profiles[key] && !force) {
    throw new SelectionError(`El perfil "${key}" ya existe. Usa --force para sobrescribirlo.`);
  }
  const group = cleanName(groupName);
  return {
    ...profiles,
    [key]: { testers: [...ids], createdAt: now.toISOString(), ...(group ? { groupName: group } : {}) },
  };
}

function missingProfile(profiles, key) {
  const names = Object.keys(profiles);
  return new SelectionError(
    names.length
      ? `No existe el perfil "${key}". Perfiles disponibles: ${quoteList(names)}.`
      : `No tienes perfiles guardados. Crea uno con: npm run perfil -- crear "${key}"`,
  );
}

// Tester entries of a profile, validated against the current config.json.
export function resolveProfile(profiles, name, testers) {
  const key = cleanName(name);
  const profile = profiles[key];
  if (!profile) throw missingProfile(profiles, key);

  try {
    return selectTesters(testers, profile.testers ?? []);
  } catch (error) {
    throw new SelectionError(`El perfil "${key}" no es válido: ${error.message}`);
  }
}

export function removeProfile(profiles, name) {
  const key = cleanName(name);
  if (!profiles[key]) throw missingProfile(profiles, key);
  const { [key]: _removed, ...rest } = profiles;
  return rest;
}

// WhatsApp group of a profile; profiles created before groups existed use config.groupName.
export function profileGroupName(profile, config) {
  return cleanName(profile?.groupName) || cleanName(config?.groupName);
}

export function setProfileGroup(profiles, name, groupName) {
  const key = cleanName(name);
  if (!profiles[key]) throw missingProfile(profiles, key);
  const group = cleanName(groupName);
  if (!group) {
    throw new SelectionError(`Indica el nombre del grupo: npm run perfil -- grupo "${key}" "Nombre del grupo"`);
  }
  return { ...profiles, [key]: { ...profiles[key], groupName: group } };
}

export function describeProfileList(profiles, hasCreds) {
  const names = Object.keys(profiles);
  if (!names.length) {
    return ['No tienes perfiles guardados. Crea uno con: npm run perfil -- crear "nombre"'];
  }

  const lines = [];
  for (const name of names) {
    const { testers = [], createdAt, groupName } = profiles[name];
    lines.push(`${name} (${testers.length} número(s)${createdAt ? `, creado ${createdAt.slice(0, 10)}` : ''})`);
    if (groupName) lines.push(`  grupo: ${groupName}`);
    for (const id of testers) {
      lines.push(`  - ${id}: ${hasCreds(id) ? 'ya vinculado' : 'pendiente de QR'}`);
    }
  }
  return lines;
}

export function loadProfiles(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }

  try {
    const profiles = JSON.parse(text);
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) throw new SelectionError('not an object');
    return profiles;
  } catch (error) {
    throw new SelectionError(`No se pudo leer ${path.basename(file)}: ${error.message}. Corrígelo o bórralo.`);
  }
}

export function saveProfiles(file, profiles) {
  fs.writeFileSync(file, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
}

// ask(question) -> Promise<string>; print(line) reports invalid answers before asking again.
export async function askForCount(ask, max, print = console.log) {
  for (;;) {
    const answer = await ask(`¿Cuántos números de WhatsApp? (1-${max}): `);
    try {
      return parseCount(answer, max);
    } catch (error) {
      print(error.message);
    }
  }
}
