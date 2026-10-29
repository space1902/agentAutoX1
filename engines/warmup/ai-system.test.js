import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyGpu,
  detectGpus,
  gpuBanner,
  parseNvidiaSmi,
  parseWmi,
  readResources,
} from './ai-system.js';

test('classifyGpu separates dedicated cards from integrated and virtual adapters', () => {
  assert.equal(classifyGpu('NVIDIA GeForce RTX 5070 Laptop GPU'), 'dedicated');
  assert.equal(classifyGpu('AMD Radeon RX 7600'), 'dedicated');
  assert.equal(classifyGpu('Intel(R) Arc(TM) A380 Graphics'), 'dedicated');
  assert.equal(classifyGpu('Intel(R) UHD Graphics 620'), 'integrated');
  assert.equal(classifyGpu('AMD Radeon(TM) Graphics'), 'integrated');
  assert.equal(classifyGpu('Microsoft Basic Display Adapter'), 'integrated');
});

test('parseNvidiaSmi reads name, total and used memory in MiB', () => {
  const out = 'NVIDIA GeForce RTX 5070 Laptop GPU, 8151 MiB, 1203 MiB\n';
  assert.deepEqual(parseNvidiaSmi(out), [
    { name: 'NVIDIA GeForce RTX 5070 Laptop GPU', totalMb: 8151, usedMb: 1203 },
  ]);
  assert.deepEqual(parseNvidiaSmi(''), []);
  assert.deepEqual(parseNvidiaSmi('garbage'), []);
});

test('parseWmi accepts one object or an array', () => {
  const one = JSON.stringify({ Name: 'Intel(R) UHD Graphics', AdapterRAM: 1073741824 });
  assert.deepEqual(parseWmi(one), [{ name: 'Intel(R) UHD Graphics', adapterRamMb: 1024 }]);
  const many = JSON.stringify([{ Name: 'A', AdapterRAM: null }, { Name: 'B', AdapterRAM: 2147483648 }]);
  assert.deepEqual(parseWmi(many).map((g) => g.name), ['A', 'B']);
  assert.deepEqual(parseWmi('nope'), []);
});

test('detectGpus prefers nvidia-smi memory and keeps integrated adapters from WMI', async () => {
  const exec = async (file) => {
    if (file === 'nvidia-smi') return 'NVIDIA GeForce RTX 5070 Laptop GPU, 8151 MiB, 1000 MiB\n';
    return JSON.stringify([
      { Name: 'Intel(R) UHD Graphics', AdapterRAM: 1073741824 },
      { Name: 'NVIDIA GeForce RTX 5070 Laptop GPU', AdapterRAM: 4293918720 },
    ]);
  };
  const gpus = await detectGpus({ exec });
  assert.equal(gpus.length, 2);
  const nvidia = gpus.find((g) => g.kind === 'dedicated');
  assert.equal(nvidia.totalMb, 8151);
  assert.equal(nvidia.usedMb, 1000);
  assert.equal(gpus.find((g) => g.kind === 'integrated').name, 'Intel(R) UHD Graphics');
});

test('detectGpus survives missing tools', async () => {
  const exec = async () => {
    throw new Error('ENOENT');
  };
  assert.deepEqual(await detectGpus({ exec }), []);
});

test('gpuBanner explains where local models will run', () => {
  const withCard = gpuBanner([{ name: 'NVIDIA GeForce RTX 5070 Laptop GPU', kind: 'dedicated', totalMb: 8151, usedMb: 0 }]);
  assert.equal(withCard.hasDedicated, true);
  assert.equal(
    withCard.text,
    'Tienes tarjeta de video: NVIDIA GeForce RTX 5070 Laptop GPU (8 GB). Los modelos locales usarán la tarjeta de video.',
  );
  const without = gpuBanner([{ name: 'Intel(R) UHD Graphics', kind: 'integrated', totalMb: null, usedMb: null }]);
  assert.equal(without.hasDedicated, false);
  assert.equal(
    without.text,
    'No tienes tarjeta de video dedicada: los modelos locales usarán el procesador y la memoria RAM (más lento).',
  );
  assert.equal(gpuBanner([]).hasDedicated, false);
});

test('readResources reports system RAM and GPU memory', async () => {
  const exec = async () => 'NVIDIA GeForce RTX 5070 Laptop GPU, 8151 MiB, 2000 MiB\n';
  const res = await readResources({ exec, totalmem: () => 16 * 1024 ** 3, freemem: () => 6 * 1024 ** 3 });
  assert.equal(res.ram.totalMb, 16384);
  assert.equal(res.ram.usedMb, 10240);
  assert.equal(res.gpus[0].usedMb, 2000);
});
