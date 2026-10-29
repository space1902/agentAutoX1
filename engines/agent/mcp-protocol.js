// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), enough for Claude Code: initialize, ping,
// tools/list and tools/call. Written by hand to keep the engine dependency-free; the protocol surface is tiny.
import readline from 'node:readline';

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

const textResult = (value, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

/**
 * @param {{ name: string, version: string, tools: { name: string, description: string, inputSchema: object, handler: (args: object) => Promise<object> | object }[] }} options
 * Handlers return a JSON-able value, or `{ error: string, ... }` to flag a tool-level failure the model can read and fix.
 */
export function createMcpServer({ name, version, tools }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    /** Handles one decoded message; resolves to the response to send, or null for notifications. */
    async handle(message) {
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        return message?.id !== undefined ? rpcError(message.id, -32600, 'Invalid request') : null;
      }
      const { id, method, params } = message;
      const isNotification = id === undefined || id === null;
      if (isNotification) return null; // notifications/initialized, notifications/cancelled...
      switch (method) {
        case 'initialize': {
          const asked = params?.protocolVersion;
          return rpcResult(id, {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
          });
        }
        case 'ping':
          return rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, { tools: tools.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })) });
        case 'tools/call': {
          const tool = byName.get(params?.name);
          if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
          try {
            const out = await tool.handler(params?.arguments ?? {});
            const failed = out && typeof out === 'object' && typeof out.error === 'string';
            return rpcResult(id, textResult(out, failed));
          } catch (error) {
            return rpcResult(id, textResult({ error: String(error?.message ?? error) }, true));
          }
        }
        default:
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    },
  };
}

/** Reads one JSON message per line from `input` and writes responses to `output`. Resolves when input ends. */
export function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const job = (async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
        return;
      }
      const response = await server.handle(message);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    })();
    pending.add(job);
    job.finally(() => pending.delete(job));
  });
  return new Promise((resolve) => rl.on('close', () => Promise.allSettled([...pending]).then(resolve)));
}
