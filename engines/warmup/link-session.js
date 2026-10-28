// Links ONE tester session to WhatsApp with a pairing code (no QR), for the desktop app's "link pods" flow.
// It starts a Baileys client for the tester's phone, reports the 8-character code through `emit`, and
// finishes when the session credentials were saved. The code is typed into the pod by pod-driver.js.
// Tests never touch real WhatsApp: the client factory is injected.
import path from 'node:path';

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// emit({ event: 'already-linked' | 'code' | 'linked', ... });
// returns { status: 'linked' | 'already-linked' | 'error', code?, message? }
export async function linkSession({
  id,
  phone,
  authRoot,
  resultsDir,
  clientFactory,
  hasSession,
  emit = () => {},
  timeoutMs = 5 * 60_000,
  readyCheckMs = 10_000,
  sleep = sleepMs,
}) {
  if (hasSession(id)) {
    emit({ event: 'already-linked' });
    return { status: 'already-linked' };
  }
  if (!phone) {
    return { status: 'error', code: 'NO_PHONE', message: `El tester «${id}» no tiene número de teléfono: no se puede pedir un código.` };
  }

  const client = clientFactory({ id, authDir: path.join(authRoot, id), activityDir: resultsDir, phone });
  let finish;
  const outcome = new Promise((resolve) => {
    finish = resolve;
  });
  const fail = (code, message) => finish({ status: 'error', code, message });
  const timer = setTimeout(() => fail('TIMEOUT', 'Pasó el tiempo y el código no se escribió en el pod.'), timeoutMs);

  client.on('pairing_code', (code) => emit({ event: 'code', code }));
  client.on('qr', () =>
    fail('PAIRING_REFUSED', 'WhatsApp no entregó un código de vinculación para este número (pidió QR). Inténtalo de nuevo en unos minutos.'),
  );
  client.on('fatal', (reason) => fail('FATAL', `La sesión se cerró durante la vinculación (${reason}).`));
  client.on('logged_out', () => fail('LOGGED_OUT', 'WhatsApp cerró la sesión durante la vinculación.'));
  client.on('ready', async () => {
    // Credentials are written right after the pairing; wait for them instead of trusting the event alone.
    const deadline = Date.now() + readyCheckMs;
    for (;;) {
      if (hasSession(id)) return finish({ status: 'linked' });
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
    if (hasSession(id)) return finish({ status: 'linked' });
    fail('NOT_SAVED', 'WhatsApp conectó, pero la sesión no quedó guardada.');
  });

  try {
    await client.connect();
  } catch (error) {
    clearTimeout(timer);
    await client.destroy().catch(() => {});
    return { status: 'error', code: 'CONNECT_FAILED', message: `No se pudo conectar con WhatsApp: ${error?.message || error}` };
  }

  const result = await outcome;
  clearTimeout(timer);
  await Promise.race([client.destroy().catch(() => {}), sleep(15_000)]);
  if (result.status === 'linked') emit({ event: 'linked' });
  return result;
}
