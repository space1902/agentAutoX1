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

export function buildRegistry({ config, profiles = {}, pods = [], hasSession = () => false }) {
  const rows = new Map();
  const bots = new Set(botKeys(config));
  const podsWithoutPhone = [];
  const testersWithoutPhone = [];

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

  for (const tester of testerEntries(config)) {
    if (!phoneKey(tester.phone)) {
      testersWithoutPhone.push({ id: tester.id, linked: Boolean(hasSession(tester.id)), ...usage(tester.id) });
      continue;
    }
    const row = ensure(tester.phone);
    if (row.testerId) continue; // duplicated phone in config: the first tester wins
    row.testerId = tester.id;
    row.linked = Boolean(hasSession(tester.id));
    if (row.pod) row.source = 'pod';
    Object.assign(row, usage(tester.id));
  }

  const sorted = [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { rows: sorted, podsWithoutPhone, testersWithoutPhone };
}
