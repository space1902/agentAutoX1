// Makes sure every tester session belongs to the warm-up group before the run starts.
// The bot session (admin of the group) lists the members and adds the missing testers; if WhatsApp
// refuses (privacy settings, rate limits), the tester joins with the group's invite link instead.
// A tester that cannot get in is skipped, so it does not fail every turn with "forbidden".
//
// Membership is compared by phone number (phone jids and @lid participants that carry a
// phoneNumber) and by the tester's own LID. If neither matches the tester is simply "not found",
// which is handled as "try to add": adding an existing member answers 409 and is harmless.
const ADDED = '200';
const ALREADY_MEMBER = '409';
const PAUSE_BETWEEN_ADDS_MS = 2000;

const defaultPause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reason = (error) => error?.message || String(error);

// Returns { ready: sessions allowed to send, skipped: sessions that must not send }.
export async function ensureTestersInGroup({
  botClient,
  groupId,
  groupName,
  sessions,
  log = console.log,
  warn = console.warn,
  pause = defaultPause,
}) {
  let members = { phones: [], lids: [] };
  try {
    members = await botClient.groupMembers(groupId);
  } catch (error) {
    warn(`[bot] could not read the members of "${groupName}" (${reason(error)}); trying to add every tester.`);
  }
  const phones = new Set(members.phones);
  const lids = new Set(members.lids);

  const ready = [];
  const skipped = [];
  let addedAny = false;

  for (const session of sessions) {
    const phone = session.client.info?.wid?.user || '';
    const lid = session.client.info?.wid?.lid || '';

    if (!phone) {
      warn(`[${session.id}] its WhatsApp number is unknown, so it cannot be checked in "${groupName}"; skipping it.`);
      skipped.push(session);
      continue;
    }

    if (phones.has(phone) || (lid && lids.has(lid))) {
      ready.push(session);
      continue;
    }

    if (addedAny) await pause(PAUSE_BETWEEN_ADDS_MS);
    addedAny = true;

    const outcome = await joinGroup({ botClient, groupId, groupName, session, phone, log });
    if (outcome) {
      ready.push(session);
    } else {
      warn(
        `[${session.id}] is not in "${groupName}" and could not be added automatically. ` +
          `Add +${phone} to the group from the admin phone.`,
      );
      skipped.push(session);
    }
  }

  return { ready, skipped };
}

// true when the tester is (now) in the group.
async function joinGroup({ botClient, groupId, groupName, session, phone, log }) {
  try {
    const [result] = await botClient.addToGroup(groupId, [phone]);
    if (result?.status === ADDED) {
      log(`[${session.id}] added to "${groupName}" by the bot`);
      return true;
    }
    if (result?.status === ALREADY_MEMBER) return true;
  } catch {
    // Fall through to the invite link.
  }

  try {
    const code = await botClient.inviteCode(groupId);
    if (!code) return false;
    await session.client.joinByInvite(code);
    log(`[${session.id}] joined "${groupName}" with the invite link`);
    return true;
  } catch {
    return false;
  }
}
