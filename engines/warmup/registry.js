// Unified number registry: one row per normalised phone, merging pods, warm-up testers,
// linked sessions and profiles. Pure functions (everything is injected), so it is unit-tested.
import { profileGroupName } from './session-selection.js';

// Numbers show up with and without the country code. Colombian lines are 12 digits starting with 57
// or 10 digits; both map to the same 10-digit key. Anything else is compared as plain digits.
export function phoneKey(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('57')) return digits.slice(2);
  return digits;
}

export function botKeys(config) {
  return [config?.botNumber, config?.bot?.phone].map(phoneKey).filter(Boolean);
}

const testerEntries = (config) =>
  (Array.isArray(config?.testers) ? config.testers : [])
    .map((entry) => (typeof entry === 'string' ? { id: entry } : entry))
    .filter((entry) => entry && typeof entry.id === 'string' && entry.id.trim() !== '');

export function buildRegistry({ config, profiles = {}, pods = [], hasSession = () => false, sessionPhoneOf = () => null }) {
  const rows = new Map();
  const bots = new Set(botKeys(config));
  const podsWithoutPhone = [];
  const testersWithoutPhone = [];
  const testers = {};

  // Profiles (and their groups) that use a tester.
  const usage = (id) => {
    const used = { profiles: [], groups: [] };
    for (const [name, profile] of Object.entries(profiles)) {
      if (!(profile?.testers ?? []).includes(id)) continue;
      used.profiles.push(name);
      const group = profileGroupName(profile, config);
      if (group && !used.groups.includes(group)) used.groups.push(group);
    }
    return used;
  };

  const ensure = (phone) => {
    const key = phoneKey(phone);
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        phone: String(phone),
        pod: null,
        extraPods: [],
        testerId: null,
        linked: false,
        profiles: [],
        groups: [],
        source: 'externo',
        isBot: bots.has(key),
        phoneSource: null,
        duplicateOf: [],
      });
    }
    return rows.get(key);
  };

  for (const pod of pods) {
    if (!phoneKey(pod.phone)) {
      podsWithoutPhone.push({ name: pod.name, instanceId: pod.instanceId, state: pod.state });
      continue;
    }
    const row = ensure(pod.phone);
    const info = { name: pod.name, instanceId: pod.instanceId, state: pod.state };
    if (row.pod) row.extraPods.push(pod.name);
    else {
      row.pod = info;
      row.source = 'pod sin calentar';
    }
  }

  // Effective phone of a tester: the configured one, else the one of its linked session.
  const infos = testerEntries(config).map((tester) => {
    const configPhone = phoneKey(tester.phone) ? String(tester.phone) : null;
    const sessionPhone = phoneKey(sessionPhoneOf(tester.id)) ? String(sessionPhoneOf(tester.id)) : null;
    const phone = configPhone ?? sessionPhone;
    return {
      id: tester.id,
      phone,
      configPhone,
      sessionPhone,
      phoneSource: configPhone ? 'config' : sessionPhone ? 'session' : null,
      linked: Boolean(hasSession(tester.id)),
      mismatch: Boolean(configPhone && sessionPhone && phoneKey(configPhone) !== phoneKey(sessionPhone)),
      duplicateOf: [],
    };
  });

  // Anyone (testers and the bot) grouped by normalised number, to flag repeated lines.
  const botPhone = botKeys(config)[0] ?? phoneKey(sessionPhoneOf('bot'));
  const groups = new Map();
  const addMember = (key, phone, member) => {
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { key, phone, members: [] });
    groups.get(key).members.push(member);
  };
  if (botPhone) addMember(botPhone, config?.botNumber ? String(config.botNumber) : `57${botPhone}`, 'bot');
  for (const info of infos) addMember(phoneKey(info.phone), info.phone, info.id);
  const duplicates = [...groups.values()].filter((g) => g.members.length > 1).sort((a, b) => a.key.localeCompare(b.key));
  for (const group of duplicates) {
    for (const info of infos) {
      if (group.members.includes(info.id)) info.duplicateOf = group.members.filter((m) => m !== info.id);
    }
  }
  for (const info of infos) testers[info.id] = info;

  for (const info of infos) {
    if (!info.phone) {
      testersWithoutPhone.push({ id: info.id, linked: Boolean(hasSession(info.id)), ...usage(info.id) });
      continue;
    }
    const row = ensure(info.phone);
    if (row.testerId) continue; // duplicated phone: the first tester wins the row; the rest show in duplicateOf
    row.testerId = info.id;
    row.linked = Boolean(hasSession(info.id));
    row.phoneSource = info.phoneSource;
    row.duplicateOf = info.duplicateOf;
    if (row.pod) row.source = 'pod';
    Object.assign(row, usage(info.id));
  }

  const sorted = [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { rows: sorted, podsWithoutPhone, testersWithoutPhone, testers, duplicates };
}
