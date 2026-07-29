// End-to-end check: drives dist/index.js over stdio like a real MCP client.
import { spawn } from 'node:child_process';

const proc = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] });

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
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});

let id = 0;
const send = (method, params) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });

const call = async (name, args) => {
  const r = await send('tools/call', { name, arguments: args });
  if (r.error) return `ERROR ${JSON.stringify(r.error)}`;
  return r.result.content.map((c) => c.text).join('\n');
};

const target = process.argv[2] ?? 'C:\\Users\\alber\\proyectosAI\\msx\\MSX_up\\fpga';

await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});
proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const tools = await send('tools/list', {});
console.log('=== TOOLS ===');
for (const t of tools.result.tools) console.log(' -', t.name);

console.log('\n=== gowin_summary ===');
console.log(await call('gowin_summary', { path: target }));

console.log('\n=== gowin_check ===');
console.log(await call('gowin_check', { path: target }));

console.log('\n=== gowin_check (bad path) ===');
console.log(await call('gowin_check', { path: 'C:\\nope\\nothing' }));

proc.kill();
