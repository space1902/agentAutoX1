// Pure UI knowledge for driving WhatsApp Business inside a pod (BlueStacks, Android 11) through uiautomator:
// parse a `uiautomator dump`, recognise which screen we are on, and decide the next tap or text.
// No adb and no I/O here, so it is unit tested against XML fixtures (fixtures/uia/*.xml).
//
// Path to follow: Menu (3 dots) > Linked devices > Link a device > Link with phone number > type the 8-char code.
// The fixtures are modelled on those screens; if WhatsApp changes a label, only SELECTORS needs an edit.

export const WA_PACKAGES = ['com.whatsapp.w4b', 'com.whatsapp'];

// Each selector may match by visible text, content-desc, resource-id (RegExp) or a text fragment (contains).
// Labels are compared with normalizeLabel (case, accents, trailing dots and extra spaces ignored).
export const SELECTORS = {
  overflow: {
    desc: ['Más opciones', 'More options', 'Mais opções', 'Menú', 'Menu'],
    id: [/menuitem_overflow$/],
  },
  linkedDevices: {
    text: ['Dispositivos vinculados', 'Linked devices', 'Dispositivos conectados', 'Aparelhos conectados'],
  },
  linkDevice: {
    text: ['Vincular un dispositivo', 'Vincular dispositivo', 'Link a device', 'Conectar um aparelho'],
    id: [/link_device_button$/],
  },
  permissionAllow: {
    text: ['Mientras la app está en uso', 'Mientras se usa la app', 'While using the app', 'Permitir', 'Allow', 'Durante o uso do app'],
    id: [/permission_allow(_foreground_only)?_button$/],
  },
  linkWithPhone: {
    text: [
      'Vincular con el número de teléfono',
      'Vincular con el número de teléfono en su lugar',
      'Vincular con el número de teléfono.',
      'Link with phone number instead',
      'Link with phone number',
      'Conectar com número de telefone',
    ],
    contains: ['con el numero de telefono', 'with phone number', 'com numero de telefone'],
    id: [/link_with_phone_number$/],
  },
  codePrompt: {
    contains: ['8 caracteres', '8-character', '8 character', '8 caracteres'],
  },
  codeField: {
    id: [/code_input$/],
  },
  verify: {
    contains: ['confirma tu identidad', 'verifica que eres tu', "verify it's you", 'confirm your identity', 'confirme sua identidade'],
  },
};

const stripAccents = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '');

export function normalizeLabel(text) {
  return stripAccents(String(text ?? ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\.{1,3}|…)$/u, '')
    .trim();
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? '';
  });
}

function attributes(source) {
  const attrs = {};
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[match[1]] = decode(match[2]);
  return attrs;
}

// `uiautomator dump` output (possibly with text before or after the XML) -> flat list of nodes.
export function parseHierarchy(xml) {
  const text = String(xml ?? '');
  const start = text.indexOf('<hierarchy');
  if (start < 0) return [];
  const nodes = [];
  for (const match of text.slice(start).matchAll(/<node\b([^>]*?)\/?>/g)) {
    const a = attributes(match[1]);
    const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds ?? '');
    if (!bounds) continue;
    nodes.push({
      text: a.text ?? '',
      desc: a['content-desc'] ?? '',
      resourceId: a['resource-id'] ?? '',
      className: a.class ?? '',
      package: a.package ?? '',
      clickable: a.clickable === 'true',
      enabled: a.enabled !== 'false',
      bounds: { left: +bounds[1], top: +bounds[2], right: +bounds[3], bottom: +bounds[4] },
    });
  }
  return nodes;
}

export function centerOf(node) {
  const { left, top, right, bottom } = node.bounds;
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

const hasArea = (node) => node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top;

// First visible node that satisfies any rule of the selector (exact labels first, then fragments).
export function findNode(nodes, selector) {
  const usable = nodes.filter((n) => n.enabled && hasArea(n));
  const labels = (list) => (list ?? []).map(normalizeLabel);
  const text = labels(selector.text);
  const desc = labels(selector.desc);
  const contains = labels(selector.contains);

  const exact = (n) =>
    (text.length && text.includes(normalizeLabel(n.text))) ||
    (desc.length && desc.includes(normalizeLabel(n.desc))) ||
    (selector.id ?? []).some((re) => re.test(n.resourceId));
  const fragment = (n) => contains.some((c) => normalizeLabel(n.text).includes(c) || normalizeLabel(n.desc).includes(c));

  return usable.find(exact) ?? usable.find(fragment) ?? null;
}

// Which screen of the linking path is showing. The order matters: the overflow menu is drawn over the chat list,
// and the "Linked devices" label appears both in the menu and as the title of its own screen.
export function identifyScreen(nodes) {
  if (!nodes.length) return 'unknown';
  if (findNode(nodes, SELECTORS.codePrompt) || findNode(nodes, SELECTORS.codeField)) return 'code-entry';
  if (findNode(nodes, SELECTORS.linkWithPhone)) return 'link-scanner';
  if (findNode(nodes, SELECTORS.permissionAllow)) return 'permission';
  if (findNode(nodes, SELECTORS.linkDevice)) return 'linked-devices';
  if (findNode(nodes, SELECTORS.verify)) return 'verify';
  if (findNode(nodes, SELECTORS.linkedDevices)) return 'menu';
  if (findNode(nodes, SELECTORS.overflow)) return 'chats';
  if (!nodes.some((n) => WA_PACKAGES.includes(n.package))) return 'other-app';
  return 'unknown';
}

const TAP_STEPS = {
  chats: 'overflow',
  menu: 'linkedDevices',
  'linked-devices': 'linkDevice',
  permission: 'permissionAllow',
  'link-scanner': 'linkWithPhone',
};

// Decide the next move on the current screen.
//   { type: 'tap', target, x, y } | { type: 'type', text, focus } | { type: 'launch' } | { type: 'abort', reason, target? }
export function nextAction(screen, nodes, { code } = {}) {
  if (screen === 'code-entry') {
    const field = nodes.find((n) => n.className.endsWith('EditText') && hasArea(n));
    return { type: 'type', text: String(code ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(), focus: field ? centerOf(field) : null };
  }
  if (screen === 'verify') return { type: 'abort', reason: 'VERIFY_REQUIRED' };
  if (screen === 'other-app') return { type: 'launch' };

  const target = TAP_STEPS[screen];
  if (!target) return { type: 'abort', reason: 'UNKNOWN_SCREEN' };
  const node = findNode(nodes, SELECTORS[target]);
  if (!node) return { type: 'abort', reason: 'ELEMENT_NOT_FOUND', target };
  return { type: 'tap', target, ...centerOf(node) };
}

// Short list of what is on screen, for error messages.
export function visibleTexts(nodes, limit = 8) {
  return [...new Set(nodes.map((n) => n.text.trim() || n.desc.trim()).filter(Boolean))].slice(0, limit);
}
