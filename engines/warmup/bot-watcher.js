// Keeps the bot's connection in line with its pause state. One tick is: close the socket while paused,
// reopen it when resumed. A connect can take a long time, so a tick never starts a second connect while one
// is still pending (a duplicate socket for the same session gets WhatsApp 440 "conflict" errors).
export function createBotWatcher({
  isPaused,
  isShuttingDown = () => false,
  getClient,
  stopClient,
  connect,
  now = Date.now,
  warn = console.warn,
  retryMs = 5 * 60_000,
}) {
  let connecting = false;
  let nextTryAt = 0;

  return {
    async tick() {
      if (isShuttingDown() || connecting) return;
      try {
        const client = getClient();
        if (isPaused()) {
          if (client && !client.stopped) await stopClient(client);
          return;
        }
        if ((!client || client.stopped) && now() >= nextTryAt) {
          connecting = true;
          try {
            await connect();
          } finally {
            connecting = false;
          }
        }
      } catch (error) {
        nextTryAt = now() + retryMs;
        warn(`[bot] could not reconnect (${error?.message || error}); retrying in ${Math.round(retryMs / 60_000)} min.`);
      }
    },
  };
}
