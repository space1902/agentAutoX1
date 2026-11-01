// One-shot hand-off of the ElevenLabs key from the turn process to the creativo MCP server.
//
// Why not an environment variable for Claude Code: the probe in docs/creativo showed Claude Code gives its WHOLE env to MCP
// servers, and the Bash tool inherits it too, so a script written by the agent could read the key and call ElevenLabs
// without any approval. Instead the turn process (which got the key from the Windows keyring through the app) keeps it
// in memory, listens on 127.0.0.1 and gives it exactly once to whoever presents a random nonce (the MCP server, which
// starts before the model can run anything). The nonce travels only in the per-turn MCP config; after the first
// successful read, or after a short timeout, the listener is gone.
import crypto from 'node:crypto';
import net from 'node:net';

const NONCE_BYTES = 24;

/** @returns {Promise<{ port: number, nonce: string, close: () => void, served: () => boolean }>} */
export function startKeyBroker({ key, ttlMs = 60_000 } = {}) {
  const nonce = crypto.randomBytes(NONCE_BYTES).toString('hex');
  let served = false;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setTimeout(5_000, () => socket.destroy());
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const sent = buffer.split('\n')[0].trim();
      const same = sent.length === nonce.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(nonce));
      if (same && !served) {
        served = true;
        socket.end(`${JSON.stringify({ key })}\n`, () => close());
      } else socket.destroy();
    });
  });
  const timer = setTimeout(() => close(), ttlMs);
  timer.unref?.();
  function close() {
    clearTimeout(timer);
    for (const s of sockets) s.destroy();
    server.close();
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, nonce, close, served: () => served }));
  });
}

/** Reads the key from the broker. Resolves '' when it cannot (the voice tool then reports a missing key). */
export function fetchKeyFromBroker({ port, nonce, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    if (!port || !nonce) return resolve('');
    const socket = net.connect({ port: Number(port), host: '127.0.0.1' });
    let data = '';
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(''));
    socket.on('error', () => done(''));
    socket.on('connect', () => socket.write(`${nonce}\n`));
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => {
      try {
        done(String(JSON.parse(data.trim()).key ?? ''));
      } catch {
        done('');
      }
    });
  });
}
