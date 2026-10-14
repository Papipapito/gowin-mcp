import { spawn } from 'node:child_process';
import { utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const DEMO = join(FIXTURES, 'demo');
export const FAILING = join(FIXTURES, 'failing');
export const LEGACY = join(FIXTURES, 'legacy');
/** Every TNS row at 0.000, yet negative setup/hold paths between clock domains. */
export const XDOMAIN = join(FIXTURES, 'xdomain');
/** GW5AT-60: clk_54m misses its fMax with a setup TNS of 0 (multicycle + half-cycle paths); CLS 97.30% reported as 98%. */
export const FMAXONLY = join(FIXTURES, 'fmaxonly');
/** V1.9.12.04: timing only as the plain-text <name>.tr, no _tr_content.html. */
export const TRTEXT = join(FIXTURES, 'trtext');
export const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/**
 * Git does not keep mtimes, so the "which report is newest" cases pin them:
 * demo.rpt.txt is one day newer than stale.rpt.txt.
 */
export function pinFixtureTimes() {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  utimesSync(join(DEMO, 'impl', 'pnr', 'demo.rpt.txt'), now, now);
  utimesSync(join(DEMO, 'impl', 'pnr', 'stale.rpt.txt'), dayAgo, dayAgo);
}

/** Minimal MCP stdio client: enough to list tools and call them. */
export function startServer() {
  const proc = spawn(process.execPath, [join(DIST, 'index.js')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  const pending = new Map();
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let id = 0;
  const send = (method, params) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });

  const init = async () => {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  };

  /**
   * Calls a tool. `text` is the content; `structured` is the
   * structuredContent, present only with format "json"; `json` parses the
   * text when it is JSON.
   */
  const call = async (name, args) => {
    const r = await send('tools/call', { name, arguments: args });
    if (r.error) throw new Error(`rpc error: ${JSON.stringify(r.error)}`);
    const text = r.result.content.map((c) => c.text).join('\n');
    return {
      text,
      structured: r.result.structuredContent,
      json: args?.format === 'json' && !r.result.isError ? JSON.parse(text) : undefined,
      isError: r.result.isError === true,
    };
  };

  const listTools = async () => (await send('tools/list', {})).result.tools;

  return { init, call, listTools, close: () => proc.kill() };
}
