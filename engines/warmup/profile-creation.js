// Logic behind "perfil crear": pick tester ids not used by other profiles, collect a WhatsApp
// number for every unlinked one, and build the updated config.json / profiles.json contents.
// Pure functions plus an injected ask()/print(), so it is unit-tested without a terminal.
// Messages the user reads are in neutral Spanish (tuteo).
import fs from 'node:fs';

import { SelectionError, addProfile, askForCount, parseCount, testerIds } from './session-selection.js';

export const MAX_NUMBERS = 50;

// Varied everyday Colombian personas for testers that have none in config.testerPersonas.
export const PERSONA_POOL = [
  'Eres una persona de unos 35 años que trabaja como contadora en una empresa mediana. Hablas de cierres de mes, del almuerzo en la oficina, del tráfico y de planes para el puente festivo. Escribes mensajes cortos y ordenados.',
  'Eres un estudiante de ingeniería de unos 21 años que vive con su familia. Hablas de parciales, de videojuegos, de fútbol y de lo caro que está todo. Escribes rápido, con abreviaturas y algún emoji.',
  'Eres una persona de unos 50 años con una tienda de barrio. Comentas cómo va el negocio, los precios de la plaza, el clima y los chismes del vecindario. Eres amable y hablas con refranes de vez en cuando.',
  'Eres una mamá joven de unos 28 años con un bebé. Hablas de pañales, de noches sin dormir, de recetas rápidas y de los consejos que te dan las abuelas. Escribes cuando el bebé duerme, por eso a veces tardas.',
  'Eres un conductor de plataformas de transporte de unos 40 años. Cuentas anécdotas de los pasajeros, comentas el estado de las vías, el precio de la gasolina y el partido del fin de semana. Eres bromista.',
  'Eres una enfermera de unos 33 años que hace turnos de noche. Hablas de cansancio, de café, de series para ver de madrugada y de lo que desayunas al salir del turno. Tienes buen humor y poca paciencia con la gente que se queja de todo.',
  'Eres una persona jubilada de unos 65 años que camina cada mañana por el parque. Hablas de tus plantas, de la salud, de tus hijos que viven lejos y de las novelas. A veces escribes con errores de tecleo y mandas saludos largos.',
  'Eres un vendedor de unos 26 años al que le encanta la música y salir a bailar. Hablas de conciertos, de planes con amigos, de cómo estuvo la rumba y de lo difícil que es madrugar al día siguiente.',
  'Eres una diseñadora gráfica freelance de unos 31 años que trabaja desde casa. Hablas de clientes difíciles, de plazos, de café, de tu gato y de ejercicios de estiramiento. Haces preguntas curiosas y comentas lo que dijeron los demás.',
  'Eres un profesor de colegio de unos 42 años. Hablas de tareas, de reuniones de padres, de lo que cocinas los domingos y de tu equipo de fútbol. Explicas las cosas con paciencia y haces chistes suaves.',
  'Eres una persona de unos 38 años que acaba de mudarse a otra ciudad por trabajo. Preguntas por lugares para comer, por el transporte y por el clima. Extrañas la comida de tu tierra y se la cuentas a todos.',
  'Eres un deportista aficionado de unos 29 años que corre y va al gimnasio. Hablas de rutinas, de desayunos saludables, de carreras populares y de lo difícil que es levantarse temprano. Animas a los demás a moverse.',
  'Eres una abuela de unos 70 años muy cariñosa que está aprendiendo a usar WhatsApp. Hablas de tus nietos, de recetas de toda la vida y de la novela de la noche. Escribes con calma y usas muchos saludos y bendiciones.',
  'Eres una persona de unos 45 años que vende comida por encargo los fines de semana. Hablas de pedidos, de precios de los ingredientes, de recetas que probaste y de clientes que no pagan a tiempo.',
];

const PHONE_MIN = 11;
const PHONE_MAX = 15;

// "300 123 4567" -> "573001234567". Returns null when the digits are not a plausible number.
export function normalizePhone(input) {
  let digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) digits = `57${digits}`;
  return digits.length >= PHONE_MIN && digits.length <= PHONE_MAX ? digits : null;
}

// Spanish message when the number cannot be used, or null when it is fine.
export function phoneProblem(phone, { taken = new Set(), botNumbers = [] } = {}) {
  if (botNumbers.includes(phone)) return 'Ese es el número del bot; usa uno distinto.';
  if (taken.has(phone)) return 'Ese número ya está asignado a otro tester; usa uno distinto.';
  return null;
}

const idNumber = (id) => {
  const match = /^tester(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
};

// Free ids come from config order; if there are not enough, new ones continue the numbering.
export function chooseIds(configTesters, profiles, count, { replacing = null } = {}) {
  const known = testerIds(configTesters);
  const used = new Set();
  for (const [name, profile] of Object.entries(profiles ?? {})) {
    if (name === replacing) continue;
    for (const id of profile?.testers ?? []) used.add(id);
  }

  const ids = known.filter((id) => !used.has(id)).slice(0, count);

  const everyId = [...known, ...Object.values(profiles ?? {}).flatMap((profile) => profile?.testers ?? [])];
  let next = Math.max(0, ...everyId.map(idNumber)) + 1;
  const created = [];
  while (ids.length < count) {
    const id = `tester${next++}`;
    ids.push(id);
    created.push(id);
  }
  return { ids, created };
}

function personaFor(id, taken) {
  const start = idNumber(id) % PERSONA_POOL.length;
  for (let i = 0; i < PERSONA_POOL.length; i++) {
    const text = PERSONA_POOL[(start + i) % PERSONA_POOL.length];
    if (!taken.has(text)) return text;
  }
  return PERSONA_POOL[start];
}

// New config with phones stored as { id, phone, ...rest }, new testers appended and personas filled in.
export function buildUpdatedConfig(config, { ids, created = [], phones = {} }) {
  const testers = [...(config.testers ?? [])];
  const indexOf = (id) => testers.findIndex((entry) => (typeof entry === 'string' ? entry : entry?.id) === id);

  for (const id of created) if (indexOf(id) === -1) testers.push(id);

  for (const [id, phone] of Object.entries(phones)) {
    const index = indexOf(id);
    const entry = testers[index];
    testers[index] = typeof entry === 'object' && entry ? { ...entry, id, phone } : { id, phone };
  }

  const testerPersonas = { ...config.testerPersonas };
  const taken = new Set(Object.values(testerPersonas));
  for (const id of ids) {
    if (typeof testerPersonas[id] === 'string') continue;
    testerPersonas[id] = personaFor(id, taken);
    taken.add(testerPersonas[id]);
  }

  return { ...config, testers, testerPersonas };
}

const YES = /^(s|si|sí|y|yes)$/i;

function phoneContext(config, ownId, chosen) {
  const taken = new Set(chosen);
  for (const entry of config.testers ?? []) {
    if (typeof entry !== 'object' || !entry || entry.id === ownId) continue;
    const phone = normalizePhone(entry.phone);
    if (phone) taken.add(phone);
  }
  const botNumbers = [config.botNumber, config.bot?.phone]
    .map((value) => normalizePhone(value) ?? String(value ?? '').replace(/\D/g, ''))
    .filter(Boolean);
  return { taken, botNumbers };
}

// Group for this profile: the --group value, or asked (Enter = config.groupName when it exists).
async function resolveGroupName({ ask, config, preset }) {
  const given = String(preset ?? '').trim();
  if (given) return given;

  const fallback = String(config.groupName ?? '').trim();
  const question = fallback
    ? `Nombre del grupo de WhatsApp para este perfil (Enter = "${fallback}"): `
    : 'Nombre del grupo de WhatsApp para este perfil: ';
  for (;;) {
    const answer = String(await ask(question)).trim();
    if (answer) return answer;
    if (fallback) return fallback;
  }
}

// Returns null when the user declines to replace an existing profile; otherwise everything the
// caller must persist: { ids, created, phones, unlinked, config, profiles }.
export async function collectProfile({
  ask,
  print = console.log,
  config,
  profiles,
  name,
  count = null,
  force = false,
  group = null,
  hasSession,
}) {
  const key = String(name ?? '').trim();
  if (!key) throw new SelectionError('Indica el nombre del perfil.');

  const exists = Boolean(profiles[key]);
  if (exists && !force) {
    const answer = await ask(`El perfil "${key}" ya existe, ¿reemplazarlo? (s/n): `);
    if (!YES.test(String(answer).trim())) return null;
  }

  const total = count !== null ? parseCount(count, MAX_NUMBERS) : await askForCount(ask, MAX_NUMBERS, print);
  const { ids, created } = chooseIds(config.testers, profiles, total, { replacing: exists ? key : null });
  if (created.length) print(`Se crean ${created.length} tester(s) nuevo(s): ${created.join(', ')}.`);

  const phones = {};
  const unlinked = [];
  for (const id of ids) {
    if (hasSession(id)) {
      print(`${id} ya está vinculado, se reutiliza.`);
      continue;
    }
    unlinked.push(id);

    const current = (config.testers ?? []).find((entry) => typeof entry === 'object' && entry?.id === id);
    const existing = normalizePhone(current?.phone);
    const context = phoneContext(config, id, Object.values(phones));
    for (;;) {
      const hint = existing ? ` [Enter conserva ${existing}]` : '';
      const answer = String(await ask(`Número de WhatsApp para ${id} (ej. 3001234567)${hint}: `)).trim();
      const phone = answer === '' && existing ? existing : normalizePhone(answer);
      if (!phone) {
        print(`"${answer}" no es un número válido: escribe entre ${PHONE_MIN} y ${PHONE_MAX} dígitos (con el 57 al inicio, o 10 dígitos que empiecen por 3).`);
        continue;
      }
      const problem = phoneProblem(phone, context);
      if (problem) {
        print(problem);
        continue;
      }
      phones[id] = phone;
      break;
    }
  }

  const groupName = await resolveGroupName({ ask, config, preset: group });

  return {
    ids,
    created,
    phones,
    unlinked,
    config: buildUpdatedConfig(config, { ids, created, phones }),
    profiles: addProfile(profiles, key, ids, { force: true, groupName }),
  };
}

// Temp file + rename, so a crash never leaves a half-written config.json.
export function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
