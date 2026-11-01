// Where the Agente creativo's generated files go, and the rules every image prompt carries. Pure helpers (no spawning):
// the product/country are validated against the workspace, so nothing a model sends can name a path outside it.
import fs from 'node:fs';
import path from 'node:path';

export class MediaError extends Error {}

const stripAccents = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

/** 'México ' -> 'mexico'. Throws for anything that is not a plain country name. */
export function countrySlug(country) {
  const slug = stripAccents(country ?? '').toLowerCase().trim().replace(/\s+/g, '-');
  if (!/^[a-z][a-z0-9-]{1,29}$/.test(slug)) throw new MediaError('El país debe ser un nombre simple como colombia, mexico o venezuela.');
  return slug;
}

/** Existing folder of a product inside the workspace: "Bebidas" or "Producto Bebidas" -> <root>/Producto Bebidas. */
export function resolveProductDir(root, product) {
  const raw = String(product ?? '').trim();
  if (!raw || raw.length > 80 || /[\\/:*?"<>|]|\.\./.test(raw)) throw new MediaError('El producto debe ser un nombre como Bebidas (sin rutas).');
  const lower = raw.toLowerCase();
  const names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const products = names.filter((n) => /^producto\s+/i.test(n) && !/^producto ideas$/i.test(n));
  const hit = products.find((n) => n.toLowerCase() === lower || n.toLowerCase() === `producto ${lower}`);
  if (!hit) throw new MediaError(`No encuentro el producto "${raw}". Productos disponibles: ${products.join(', ') || 'ninguno'}.`);
  return path.join(root, hit);
}

/** Safe file stem: letters, digits, dot, dash and underscore only; no folders; extension decided by the caller. */
export function safeStem(name, fallback) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/')).replace(/\.[a-z0-9]{2,5}$/i, '');
  const stem = stripAccents(base).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return stem || fallback;
}

/** One relative sub-folder (up to 3 plain segments) or ''. */
export function safeSubfolder(sub) {
  const parts = String(sub ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length) return '';
  if (parts.length > 3 || parts.some((p) => !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$/.test(p) || p === '..')) throw new MediaError('La subcarpeta debe tener hasta 3 niveles con nombres simples.');
  return parts.join('/');
}

const PDF_KIND_DIR = { cover: 'portadas', page: 'fondos', illustration: 'ilustraciones' };

/**
 * Layout of the generated files inside a product folder (matches how the products are organised today):
 *   images        <product>/<country>/imagenes (or <product>/<country>/<subfolder> when one is given)
 *   PDF artwork   <product>/pdf/<country>/arte/<portadas|fondos|ilustraciones>
 *   voices        <product>/audios/<country>
 */
export function outputDir({ root, product, country, kind, pdfKind, subfolder }) {
  const productDir = resolveProductDir(root, product);
  const slug = countrySlug(country);
  if (kind === 'image') {
    // A subfolder replaces the default `imagenes` (e.g. "pruebas-codex" -> <product>/<country>/pruebas-codex).
    const sub = safeSubfolder(subfolder).split('/').filter(Boolean);
    return path.join(productDir, slug, ...(sub.length ? sub : ['imagenes']));
  }
  if (kind === 'pdf-asset') return path.join(productDir, 'pdf', slug, 'arte', PDF_KIND_DIR[pdfKind] ?? 'otros');
  if (kind === 'audio') return path.join(productDir, 'audios', slug);
  throw new MediaError(`Tipo de archivo desconocido: ${kind}.`);
}

/** Copies `from` into `dir` as <stem><ext> without ever overwriting: an existing name gets -2, -3... Returns the final path. */
export function copyWithoutOverwrite(from, dir, stem, ext) {
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= 500; n += 1) {
    const target = path.join(dir, `${stem}${n === 1 ? '' : `-${n}`}${ext}`);
    try {
      fs.copyFileSync(from, target, fs.constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new MediaError('Hay demasiados archivos con ese nombre; elige otro nombre.');
}

/** Same for bytes already in memory (the ElevenLabs audio). */
export function writeWithoutOverwrite(bytes, dir, stem, ext) {
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= 500; n += 1) {
    const target = path.join(dir, `${stem}${n === 1 ? '' : `-${n}`}${ext}`);
    try {
      fs.writeFileSync(target, bytes, { flag: 'wx' });
      return target;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new MediaError('Hay demasiados archivos con ese nombre; elige otro nombre.');
}

// ---- image prompts -------------------------------------------------------------------------------------------------

export const ASPECTS = Object.freeze({
  portrait: { size: '1024x1536', label: 'vertical 2:3' },
  square: { size: '1024x1024', label: 'cuadrada 1:1' },
  landscape: { size: '1536x1024', label: 'horizontal 3:2' },
});
const ASPECT_ALIASES = { vertical: 'portrait', '2:3': 'portrait', '9:16': 'portrait', '3:4': 'portrait', '1:1': 'square', cuadrada: 'square', horizontal: 'landscape', '3:2': 'landscape', '16:9': 'landscape', '4:3': 'landscape' };

export function normalizeAspect(aspect, fallback = 'portrait') {
  const a = String(aspect ?? '').toLowerCase().trim();
  if (!a) return fallback;
  if (ASPECTS[a]) return a;
  if (ASPECT_ALIASES[a]) return ASPECT_ALIASES[a];
  throw new MediaError('La proporción debe ser portrait, square o landscape (o 2:3, 1:1, 3:2).');
}

export const PURPOSES = ['reel', 'pdf', 'ad', 'other'];

const BASE_RULES = [
  'Do not put any text, letters, numbers, logos, brand marks or watermarks anywhere in the image.',
  'Show every subject whole: never crop a product, dish or drink at the frame edge; leave a clean margin around it.',
  'Everything sharp: the whole frame in focus, no blur, no collage, no pasted cutouts, no split panels.',
];
const KIND_RULES = {
  cover: ['This is cover artwork for a book: a strong single composition with a calm area where a title can be placed later (do not draw the title).'],
  page: ['This is a page background for a printed book: a soft, low-contrast texture or pattern; no focal subject in the center so text stays readable on top.'],
  illustration: ['This is a single isolated illustration on a plain clean white background, complete and centered, soft watercolor look, no shadow or frame.'],
};

/** The instruction handed to Codex. The user's wishes come first; the house rules are appended and cannot be dropped. */
export function buildImagePrompt({ prompt, aspect = 'portrait', purpose, text, pdfKind }) {
  const a = ASPECTS[normalizeAspect(aspect)];
  const rules = [...BASE_RULES];
  if (text) rules[0] = `The only text allowed is exactly this (spelled exactly, with all accents): "${String(text).slice(0, 200)}". No other text, logos or watermarks.`;
  if (purpose === 'reel') rules.push('Frames for a short vertical video: do not show a person facing the camera or any close-up of a face; people in the scene are fine if their faces are not the focus.');
  if (pdfKind && KIND_RULES[pdfKind]) rules.push(...KIND_RULES[pdfKind]);
  return [
    `Use your image generation tool to create ONE image, ${a.label} (${a.size}). Do not write any file yourself and do not run any other command.`,
    `Image request: ${String(prompt).trim()}`,
    `Rules that always apply: ${rules.join(' ')}`,
    'When the image is ready, reply with only the absolute path of the generated image file, nothing else.',
  ].join('\n');
}
