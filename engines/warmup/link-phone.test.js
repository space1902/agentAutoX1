import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isQrMode,
  normalizeLinkPhone,
  parsePhoneHints,
  persistTesterPhone,
  readBackupPhone,
  resolveLinkPhone,
  withTesterPhone,
} from './link-phone.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'link-phone-'));

function writeCreds(dir, meId) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ me: { id: meId }, secret: 'x' }));
}

test('normalizeLinkPhone keeps digits and prefixes 57 to 10-digit Colombian mobiles', () => {
  assert.equal(normalizeLinkPhone('300 123 4567'), '573001234567');
  assert.equal(normalizeLinkPhone('+57 316 213 5114'), '573162135114');
  assert.equal(normalizeLinkPhone(573162135114), '573162135114');
  assert.equal(normalizeLinkPhone('+52 55 1234 5678'), '525512345678');
  assert.equal(normalizeLinkPhone('123'), null);
  assert.equal(normalizeLinkPhone(null), null);
});

test('isQrMode only turns on with an explicit LINK_MODE=qr', () => {
  assert.equal(isQrMode(undefined), false);
  assert.equal(isQrMode(''), false);
  assert.equal(isQrMode('code'), false);
  assert.equal(isQrMode('QR'), true);
  assert.equal(isQrMode(' qr '), true);
});

test('parsePhoneHints reads a JSON map of id -> phone and ignores garbage', () => {
  assert.deepEqual(parsePhoneHints('{"tester1":"316 213 5114","bad":"1"}'), { tester1: '573162135114' });
  assert.deepEqual(parsePhoneHints('not json'), {});
  assert.deepEqual(parsePhoneHints(undefined), {});
  assert.deepEqual(parsePhoneHints('[1,2]'), {});
});

test('readBackupPhone picks the most recent _logged_out or _unlinked backup of that exact id', () => {
  const root = tmp();
  writeCreds(path.join(root, '_logged_out', 'tester1-2026-10-28T10-00-00'), '573000000001:3@s.whatsapp.net');
  writeCreds(path.join(root, '_logged_out', 'tester1-2026-10-29T13-38-53'), '573162135114:12@s.whatsapp.net');
  writeCreds(path.join(root, '_unlinked', 'tester1-20261027-083621'), '573000000002@s.whatsapp.net');
  writeCreds(path.join(root, '_logged_out', 'tester10-2026-10-30T10-00-00'), '573999999999:1@s.whatsapp.net');

  assert.equal(readBackupPhone(root, 'tester1'), '573162135114');
  assert.equal(readBackupPhone(root, 'tester10'), '573999999999');
  assert.equal(readBackupPhone(root, 'tester2'), null);
});

test('readBackupPhone compares both folders by date and skips backups without a usable me.id', () => {
  const root = tmp();
  writeCreds(path.join(root, '_unlinked', 'tester2-20261029-083621'), '573162135114:5@s.whatsapp.net');
  writeCreds(path.join(root, '_logged_out', 'tester2-2026-10-28T09-00-00'), '573000000003:1@s.whatsapp.net');
  writeCreds(path.join(root, '_logged_out', 'tester2-2026-10-30T09-00-00'), 'garbage');

  assert.equal(readBackupPhone(root, 'tester2'), '573162135114');
  assert.equal(readBackupPhone(path.join(root, 'missing'), 'tester2'), null);
});

test('resolveLinkPhone follows config > session > backup > hint', () => {
  const root = tmp();
  writeCreds(path.join(root, 'tester1'), '573111111111:2@s.whatsapp.net');
  writeCreds(path.join(root, '_logged_out', 'tester2-2026-10-29T13-38-53'), '573222222222:2@s.whatsapp.net');
  const config = { testers: [{ id: 'tester1', phone: '300 000 0001' }, 'tester2', 'tester3', 'tester4'] };
  const hints = { tester3: '3003334444', tester1: '3009999999' };

  assert.deepEqual(resolveLinkPhone({ config, id: 'tester1', authRoot: root, hints }), {
    phone: '573000000001',
    source: 'config',
  });
  assert.deepEqual(resolveLinkPhone({ config: { testers: ['tester1'] }, id: 'tester1', authRoot: root, hints }), {
    phone: '573111111111',
    source: 'session',
  });
  assert.deepEqual(resolveLinkPhone({ config, id: 'tester2', authRoot: root, hints }), {
    phone: '573222222222',
    source: 'backup',
  });
  assert.deepEqual(resolveLinkPhone({ config, id: 'tester3', authRoot: root, hints }), {
    phone: '573003334444',
    source: 'hint',
  });
  assert.deepEqual(resolveLinkPhone({ config, id: 'tester4', authRoot: root, hints }), { phone: null, source: null });
});

test('resolveLinkPhone resolves the bot phone from config.bot.phone or botNumber', () => {
  const root = tmp();
  assert.equal(resolveLinkPhone({ config: { bot: { phone: '3162135114' } }, id: 'bot', authRoot: root }).phone, '573162135114');
  assert.equal(resolveLinkPhone({ config: { botNumber: '573162135114' }, id: 'bot', authRoot: root }).phone, '573162135114');
});

test('withTesterPhone sets the phone on object and string entries and never overwrites one', () => {
  const config = { groupName: 'g', testers: ['tester1', { id: 'tester2', persona: 'p' }, { id: 'tester3', phone: '573000000003' }] };
  const next = withTesterPhone(config, 'tester1', '573000000001');
  assert.deepEqual(next.testers[0], { id: 'tester1', phone: '573000000001' });
  assert.equal(next.groupName, 'g');
  assert.deepEqual(withTesterPhone(config, 'tester2', '573000000002').testers[1], {
    id: 'tester2',
    persona: 'p',
    phone: '573000000002',
  });
  assert.equal(withTesterPhone(config, 'tester3', '573999999999'), null);
  assert.equal(withTesterPhone(config, 'unknown', '573999999999'), null);
  assert.deepEqual(config.testers[0], 'tester1');
});

test('persistTesterPhone writes config.json atomically with a timestamped backup', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  const original = { groupName: 'g', groupIds: { g: 'x@g.us' }, testers: ['tester1', { id: 'tester2', phone: '573000000002' }] };
  fs.writeFileSync(file, JSON.stringify(original));

  const result = persistTesterPhone({ configFile: file, id: 'tester1', phone: '573162135114', now: new Date('2026-10-29T14:00:00.123Z') });
  assert.equal(result.status, 'saved');

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.testers[0], { id: 'tester1', phone: '573162135114' });
  assert.deepEqual(saved.groupIds, { g: 'x@g.us' });
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^config\.20261029-140000-123\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'backups', backups[0]), 'utf8')), original);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('persistTesterPhone does nothing when the tester already has a phone, is unknown, or the number is taken', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  const original = JSON.stringify({ botNumber: '573000000009', testers: ['tester1', { id: 'tester2', phone: '573000000002' }, { id: 'tester3', phone: '573000000003' }] });
  fs.writeFileSync(file, original);

  assert.equal(persistTesterPhone({ configFile: file, id: 'tester3', phone: '573111111111' }).status, 'has-phone');
  assert.equal(persistTesterPhone({ configFile: file, id: 'nope', phone: '573111111111' }).status, 'not-in-config');
  assert.equal(persistTesterPhone({ configFile: file, id: 'tester1', phone: '573000000002' }).status, 'duplicate');
  assert.equal(persistTesterPhone({ configFile: file, id: 'tester1', phone: '573000000009' }).status, 'duplicate');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
});

test('persistTesterPhone reports an unreadable config instead of throwing', () => {
  const result = persistTesterPhone({ configFile: path.join(tmp(), 'missing.json'), id: 'tester1', phone: '573162135114' });
  assert.equal(result.status, 'unreadable');
});
