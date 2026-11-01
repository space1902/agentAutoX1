// The standard checklist of a product (docs/creativo/inventario-productos.md, section 2) as DATA, with the rule that tells the
// disk whether each item is done. Nothing here is hardcoded in the roadmap logic: the owner can replace or extend it with
// <data>/agents/creativo/roadmap.config.json  { "countrySuffix": { "peru": "pe" }, "templates": [ { id, ... } ] }
// (a template with an existing id replaces the default one).
//
// verify (how the disk proves the item):
//   { type: 'file', path, placeholders? }                      one file; placeholders (regex) found inside = work in progress
//   { type: 'files', dir, match, expected, distinct?, recursive?, excludeDirs? }   count of files; expected or more = done, 1..expected-1 = in progress
//   { type: 'any', of: [verify, ...] }                         the best result of several alternatives
//   null                                                       cannot be checked on disk (Leona flows, payments, campaigns): manual
// Tokens in paths: {c} country folder name, {sfx} "-mx" style suffix of the country ('' for the home country), {p} product name.
// A path starting with @root/ is relative to the workspace root instead of the product folder.
// countries: [..] restricts the check to those countries (the item stays pending elsewhere).
export const DEFAULT_COUNTRY_SUFFIX = Object.freeze({ colombia: '', mexico: 'mx', venezuela: 've' });

export const DEFAULT_TEMPLATES = Object.freeze([
  // ---- product level
  { id: 'contexto', phase: 'A', scope: 'product', sort: 10, skill: 'new-product', title: 'contexto.md (avatar, mecanismo, oferta, tono)', verify: { type: 'file', path: 'contexto.md' } },
  { id: 'mercado', phase: 'A', scope: 'product', sort: 12, skill: 'investigacion-mercado', title: 'Análisis de mercado en la Biblioteca de anuncios', verify: { type: 'files', dir: '@root/producto ideas/investigaciones', match: '{p}', expected: 1, recursive: false } },
  { id: 'flujo-venta', phase: 'D', scope: 'product', sort: 20, title: 'Estructura del flujo de venta (paquetes y aporte)', verify: { type: 'file', path: 'ideas/FLUJO-DE-VENTA.txt' } },
  { id: 'portadas', phase: 'B', scope: 'product', sort: 30, dependsOn: ['contexto'], title: 'Portadas de venta (un PNG por libro)', verify: { type: 'files', dir: 'referencias/imagenesventa/_build/covers', match: '\\.png$', expected: 16, recursive: false } },
  // ---- country level
  { id: 'refs', phase: 'A', scope: 'country', sort: 40, skill: 'new-product', title: 'Videos de referencia / b-roll del tema', verify: { type: 'any', of: [{ type: 'files', dir: 'videos/{c}/broll_tiktok', match: '\\.mp4$', expected: 20 }, { type: 'files', dir: 'videos/{c}/broll', match: '\\.mp4$', expected: 20 }, { type: 'files', dir: 'referencias/videos', match: '\\.mp4$', expected: 20, countries: ['colombia'] }] } },
  { id: 'precios', phase: 'A', scope: 'country', sort: 42, title: 'Precios reales del país (CSV de supermercados)', countries: ['colombia'], verify: { type: 'files', dir: '.', match: '^precios.*\\.csv$', expected: 1, recursive: false } },
  { id: 'pdf', phase: 'B', scope: 'country', sort: 50, dependsOn: ['contexto'], skill: 'redaccion-infoproducto', title: 'PDF de cada libro (16)', verify: { type: 'files', dir: 'pdf/{c}', match: '\\.pdf$', expected: 16, distinct: true, excludeDirs: ['arte', 'motor', 'motor_extra'] } },
  { id: 'guiones', phase: 'C', scope: 'country', sort: 60, dependsOn: ['contexto'], skill: 'ads-infoproductos', title: 'Guiones de video', verify: { type: 'files', dir: 'guiones/{c}', match: 'guiones?-video', expected: 1, recursive: false } },
  { id: 'textos-anuncio', phase: 'F', scope: 'country', sort: 62, dependsOn: ['guiones'], skill: 'ads-infoproductos', title: 'Textos de anuncio (uno por video)', verify: { type: 'any', of: [{ type: 'files', dir: 'guiones/{c}', match: 'anuncios-textos', expected: 1, recursive: false }, { type: 'files', dir: 'videos/{c}', match: 'anuncios-textos', expected: 1, recursive: false }] } },
  { id: 'mensajes-chat', phase: 'D', scope: 'country', sort: 70, title: 'Mensajes del chat (modelo Lucía) sin marcadores por completar', verify: { type: 'file', path: 'mensajes-chat/{c}/mensajes-whatsapp.txt', placeholders: '\\[(LINK|DATOS|NUMERO|NÚMERO)[^\\]]*\\]' } },
  { id: 'downsell', phase: 'D', scope: 'country', sort: 72, dependsOn: ['mensajes-chat'], title: 'Imagen del downsell', verify: { type: 'files', dir: 'referencias/imagenesventa', match: '^downsell-comida{sfx}\\.(png|jpe?g)$', expected: 1, recursive: false } },
  { id: 'audios-clientes', phase: 'E', scope: 'country', sort: 80, dependsOn: ['mensajes-chat'], skill: 'new-product', title: 'Audios del chat (bienvenida, historia, aporte, downsell)', verify: { type: 'files', dir: 'audios/{c}/clientes', match: '\\.mp3$', expected: 4 } },
  { id: 'audios-contenido', phase: 'E', scope: 'country', sort: 82, dependsOn: ['guiones'], skill: 'new-product', title: 'Audios de contenido (locución de los 12 reels)', verify: { type: 'files', dir: 'audios/{c}/contenido', match: '\\.mp3$', expected: 12 } },
  { id: 'videos', phase: 'F', scope: 'country', sort: 90, dependsOn: ['audios-contenido', 'refs'], skill: 'new-product', title: 'Videos montados (12)', verify: { type: 'files', dir: 'videos/{c}', match: '^guion_\\d+.*\\.mp4$', expected: 12, recursive: false } },
  // ---- manual: nothing on disk proves them
  { id: 'flujo-leona', phase: 'D', scope: 'country', sort: 100, dependsOn: ['mensajes-chat', 'pdf'], title: 'Flujo en Leona (número de WhatsApp asignado y probado)', verify: null },
  { id: 'pago', phase: 'H', scope: 'country', sort: 102, title: 'Medio de pago con los datos cargados', verify: null },
  { id: 'pixel', phase: 'D', scope: 'country', sort: 104, dependsOn: ['flujo-leona'], title: 'Pixel y evento de compra verificados', verify: null },
  { id: 'campanas', phase: 'F', scope: 'country', sort: 110, dependsOn: ['videos', 'textos-anuncio', 'flujo-leona', 'pago'], title: 'Campañas activas en Meta', verify: null },
]);
