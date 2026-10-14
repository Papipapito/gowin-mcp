// Manual end-to-end check against a real build: drives dist/index.js over
// stdio like an MCP client would.
// Usage: node tests/stdio.mjs <path-to-project-or-impl-dir>
import { startServer } from './helpers.js';

const target = process.argv[2];
if (!target) {
  console.error('usage: node tests/stdio.mjs <path-to-project-or-impl-dir>');
  process.exit(1);
}

const server = startServer();
await server.init();

console.log('=== TOOLS ===');
for (const t of await server.listTools()) console.log(' -', t.name);

for (const [tool, args] of [
  ['gowin_summary', { path: target }],
  ['gowin_check', { path: target }],
  ['gowin_warnings', { path: target, maxGroups: 5 }],
  ['gowin_check', { path: 'C:\\nope\\nothing' }],
]) {
  console.log(`\n=== ${tool} ${JSON.stringify(args)} ===`);
  console.log((await server.call(tool, args)).text);
}

server.close();
