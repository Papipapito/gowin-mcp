import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { DEMO, FAILING, FIXTURES, LEGACY, pinFixtureTimes, startServer } from './helpers.js';

let server;
before(async () => {
  pinFixtureTimes();
  server = startServer();
  await server.init();
});
after(() => server.close());

const TOOLS = [
  'gowin_list_builds',
  'gowin_summary',
  'gowin_resources',
  'gowin_timing',
  'gowin_check',
  'gowin_compare',
  'gowin_pins',
  'gowin_warnings',
];

test('tools/list: every tool has an input schema, an output schema and read-only annotations', async () => {
  const tools = await server.listTools();
  assert.deepEqual(tools.map((t) => t.name), TOOLS);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.outputSchema.type, 'object', t.name);
    assert.deepEqual(
      t.annotations,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      t.name,
    );
  }
});

test('gowin_check: unknown for a build without _tr_content.html, in text and JSON', async () => {
  const r = await server.call('gowin_check', { path: LEGACY });
  assert.equal(r.isError, false);
  assert.match(r.text, /^UNKNOWN — timing not verified/);
  assert.equal(r.structured.status, 'unknown');
  assert.equal(r.structured.ok, false);
  assert.equal(r.structured.timing.status, 'unknown');

  const json = await server.call('gowin_check', { path: LEGACY, format: 'json' });
  assert.equal(JSON.parse(json.text).status, 'unknown');
});

test('gowin_check: pass, fail and thresholds', async () => {
  const pass = await server.call('gowin_check', { path: DEMO });
  assert.match(pass.text, /^PASS/);
  assert.equal(pass.structured.status, 'pass');

  const fail = await server.call('gowin_check', { path: FAILING });
  assert.match(fail.text, /^FAIL — 1 timing violation/);
  assert.match(fail.text, /setup clk_eng/);
  assert.equal(fail.structured.status, 'fail');

  const thr = await server.call('gowin_check', { path: DEMO, maxUtilization: 60 });
  assert.equal(thr.structured.status, 'fail');
  assert.match(thr.text, /CLS at 77% exceeds maxUtilization 60%/);
});

test('gowin_summary: picks the newest build and says which others exist', async () => {
  const r = await server.call('gowin_summary', { path: DEMO });
  assert.match(r.text, /^Build: demo/);
  assert.match(r.text, /others: stale/);
  assert.equal(r.structured.status, 'pass');
  assert.equal(r.structured.clean, true);

  const named = await server.call('gowin_summary', { path: DEMO, name: 'stale' });
  assert.match(named.text, /^Build: stale/);
  assert.equal(named.structured.status, 'unknown');
  assert.equal(named.structured.clean, false);
});

test('gowin_timing: recovery/removal summarised, hold table is hold only', async () => {
  const r = await server.call('gowin_timing', { path: DEMO, maxPaths: 2 });
  assert.equal(r.structured.timing.holdPaths.length, 3);
  assert.equal(r.structured.timing.recoveryPaths.length, 3);
  assert.match(r.text, /Recovery: 3 paths, worst/);
  assert.match(r.text, /Removal: 3 paths, worst/);
});

test('gowin_list_builds: lists the fixtures with device and timing flag', async () => {
  const r = await server.call('gowin_list_builds', { root: FIXTURES });
  assert.equal(r.structured.builds.length, 4);
  assert.ok(r.structured.builds.every((b) => b.device === 'GW2AR-18'));
  assert.match(r.text, /legacy\s+.*\[no timing\]/);
});

test('gowin_pins and gowin_warnings over stdio', async () => {
  const pins = await server.call('gowin_pins', { path: DEMO, port: 'CART_*' });
  assert.ok(pins.structured.ports.length >= 1);
  assert.ok(pins.structured.ports.every((p) => p.port.startsWith('CART_')));
  assert.match(pins.text, /Global clock routing/);

  const warn = await server.call('gowin_warnings', { path: DEMO, level: 'error' });
  assert.deepEqual(warn.structured.groups.map((g) => g.code), ['CT1135']);
  assert.match(warn.text, /Clocks without a constraint \(TA1132\)/);
});

test('errors come back as tool errors, not protocol failures', async () => {
  const r = await server.call('gowin_check', { path: join(FIXTURES, 'nope') });
  assert.equal(r.isError, true);
  assert.match(r.text, /No Gowin build found/);
  const named = await server.call('gowin_summary', { path: DEMO, name: 'ghost' });
  assert.equal(named.isError, true);
  assert.match(named.text, /No build named "ghost"/);
});
