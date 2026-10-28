import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SELECTORS, centerOf, findNode, identifyScreen, nextAction, normalizeLabel, parseHierarchy } from './pod-ui.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'uia');
const load = (name) => parseHierarchy(fs.readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8'));

test('parseHierarchy reads text, content-desc, resource-id, class, clickable and bounds', () => {
  const nodes = load('linked-devices-es');
  const button = nodes.find((n) => n.resourceId.endsWith(':id/link_device_button'));
  assert.equal(button.text, 'Vincular un dispositivo');
  assert.equal(button.className, 'android.widget.Button');
  assert.equal(button.clickable, true);
  assert.deepEqual(button.bounds, { left: 60, top: 900, right: 660, bottom: 1000 });
  assert.deepEqual(centerOf(button), { x: 360, y: 950 });
  assert.equal(button.package, 'com.whatsapp.w4b');
});

test('parseHierarchy decodes XML entities and ignores garbage around the hierarchy', () => {
  const xml =
    'UI hierarchy dumped to: /dev/tty\n<?xml version="1.0"?><hierarchy><node text="Tom &amp; &quot;Jerry&quot; &#10;2" resource-id="" class="a" package="p" content-desc="" clickable="false" enabled="true" bounds="[0,0][10,10]" /></hierarchy>';
  const [node] = parseHierarchy(xml);
  assert.equal(node.text, 'Tom & "Jerry" \n2');
});

test('parseHierarchy returns [] for empty or non-xml output', () => {
  assert.deepEqual(parseHierarchy(''), []);
  assert.deepEqual(parseHierarchy('ERROR: could not get idle state.'), []);
});

test('normalizeLabel ignores case, accents-insensitive whitespace and trailing dots/ellipsis', () => {
  assert.equal(normalizeLabel('  Vincular   un dispositivo… '), 'vincular un dispositivo');
  assert.equal(normalizeLabel('Link a device.'), 'link a device');
});

test('findNode matches by text, content-desc and resource-id', () => {
  const chats = load('chats-es');
  const overflow = findNode(chats, SELECTORS.overflow);
  assert.equal(overflow.desc, 'Más opciones');
  assert.equal(findNode(chats, { text: ['no existe'] }), null);
  const scanner = load('link-scanner-es');
  assert.ok(findNode(scanner, { id: [/link_with_phone_number$/] }));
});

test('identifyScreen recognises each step in Spanish and English', () => {
  const expected = {
    'chats-es': 'chats',
    'chats-en': 'chats',
    'menu-es': 'menu',
    'menu-en': 'menu',
    'linked-devices-es': 'linked-devices',
    'linked-devices-en': 'linked-devices',
    'permission-camera-es': 'permission',
    'link-scanner-es': 'link-scanner',
    'link-scanner-en': 'link-scanner',
    'code-entry-es': 'code-entry',
    'code-entry-en': 'code-entry',
    'verify-es': 'verify',
    unknown: 'other-app',
    launcher: 'other-app',
  };
  for (const [name, screen] of Object.entries(expected)) assert.equal(identifyScreen(load(name)), screen, name);
  assert.equal(identifyScreen([]), 'unknown');
});

test('the Linked devices list is not mistaken for the overflow menu even though both show the same label', () => {
  assert.equal(identifyScreen(load('linked-devices-es')), 'linked-devices');
});

test('nextAction taps the right element on each screen', () => {
  const tapOf = (name, target) => {
    const action = nextAction(identifyScreen(load(name)), load(name), { code: 'ABCD1234' });
    assert.equal(action.type, 'tap', name);
    assert.equal(action.target, target, name);
    return action;
  };
  assert.deepEqual([tapOf('chats-es', 'overflow').x, tapOf('chats-es', 'overflow').y], [675, 70]);
  tapOf('menu-es', 'linkedDevices');
  tapOf('menu-en', 'linkedDevices');
  tapOf('linked-devices-es', 'linkDevice');
  tapOf('linked-devices-en', 'linkDevice');
  tapOf('permission-camera-es', 'permissionAllow');
  tapOf('link-scanner-es', 'linkWithPhone');
  tapOf('link-scanner-en', 'linkWithPhone');
});

test('nextAction types the code (without the dash) on the code screen, after focusing the field', () => {
  const nodes = load('code-entry-es');
  const action = nextAction('code-entry', nodes, { code: 'ABCD1234' });
  assert.deepEqual(action, { type: 'type', text: 'ABCD1234', focus: { x: 360, y: 470 } });
});

test('nextAction aborts with a manual hint on screens it cannot drive', () => {
  const verify = nextAction('verify', load('verify-es'), { code: 'ABCD1234' });
  assert.equal(verify.type, 'abort');
  assert.equal(verify.reason, 'VERIFY_REQUIRED');
  const other = nextAction('other-app', load('unknown'), { code: 'ABCD1234' });
  assert.equal(other.type, 'launch');
});

test('nextAction reports ELEMENT_NOT_FOUND when the expected element is missing', () => {
  // A chats screen without the overflow button (layout changed).
  const nodes = load('chats-es').filter((n) => n.desc !== 'Más opciones');
  const action = nextAction('chats', nodes, { code: 'ABCD1234' });
  assert.equal(action.type, 'abort');
  assert.equal(action.reason, 'ELEMENT_NOT_FOUND');
  assert.equal(action.target, 'overflow');
});
