// MCP stdio server of the Agente creativo (spawned by Claude Code from the per-turn mcp config).
//   env: AGENTAUTO_DATA_DIR (required), AGENTAUTO_SESSION_ID, AGENTAUTO_CREATIVO_ROOT (workspace), AGENTAUTO_CODEX_CMD (JSON
//        { command, prefixArgs }), AGENTAUTO_CODEX_HOME, AGENTAUTO_CODEX_MODEL, AGENTAUTO_CODEX_EFFORT,
//        AGENTAUTO_KEY_PORT / AGENTAUTO_KEY_NONCE (one-shot loopback hand-off of the ElevenLabs key, see creativo-keybroker.js;
//        the key comes from the OS keyring through the app and never passes through the model or Claude Code's env)
// Tools:
//   free:      propose_generation, list_voice_presets
//   approved:  generate_image, design_pdf_asset, generate_voice (the PreToolUse hook spends the user's approval before
//              they run, and each handler checks it again: see creativo-approvals.js)
// stdout carries ONLY protocol messages; diagnostics go to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { APPROVAL_SCHEMA, argsHash, createApprovals, GENERATION_TOOLS } from './creativo-approvals.js';
import { generateWithCodex, locateCodex, resolveCodexHome, DEFAULT_CODEX_EFFORT, DEFAULT_CODEX_MODEL } from './creativo-codex.js';
import { buildImagePrompt, copyWithoutOverwrite, normalizeAspect, outputDir, PURPOSES, resolveProductDir, countrySlug, safeStem, safeSubfolder, writeWithoutOverwrite } from './creativo-media.js';
import { fetchKeyFromBroker } from './creativo-keybroker.js';
import { createClient, DEFAULT_MODEL, estimateVoice, findPreset, loadPresets, MAX_TEXT_CHARS } from './elevenlabs.js';
import { createMcpServer, serveStdio } from './mcp-protocol.js';
import { agentDbPath } from './paths.js';
import { resolveDataDir } from '../warmup/data-dir.js';

const MAX_ITEMS = 12;
const PDF_KINDS = ['cover', 'page', 'illustration'];
const PDF_ASPECT = { cover: 'portrait', page: 'portrait', illustration: 'square' };

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// ---- validation (shared by the proposal and by the tools, so what is approved is exactly what runs) ----------------

function checkPlace(ctx, args) {
  if (!args.product || !args.country) throw new Error('Indica product y country (por ejemplo "Bebidas" y "venezuela").');
  resolveProductDir(ctx.root, args.product);
  countrySlug(args.country);
}

export function validateImageArgs(ctx, args, pdfKind) {
  const prompt = str(args.prompt, 2000);
  if (prompt.length < 5) throw new Error('Describe la imagen en prompt (mínimo 5 caracteres).');
  checkPlace(ctx, args);
  if (args.purpose !== undefined && !PURPOSES.includes(args.purpose)) throw new Error(`purpose debe ser ${PURPOSES.join(', ')}.`);
  normalizeAspect(args.aspect, pdfKind ? PDF_ASPECT[pdfKind] : 'portrait');
  if (args.subfolder) safeSubfolder(args.subfolder);
  return { prompt };
}

/** design_pdf_asset: same checks plus a mandatory kind. */
export function validatePdfArgs(ctx, args) {
  if (!PDF_KINDS.includes(args.kind)) throw new Error(`kind debe ser ${PDF_KINDS.join(', ')}.`);
  return validateImageArgs(ctx, args, args.kind);
}

/** Resolves the voice a request names (preset or voice_id) with the model and settings to use. */
export function resolveVoice(ctx, args) {
  const presets = ctx.presets();
  const preset = args.preset || !args.voice_id ? findPreset(presets, args) : null;
  if (args.preset && !preset) throw new Error(`No existe el preset "${str(args.preset, 60)}". Presets: ${presets.map((p) => p.name).join(', ') || 'ninguno (créalos en la sección Voces)'}.`);
  if (!preset && !args.voice_id) throw new Error('Indica preset o voice_id (o guarda un preset para ese producto y país en la sección Voces).');
  return {
    voiceId: args.voice_id || preset.voiceId,
    modelId: args.model_id || preset?.modelId || DEFAULT_MODEL,
    settings: preset ? { stability: preset.stability, similarity: preset.similarity, style: preset.style, speakerBoost: preset.speakerBoost } : {},
    presetName: preset?.name ?? null,
  };
}

export function validateVoiceArgs(ctx, args) {
  const text = String(args.text ?? '');
  if (!text.trim()) throw new Error('Falta el texto del audio.');
  if ([...text].length > MAX_TEXT_CHARS) throw new Error(`El texto supera ${MAX_TEXT_CHARS} caracteres; divídelo en partes.`);
  checkPlace(ctx, args);
  const voice = resolveVoice(ctx, args);
  return { voice, estimate: estimateVoice({ text, modelId: voice.modelId }) };
}

function describeItem(ctx, item) {
  const a = item.args ?? {};
  if (item.tool === 'generate_image') {
    validateImageArgs(ctx, a);
    return { label: `Imagen para ${str(a.product, 40)} / ${str(a.country, 20)}: ${str(a.prompt, 120)}`, units: { images: 1 } };
  }
  if (item.tool === 'design_pdf_asset') {
    validatePdfArgs(ctx, a);
    return { label: `Arte de PDF (${a.kind}) para ${str(a.product, 40)} / ${str(a.country, 20)}: ${str(a.prompt, 110)}`, units: { images: 1 } };
  }
  if (item.tool === 'generate_voice') {
    const { voice, estimate } = validateVoiceArgs(ctx, a);
    return { label: `Audio de ElevenLabs (${voice.presetName ?? voice.voiceId}) para ${str(a.product, 40)} / ${str(a.country, 20)}: ${estimate.chars} caracteres`, units: { chars: estimate.chars, credits: estimate.credits } };
  }
  throw new Error(`Herramienta no permitida: ${item.tool}.`);
}

// ---- tools ---------------------------------------------------------------------------------------------------------

export function createCreativoTools(ctx) {
  const spend = async (tool, args, run) => {
    const hash = argsHash(tool, args);
    const itemId = ctx.approvals.begin(tool, hash);
    if (!itemId) return { error: 'No hay una aprobación vigente para estos argumentos. Usa propose_generation y espera a que el usuario apruebe.' };
    try {
      const result = await run();
      ctx.approvals.finish(itemId, { ok: true, result });
      return result;
    } catch (error) {
      const message = String(error?.message ?? error);
      ctx.approvals.finish(itemId, { ok: false, result: { error: message } });
      return { error: message };
    }
  };

  const makeImage = async (tool, args, pdfKind) => {
    if (pdfKind) validatePdfArgs(ctx, args);
    else validateImageArgs(ctx, args);
    const instruction = buildImagePrompt({ prompt: args.prompt, aspect: normalizeAspect(args.aspect, pdfKind ? PDF_ASPECT[pdfKind] : 'portrait'), purpose: args.purpose, text: args.text, pdfKind });
    const dir = outputDir({ root: ctx.root, product: args.product, country: args.country, kind: pdfKind ? 'pdf-asset' : 'image', pdfKind, subfolder: args.subfolder });
    const generated = await ctx.generateImage(instruction);
    const ext = path.extname(generated.file).toLowerCase() || '.png';
    const file = copyWithoutOverwrite(generated.file, dir, safeStem(args.filename, `${pdfKind ?? 'imagen'}-${stamp()}`), ext);
    return { ok: true, tool, ruta: file, ruta_relativa: path.relative(ctx.root, file).replace(/\\/g, '/'), ancho: generated.size?.width ?? null, alto: generated.size?.height ?? null };
  };

  return [
    {
      name: 'propose_generation',
      description: 'OBLIGATORIO antes de generar imágenes, arte de PDF o audios de pago. Registra la propuesta (hasta 12 elementos) y el usuario la aprueba con un botón en el chat. Devuelve el id y los argumentos EXACTOS que debes usar después. Tras proponer, TERMINA tu turno y espera el mensaje "Aprobado #id".',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Resumen corto de lo que se generará y para qué.' },
          items: {
            type: 'array', maxItems: MAX_ITEMS,
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', enum: GENERATION_TOOLS },
                args: { type: 'object', description: 'Los mismos argumentos que recibirá esa herramienta.' },
              },
              required: ['tool', 'args'],
            },
          },
        },
        required: ['items'],
      },
      handler: async ({ summary, items }) => {
        if (!Array.isArray(items) || !items.length) return { error: 'Faltan los elementos (items) de la propuesta.' };
        if (items.length > MAX_ITEMS) return { error: `Máximo ${MAX_ITEMS} elementos por propuesta; divídela.` };
        const described = [];
        for (const [i, item] of items.entries()) {
          try {
            described.push({ tool: item.tool, args: item.args ?? {}, ...describeItem(ctx, item) });
          } catch (error) {
            return { error: `Elemento ${i + 1}: ${String(error?.message ?? error)}` };
          }
        }
        const proposal = ctx.approvals.propose({ sessionId: ctx.sessionId, summary: str(summary, 400), items: described });
        const total = described.reduce((acc, d) => ({ images: acc.images + (d.units.images ?? 0), chars: acc.chars + (d.units.chars ?? 0), credits: acc.credits + (d.units.credits ?? 0) }), { images: 0, chars: 0, credits: 0 });
        let remaining = null;
        if (total.credits && ctx.eleven) {
          try {
            remaining = (await (await ctx.eleven()).subscription()).remaining;
          } catch {
            /* the card works without the balance */
          }
        }
        return {
          proposal_id: proposal.id, estado: 'esperando_aprobacion', imagenes: total.images, caracteres: total.chars, creditos_elevenlabs: total.credits, creditos_elevenlabs_disponibles: remaining,
          elementos: proposal.items.map((it, n) => ({ n: n + 1, herramienta: it.tool, resumen: it.label, argumentos_exactos: it.args })),
          instruccion: 'Muéstrale al usuario un resumen breve y TERMINA tu turno ahora. No llames a ninguna herramienta de generación hasta que escriba "Aprobado #' + proposal.id + '". Entonces llama a cada herramienta con exactamente los argumentos_exactos de su elemento.',
        };
      },
    },
    {
      name: 'list_voice_presets',
      description: 'Lista los presets de voz guardados por el usuario (producto, país, voz y modelo) y si la clave de ElevenLabs está configurada. No gasta créditos.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({ clave_elevenlabs_configurada: Boolean(ctx.hasElevenKey), presets: ctx.presets().map((p) => ({ nombre: p.name, producto: p.product, pais: p.country, voz: p.voiceId, modelo: p.modelId })) }),
    },
    {
      name: 'generate_image',
      description: 'Genera UNA imagen con GPT (Codex, plan de ChatGPT) y la guarda en la carpeta del producto: <Producto X>/<país>/imagenes. Solo funciona con argumentos ya aprobados por el usuario (ver propose_generation). Sin texto ni logos salvo que pidas `text`; las fotos salen completas.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Qué debe mostrar la imagen (en cualquier idioma).' },
          product: { type: 'string', description: 'Producto existente, por ejemplo "Bebidas".' },
          country: { type: 'string', description: 'País: colombia, mexico, venezuela...' },
          filename: { type: 'string', description: 'Nombre sin extensión (opcional). Nunca sobrescribe: si existe agrega -2, -3.' },
          aspect: { type: 'string', enum: ['portrait', 'square', 'landscape'], description: 'Proporción (por defecto portrait 1024x1536).' },
          purpose: { type: 'string', enum: PURPOSES, description: 'reel = sin caras al frente.' },
          text: { type: 'string', description: 'Texto exacto que debe aparecer, solo si el usuario lo pidió.' },
          subfolder: { type: 'string', description: 'Carpeta del país donde guardar en vez de imagenes (opcional), por ejemplo pruebas.' },
        },
        required: ['prompt', 'product', 'country'],
      },
      handler: (args) => spend('generate_image', args, () => makeImage('generate_image', args)),
    },
    {
      name: 'design_pdf_asset',
      description: 'Genera arte para un PDF (portada, fondo de página o ilustración) con GPT y lo guarda en <Producto X>/pdf/<país>/arte/. El ensamblado del PDF lo haces después con los scripts del motor de PDF. Solo con argumentos aprobados (ver propose_generation).',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: PDF_KINDS },
          prompt: { type: 'string' },
          product: { type: 'string' },
          country: { type: 'string' },
          filename: { type: 'string' },
          aspect: { type: 'string', enum: ['portrait', 'square', 'landscape'] },
          text: { type: 'string', description: 'Texto exacto, solo si el usuario lo pidió.' },
        },
        required: ['kind', 'prompt', 'product', 'country'],
      },
      handler: (args) => spend('design_pdf_asset', args, () => makeImage('design_pdf_asset', args, args.kind)),
    },
    {
      name: 'generate_voice',
      description: 'Genera un audio con ElevenLabs (gasta créditos de pago) y lo guarda en <Producto X>/audios/<país>. Solo con argumentos aprobados (ver propose_generation, que muestra caracteres y créditos). Usa preset (nombre) o voice_id.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Texto exacto a locutar, con todas las tildes, ¿ y ¡.' },
          preset: { type: 'string', description: 'Nombre del preset de voz (ver list_voice_presets).' },
          voice_id: { type: 'string', description: 'ID de voz de ElevenLabs (si no usas preset).' },
          model_id: { type: 'string' },
          product: { type: 'string' },
          country: { type: 'string' },
          filename: { type: 'string' },
        },
        required: ['text', 'product', 'country'],
      },
      handler: (args) =>
        spend('generate_voice', args, async () => {
          const { voice, estimate } = validateVoiceArgs(ctx, args);
          const bytes = await (await ctx.eleven()).tts({ voiceId: voice.voiceId, text: args.text, modelId: voice.modelId, settings: voice.settings });
          const dir = outputDir({ root: ctx.root, product: args.product, country: args.country, kind: 'audio' });
          const file = writeWithoutOverwrite(bytes, dir, safeStem(args.filename, `audio-${stamp()}`), '.mp3');
          return { ok: true, ruta: file, ruta_relativa: path.relative(ctx.root, file).replace(/\\/g, '/'), caracteres: estimate.chars, creditos_estimados: estimate.credits, preset: voice.presetName };
        }),
    },
  ];
}

/** Context from the environment (what Claude Code gives this process). */
export function contextFromEnv(env = process.env) {
  const dataDir = env.AGENTAUTO_DATA_DIR ? env.AGENTAUTO_DATA_DIR : resolveDataDir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'warmup'));
  const dbFile = agentDbPath(dataDir, 'creativo');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(APPROVAL_SCHEMA);
  const codexHome = resolveCodexHome({ override: env.AGENTAUTO_CODEX_HOME, env });
  let codex = null;
  try {
    codex = env.AGENTAUTO_CODEX_CMD ? JSON.parse(env.AGENTAUTO_CODEX_CMD) : null;
  } catch {
    codex = null;
  }
  codex ??= locateCodex({ env });
  // The key comes from the turn process once, at startup (before the model can run anything); the env variable is only a fallback for tests.
  const keyPromise = env.AGENTAUTO_KEY_PORT ? fetchKeyFromBroker({ port: env.AGENTAUTO_KEY_PORT, nonce: env.AGENTAUTO_KEY_NONCE }) : Promise.resolve((env.AGENTAUTO_ELEVEN_KEY ?? '').trim());
  const ctx = {
    db,
    root: env.AGENTAUTO_CREATIVO_ROOT,
    dataDir,
    sessionId: env.AGENTAUTO_SESSION_ID || null,
    approvals: createApprovals(db),
    presets: () => loadPresets(dataDir),
    hasElevenKey: Boolean(env.AGENTAUTO_KEY_PORT || env.AGENTAUTO_ELEVEN_KEY),
    eleven: async () => createClient({ key: await keyPromise }),
    generateImage: (instruction) => generateWithCodex({ instruction, codex, codexHome, model: env.AGENTAUTO_CODEX_MODEL || DEFAULT_CODEX_MODEL, effort: env.AGENTAUTO_CODEX_EFFORT || DEFAULT_CODEX_EFFORT, env }),
  };
  return ctx;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ctx = contextFromEnv();
  if (!ctx.root) {
    process.stderr.write('AGENTAUTO_CREATIVO_ROOT is missing\n');
    process.exit(1);
  }
  await serveStdio(createMcpServer({ name: 'creativo', version: '1.0.0', tools: createCreativoTools(ctx) }));
  ctx.db.close();
}
