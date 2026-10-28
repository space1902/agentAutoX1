// Merges phone -> pod -> tester -> profiles -> group for the read-only "Números" view.
import type { Pod, WarmupData } from "./api";

export interface NumberRow {
  key: string;
  phone: string;
  pod: string | null;
  instanceId: string | null;
  testerId: string | null;
  profiles: string[];
  groups: string[];
}

/** Numbers appear with and without country code; the last 10 digits identify a line. */
export function phoneKey(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

export function buildNumberRows(
  podsWsp: Record<string, string>,
  pods: Pod[],
  warmup: WarmupData | null,
): NumberRow[] {
  const rows = new Map<string, NumberRow>();
  const ensure = (phone: string): NumberRow => {
    const key = phoneKey(phone);
    let row = rows.get(key);
    if (!row) {
      row = { key, phone, pod: null, instanceId: null, testerId: null, profiles: [], groups: [] };
      rows.set(key, row);
    }
    return row;
  };

  const podNames = new Map(pods.map((p) => [p.instanceId, p.name]));
  for (const [instanceId, phone] of Object.entries(podsWsp)) {
    if (!phoneKey(phone)) continue;
    const row = ensure(phone);
    row.instanceId = instanceId;
    row.pod = podNames.get(instanceId) ?? null;
  }

  for (const tester of warmup?.testers ?? []) {
    if (!tester.phone || !phoneKey(tester.phone)) continue;
    const row = ensure(tester.phone);
    row.testerId = tester.id;
    for (const profile of warmup?.profiles ?? []) {
      if (!profile.testers.includes(tester.id)) continue;
      row.profiles.push(profile.name);
      const group = profile.groupName ?? warmup?.defaultGroup ?? null;
      if (group && !row.groups.includes(group)) row.groups.push(group);
    }
  }

  return [...rows.values()].sort((a, b) => a.phone.localeCompare(b.phone));
}
