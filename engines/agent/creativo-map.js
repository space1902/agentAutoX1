// Compact product map injected into the Agente creativo's system prompt, so it does not explore the folders to find
// out what exists. Built from the disk at turn start (nothing hardcoded about one product): every "Producto <X>" folder
// of the workspace is an active product, the folders inside "producto ideas" are archived ideas, countries are the
// sub-folder names shared by several top-level folders (audios/colombia, pdf/colombia ...). The result is cached on disk
// keyed by the mtimes of the folder tree (depth <= 4), and capped so it stays around 2k tokens.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CHARS = 7200;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '_build', '.cache', '.venv', 'venv']);
const SIGNATURE_DEPTH = 4;
const MAX_ENTRIES = 40_000;
// Top-level folders that are never worth listing as "other folders" (apps, bots, secrets, tooling).
const NOT_CONTENT = /^(\.|node_modules$|agentautox1$|meta-ads-monitor$|whatsapp-|redroid$|mock$|tests?$|scripts?$|data$|analysis$)/i;

const GROUPS = new Map([
  ['pdf', 'pdf'], ['mp3', 'audio'], ['ogg', 'audio'], ['opus', 'audio'], ['wav', 'audio'], ['m4a', 'audio'],
  ['mp4', 'video'], ['mov', 'video'], ['webm', 'video'], ['mkv', 'video'],
  ['png', 'imagen'], ['jpg', 'imagen'], ['jpeg', 'imagen'], ['webp', 'imagen'],
  ['txt', 'texto'], ['md', 'texto'], ['docx', 'texto'], ['json', 'texto'], ['csv', 'texto'],
]);

const GROUP_ORDER = ['pdf', 'video', 'audio', 'texto', 'imagen'];

const dirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));
  } catch {
    return [];
  }
};

/** Recursive file count of a folder: { total, groups: { audio: n, ... } }. */
function countFiles(dir, budget = { left: MAX_ENTRIES }) {
  const out = { total: 0, groups: {} };
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget.left-- <= 0) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name));
      } else if (e.isFile()) {
        out.total += 1;
        const group = GROUPS.get(path.extname(e.name).slice(1).toLowerCase());
        if (group) out.groups[group] = (out.groups[group] ?? 0) + 1;
      }
    }
  };
  walk(dir);
  return out;
}

const cell = (name, c) => {
  const top = GROUP_ORDER.filter((g) => c.groups[g]).slice(0, 3).map((g) => `${g} ${c.groups[g]}`);
  return c.total ? `${name} ${c.total}${top.length ? ` (${top.join(', ')})` : ''}` : `${name} vacía`;
};

const looseFiles = (dir, max = 8) => {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name);
    return files.length > max ? `${files.slice(0, max).join(', ')} (+${files.length - max})` : files.join(', ');
  } catch {
    return '';
  }
};

/** Countries of a product = sub-folder names that appear under 2+ top-level folders, plus top-level folders with that name. */
export function detectCountries(topDirs) {
  const seen = new Map();
  for (const { children } of topDirs) for (const child of new Set(children)) seen.set(child, (seen.get(child) ?? 0) + 1);
  const shared = [...seen].filter(([c, n]) => n >= 2 && !c.startsWith('_')).map(([c]) => c);
  const topNames = topDirs.map((t) => t.name);
  const asTop = shared.filter((c) => topNames.includes(c));
  return { countries: [...new Set(shared)].sort(), countryTop: asTop };
}

function describeProduct(root, name, status) {
  const dir = path.join(root, name);
  const top = dirs(dir).map((d) => ({ name: d.name, children: dirs(path.join(dir, d.name)).map((c) => c.name) }));
  const { countries } = detectCountries(top);
  const lines = [];
  const loose = looseFiles(dir);
  lines.push(`${name} — ${status}${countries.length ? `. Países: ${countries.join(', ')}` : ''}${loose ? `. En la raíz: ${loose}` : ''}`);
  for (const t of top) {
    if (countries.includes(t.name)) {
      // A country folder at the top level (e.g. venezuela/pruebas-codex): list what it holds.
      const kids = t.children.map((k) => cell(k, countFiles(path.join(dir, t.name, k))));
      const own = countFiles(path.join(dir, t.name));
      lines.push(`  ${t.name}/ (carpeta de país): ${kids.length ? kids.join(' · ') : `${own.total} archivos`}`);
      continue;
    }
    if (!t.children.length) {
      lines.push(`  ${t.name}/: ${cell('archivos', countFiles(path.join(dir, t.name)))}`);
      continue;
    }
    const kids = t.children.map((k) => cell(k, countFiles(path.join(dir, t.name, k))));
    lines.push(`  ${t.name}/: ${kids.join(' · ')}`);
  }
  return lines;
}

export function buildProductMapText(root, { now = new Date() } = {}) {
  const top = dirs(root);
  const isIdeas = (name) => /^producto ideas$/i.test(name);
  const products = top.filter((d) => /^producto\s+/i.test(d.name) && !isIdeas(d.name));
  const ideasDir = top.find((d) => isIdeas(d.name));
  const lines = [`MAPA DE PRODUCTOS (generado ${now.toISOString().slice(0, 10)}; rutas relativas a ${root.replace(/\\/g, '/')})`];
  for (const p of products) lines.push(...describeProduct(root, p.name, 'ACTIVO'));
  if (ideasDir) {
    const ideas = dirs(path.join(root, ideasDir.name)).map((d) => cell(d.name, countFiles(path.join(root, ideasDir.name, d.name))));
    if (ideas.length) lines.push(`${ideasDir.name}/ (ideas y producto archivado, no se trabajan salvo que lo pidan): ${ideas.join(' · ')}`);
  }
  const others = top.filter((d) => !/^producto\s+/i.test(d.name) && !NOT_CONTENT.test(d.name) && d.name !== ideasDir?.name).map((d) => d.name);
  if (others.length) lines.push(`Otras carpetas de contenido: ${others.slice(0, 12).join(', ')}`);
  let text = lines.join('\n');
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 40).replace(/\n[^\n]*$/, '')}\n…(mapa recortado)`;
  return text;
}

/** Hash of the folder mtimes (depth <= 4) under every product/ideas folder: changes when anything is added or removed there. */
export function mapSignature(root) {
  const parts = [];
  const visit = (dir, depth) => {
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      return;
    }
    parts.push(`${dir}|${Math.round(st.mtimeMs)}`);
    if (depth >= SIGNATURE_DEPTH) return;
    for (const d of dirs(dir)) visit(path.join(dir, d.name), depth + 1);
  };
  parts.push(`root|${dirs(root).map((d) => d.name).join(',')}`);
  for (const d of dirs(root)) if (/^producto\s+/i.test(d.name)) visit(path.join(root, d.name), 1);
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

/** The map for the prompt, rebuilt only when the folder tree changed since the cached one. Never throws: no map is better than no turn. */
export function getProductMap({ root, cacheFile, now = new Date() } = {}) {
  try {
    if (!root || !fs.existsSync(root)) return '';
    const signature = mapSignature(root);
    if (cacheFile) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached.signature === signature && cached.root === root && typeof cached.text === 'string') return cached.text;
      } catch {
        /* no cache yet */
      }
    }
    const text = buildProductMapText(root, { now });
    if (cacheFile) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ signature, root, text, builtAt: now.toISOString() }), 'utf8');
    }
    return text;
  } catch {
    return '';
  }
}
