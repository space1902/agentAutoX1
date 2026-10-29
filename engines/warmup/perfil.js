// Named warm-up profiles: which tester numbers to start, saved in profiles.json.
//   npm run perfil -- crear "prueba 1" [--count 3 | --testers tester4,tester5] [--group "Nombre"] [--force]
//     (without --testers it picks NEW numbers: free tester ids, asking the WhatsApp number of each unlinked one)
//   npm run perfil -- "prueba 1"        (or: usar "prueba 1")
//   npm run perfil -- grupo "prueba 1" "Nombre del grupo"   (changes the WhatsApp group of a profile)
//   npm run perfil -- lista
//   npm run perfil -- borrar "prueba 1"
import path from 'node:path';
import readline from 'node:readline/promises';

import { AUTH_DIR, CONFIG_FILE, PROFILES_FILE, exitCleanlyOnCtrlC, isEntryPoint, loadConfig } from './lib.js';
import { collectProfile, writeJsonAtomic } from './profile-creation.js';
import {
  SelectionError,
  addProfile,
  describeProfileList,
  hasSavedSession,
  loadProfiles,
  parsePerfilArgs,
  profileGroupName,
  removeProfile,
  resolveProfile,
  saveProfiles,
  selectTesters,
  setProfileGroup,
  testerIds,
} from './session-selection.js';


const USAGE = [
  'Perfiles de calentamiento. Uso:',
  '  npm run perfil -- crear "nombre" [--count N | --testers tester4,tester5] [--group "grupo"] [--force]',
  '  npm run perfil -- "nombre"          inicia el perfil (también: usar "nombre")',
  '  npm run perfil -- grupo "nombre" "grupo"   cambia el grupo de WhatsApp del perfil',
  '  npm run perfil -- lista             muestra los perfiles y qué números ya están vinculados',
  '  npm run perfil -- borrar "nombre"   borra el perfil (no borra las sesiones)',
];

const hasCreds = (id) => hasSavedSession(AUTH_DIR, id);


// New numbers for this profile: free tester ids, a WhatsApp number for each unlinked one,
// and the updated config.json / profiles.json written only after every question is answered.
async function createProfile(options, config, profiles) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let result;
  try {
    result = await collectProfile({
      ask: (question) => rl.question(question),
      config,
      profiles,
      name: options.name,
      count: options.count,
      force: options.force,
      group: options.group,
      hasSession: hasCreds,
    });
  } finally {
    rl.close();
  }

  if (!result) {
    console.log('No se hizo ningún cambio.');
    return;
  }

  writeJsonAtomic(CONFIG_FILE, result.config);
  saveProfiles(PROFILES_FILE, result.profiles);

  const name = options.name.trim();
  console.log(`Perfil "${name}" guardado con: ${result.ids.join(', ')}.`);
  console.log(`Grupo de WhatsApp: "${result.profiles[name].groupName}".`);
  console.log(`Para iniciarlo: npm run perfil -- "${name}"`);
  if (result.unlinked.length) {
    console.log(
      `Al iniciarlo, cada número sin vincular (${result.unlinked.join(', ')}) mostrará un código de 8 caracteres. ` +
        'Escríbelo en WhatsApp > Dispositivos vinculados > Vincular con número de teléfono.',
    );
  }
}

export async function runPerfil(argv) {
  const options = parsePerfilArgs(argv);

  if (options.command === 'ayuda') {
    for (const line of USAGE) console.log(line);
    return;
  }

  const profiles = loadProfiles(PROFILES_FILE);

  if (options.command === 'lista') {
    for (const line of describeProfileList(profiles, hasCreds)) console.log(line);
    return;
  }

  if (options.command === 'borrar') {
    saveProfiles(PROFILES_FILE, removeProfile(profiles, options.name));
    console.log(`Perfil "${options.name.trim()}" borrado. Las sesiones vinculadas no se tocaron.`);
    return;
  }

  if (options.command === 'grupo') {
    saveProfiles(PROFILES_FILE, setProfileGroup(profiles, options.name, options.group));
    console.log(`El perfil "${options.name.trim()}" ahora usa el grupo "${options.group.trim()}".`);
    return;
  }

  const config = loadConfig(['testers']);
  const { testers } = config;

  if (options.command === 'crear') {
    if (options.testers) {
      // Explicit ids: keep exactly those testers, no number questions.
      const ids = testerIds(selectTesters(testers, options.testers));
      saveProfiles(
        PROFILES_FILE,
        addProfile(profiles, options.name, ids, { force: options.force, groupName: options.group ?? '' }),
      );
      console.log(`Perfil "${options.name.trim()}" guardado con: ${ids.join(', ')}.`);
      console.log(`Para iniciarlo: npm run perfil -- "${options.name.trim()}"`);
      return;
    }
    await createProfile(options, config, profiles);
    return;
  }

  // usar: log in only the missing sessions (pairing code only for those), then run with exactly these testers.
  const ids = testerIds(resolveProfile(profiles, options.name, testers));
  const { runAll } = await import('./run.js');
  const groupName = profileGroupName(profiles[options.name.trim()], config);
  console.log(`Grupo de WhatsApp: "${groupName}".`);
  await runAll({ testerIds: ids, groupName });
}

if (isEntryPoint(import.meta.url)) {
  exitCleanlyOnCtrlC();
  try {
    await runPerfil(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof SelectionError ? error.message : error?.stack || error?.message || error);
    process.exitCode = 1;
  }
}
