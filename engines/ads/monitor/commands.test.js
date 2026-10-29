import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, parseNumber } from './commands.js';

test('approve / reject with a numeric id, any case, with or without accent', () => {
  assert.deepEqual(parseCommand('SI 12'), { type: 'approve', id: 12 });
  assert.deepEqual(parseCommand('  si   7 '), { type: 'approve', id: 7 });
  assert.deepEqual(parseCommand('Sí 3'), { type: 'approve', id: 3 });
  assert.deepEqual(parseCommand('NO 4'), { type: 'reject', id: 4 });
  assert.deepEqual(parseCommand('no 4.'), { type: 'reject', id: 4 });
});

test('approve / reject without an id keep the intent so the bot can ask', () => {
  assert.deepEqual(parseCommand('si'), { type: 'approve', id: null });
  assert.deepEqual(parseCommand('NO'), { type: 'reject', id: null });
});

test('ACEPTAR applies a recommendation', () => {
  assert.deepEqual(parseCommand('aceptar 5'), { type: 'accept', id: 5 });
  assert.deepEqual(parseCommand('ACEPTAR'), { type: 'accept', id: null });
});

test('valor <name> <number> sets a threshold', () => {
  assert.deepEqual(parseCommand('valor revisar 3000'), { type: 'set', name: 'revisar', value: 3000 });
  assert.deepEqual(parseCommand('Valor frecuencia 2,5'), { type: 'set', name: 'frecuencia', value: 2.5 });
  assert.deepEqual(parseCommand('valor objetivo 2.500'), { type: 'set', name: 'objetivo', value: 2500 });
});

test('valor with missing or invalid number is an error, not a silent no-op', () => {
  assert.equal(parseCommand('valor revisar').type, 'invalid');
  assert.equal(parseCommand('valor revisar mucho').type, 'invalid');
  assert.equal(parseCommand('valor').type, 'invalid');
});

test('simple commands', () => {
  assert.deepEqual(parseCommand('estado'), { type: 'status' });
  assert.deepEqual(parseCommand('ESTADO!'), { type: 'status' });
  assert.deepEqual(parseCommand('ayuda'), { type: 'help' });
  assert.deepEqual(parseCommand('DETENER'), { type: 'stop' });
  assert.deepEqual(parseCommand('reanudar'), { type: 'resume' });
});

test('pausa alertas <min>', () => {
  assert.deepEqual(parseCommand('pausa alertas 30'), { type: 'pause_alerts', minutes: 30 });
  assert.deepEqual(parseCommand('PAUSA ALERTAS 0'), { type: 'pause_alerts', minutes: 0 });
  assert.equal(parseCommand('pausa alertas').type, 'invalid');
  assert.equal(parseCommand('pausa alertas -5').type, 'invalid');
});

test('anything else is unknown', () => {
  assert.deepEqual(parseCommand('hola'), { type: 'unknown' });
  assert.deepEqual(parseCommand(''), { type: 'unknown' });
  assert.deepEqual(parseCommand(null), { type: 'unknown' });
  assert.deepEqual(parseCommand('si 12 gracias por todo'), { type: 'unknown' });
});

test('parseNumber handles decimals and thousands separators', () => {
  assert.equal(parseNumber('3000'), 3000);
  assert.equal(parseNumber('2,5'), 2.5);
  assert.equal(parseNumber('2.5'), 2.5);
  assert.equal(parseNumber('1.000'), 1000);
  assert.equal(parseNumber('x'), null);
});
