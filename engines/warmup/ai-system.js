// Hardware probes for the local-model screen: which video card is there and how much memory is in use.
// Everything that spawns a process goes through an injectable `exec`, so tests never touch the machine.
import { execFile } from 'node:child_process';
import os from 'node:os';

const MB = 1024 * 1024;

export function defaultExec(file, args = []) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 8000, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    );
  });
}

export function classifyGpu(name) {
  const text = String(name);
  if (/nvidia|geforce|\brtx\b|\bgtx\b|quadro|radeon\s+(rx|pro)\b|\barc\b.*\ba\d{3}/i.test(text)) return 'dedicated';
  return 'integrated';
}

export function parseNvidiaSmi(output) {
  const gpus = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 3) continue;
    const total = Number.parseInt(parts[1], 10);
    const used = Number.parseInt(parts[2], 10);
    if (!parts[0] || !Number.isFinite(total) || !Number.isFinite(used)) continue;
    gpus.push({ name: parts[0], totalMb: total, usedMb: used });
  }
  return gpus;
}

export function parseWmi(output) {
  try {
    const parsed = JSON.parse(String(output));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((item) => item && typeof item.Name === 'string')
      .map((item) => ({
        name: item.Name,
        adapterRamMb: Number.isFinite(item.AdapterRAM) ? Math.round(item.AdapterRAM / MB) : null,
      }));
  } catch {
    return [];
  }
}

async function attempt(promise) {
  try {
    return await promise;
  } catch {
    return null;
  }
}

const NVIDIA_ARGS = ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader'];
const WMI_COMMAND = 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress';

// [{ name, kind: 'dedicated'|'integrated', totalMb, usedMb }]. WMI AdapterRAM is capped at 4 GB, so
// nvidia-smi wins for memory whenever it knows the card.
export async function detectGpus({ exec = defaultExec } = {}) {
  const smi = parseNvidiaSmi((await attempt(exec('nvidia-smi', NVIDIA_ARGS))) ?? '');
  const wmi = parseWmi((await attempt(exec('powershell', ['-NoProfile', '-Command', WMI_COMMAND]))) ?? '');

  const gpus = smi.map((gpu) => ({ ...gpu, kind: 'dedicated' }));
  for (const adapter of wmi) {
    if (smi.some((gpu) => gpu.name === adapter.name)) continue;
    const kind = classifyGpu(adapter.name);
    gpus.push({
      name: adapter.name,
      kind,
      totalMb: kind === 'dedicated' ? adapter.adapterRamMb : null,
      usedMb: null,
    });
  }
  return gpus;
}

export function bestGpu(gpus) {
  return [...gpus].filter((gpu) => gpu.kind === 'dedicated').sort((a, b) => (b.totalMb ?? 0) - (a.totalMb ?? 0))[0] ?? null;
}

export function gpuBanner(gpus) {
  const card = bestGpu(gpus);
  if (!card) {
    return {
      hasDedicated: false,
      text: 'No tienes tarjeta de video dedicada: los modelos locales usarán el procesador y la memoria RAM (más lento).',
    };
  }
  const gb = card.totalMb ? ` (${Math.round(card.totalMb / 1024)} GB)` : '';
  return {
    hasDedicated: true,
    text: `Tienes tarjeta de video: ${card.name}${gb}. Los modelos locales usarán la tarjeta de video.`,
  };
}

// Live usage: system RAM plus GPU memory when nvidia-smi answers.
export async function readResources({ exec = defaultExec, totalmem = os.totalmem, freemem = os.freemem } = {}) {
  const smi = parseNvidiaSmi((await attempt(exec('nvidia-smi', NVIDIA_ARGS))) ?? '');
  const total = totalmem();
  return {
    ram: { totalMb: Math.round(total / MB), usedMb: Math.round((total - freemem()) / MB) },
    gpus: smi,
  };
}
