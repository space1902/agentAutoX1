// When WhatsApp logs a number out, its saved session is useless. It is moved (never deleted)
// to .baileys_auth/_logged_out/<id>-<timestamp> so the number can be linked again from scratch.
import fs from 'node:fs';
import path from 'node:path';

export const LOGGED_OUT_DIR = '_logged_out';

// 2026-10-27T15:04:05.123Z -> 2026-10-27T15-04-05 (valid in Windows folder names)
const stamp = (now) => now.toISOString().slice(0, 19).replace(/:/g, '-');

// Returns the new folder, or null when the session folder does not exist.
export function archiveLoggedOutSession(authRoot, id, now = new Date()) {
  const source = path.join(authRoot, id);
  if (!fs.existsSync(source)) return null;

  const archiveRoot = path.join(authRoot, LOGGED_OUT_DIR);
  fs.mkdirSync(archiveRoot, { recursive: true });

  const base = `${id}-${stamp(now)}`;
  let dest = path.join(archiveRoot, base);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(archiveRoot, `${base}-${n}`);

  try {
    fs.renameSync(source, dest);
  } catch {
    // Windows can keep a file locked for a moment after the socket closes: copy first, and only
    // remove the original once the copy is complete.
    fs.cpSync(source, dest, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
  return dest;
}
