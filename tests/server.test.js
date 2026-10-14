import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import * as S from '../dist/schemas.js';
import { DEMO, FAILING, FIXTURES, FMAXONLY, LEGACY, TRTEXT, XDOMAIN, pinFixtureTimes, startServer } from './helpers.js';

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

test('tools/list: every tool has an input schema, read-only annotations and no output schema', async () => {
  const tools = await server.listTools();
  assert.deepEqual(tools.map((t) => t.name), TOOLS);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.inputSchema.properties.format.enum.join(','), 'text,json', t.name);
    // An outputSchema would force structuredContent on every call, and
    // clients that understand it show the JSON instead of the text.
    assert.equal(t.outputSchema, undefined, t.name);
    assert.deepEqual(
      t.annotations,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      t.name,
    );
  }
});

test('format text returns the rendering alone; format json returns the JSON as text and as structuredContent', async () => {
  const text = await server.call('gowin_check', { path: LEGACY });
  assert.equal(text.isError, false);
  assert.match(text.text, /^UNKNOWN — timing not verified/);
  assert.equal(text.structured, undefined, 'no structuredContent in text mode');

  const json = await server.call('gowin_check', { path: LEGACY, format: 'json' });
  assert.equal(json.json.status, 'unknown');
  assert.equal(json.json.ok, false);
  assert.equal(json.json.timing.status, 'unknown');
  assert.deepEqual(json.structured, json.json, 'the same JSON both ways');
});

test('every tool\'s JSON matches its documented schema, with no undeclared fields', async () => {
  const cases = [
    ['gowin_list_builds', { root: FIXTURES }, S.ListOutput],
    ['gowin_summary', { path: DEMO }, S.BuildSummary],
    ['gowin_summary', { path: FMAXONLY }, S.BuildSummary],
    ['gowin_resources', { path: DEMO }, S.ResourceReport],
    ['gowin_timing', { path: DEMO }, S.TimingOutput],
    ['gowin_timing', { path: LEGACY }, S.TimingOutput],
    ['gowin_check', { path: FMAXONLY, fmaxWaivers: ['clk_54m'], maxUtilization: 99 }, S.CheckResult],
    ['gowin_check', { path: XDOMAIN, ignoreCrossDomain: true }, S.CheckResult],
    ['gowin_compare', { before: DEMO, after: FAILING }, S.BuildDiff],
    ['gowin_compare', { before: FMAXONLY, after: DEMO }, S.BuildDiff],
    ['gowin_pins', { path: DEMO, port: 'CART_*', includeUnused: true }, S.PinReport],
    ['gowin_warnings', { path: DEMO }, S.WarningsReport],
  ];
  for (const [tool, args, schema] of cases) {
    const r = await server.call(tool, { ...args, format: 'json' });
    assert.equal(r.isError, false, tool);
    // zod strips keys the schema does not declare, so a parse that comes
    // back deep-equal proves both the types and the key set.
    const parsed = schema.parse(r.json);
    assert.deepEqual(parsed, r.json, `${tool} ${JSON.stringify(args)}`);
  }
});

test('gowin_check: pass, fail and thresholds', async () => {
  const pass = await server.call('gowin_check', { path: DEMO });
  assert.match(pass.text, /^PASS/);
  assert.match(pass.text, /note: newest of 2 builds .*others: stale/);

  const fail = await server.call('gowin_check', { path: FAILING });
  assert.match(fail.text, /^FAIL — 1 timing violation/);
  assert.match(fail.text, /setup clk_eng/);
  assert.equal((await server.call('gowin_check', { path: FAILING, format: 'json' })).json.status, 'fail');

  const thr = await server.call('gowin_check', { path: DEMO, maxUtilization: 60, format: 'json' });
  assert.equal(thr.json.status, 'fail');
  assert.match(thr.text, /CLS at 76\.34% \(77% as the tool rounds it\) exceeds maxUtilization 60%/);
});

test('gowin_check: cross-domain paths the TNS omits fail, unless ignoreCrossDomain', async () => {
  const fail = await server.call('gowin_check', { path: XDOMAIN });
  assert.equal(fail.isError, false);
  assert.match(fail.text, /^FAIL — 5 timing violations/);
  assert.match(fail.text, /setup clock_54m -> clock_27m\s+-2\.09 ns/);
  assert.match(fail.text, /5 of these are not counted in Gowin's TNS summary/);
  assert.match(fail.text, /note: .*Gowin's TNS does not count paths between clock domains/);
  assert.match(fail.text, /set_false_path \/ set_clock_groups/);
  const failJson = (await server.call('gowin_check', { path: XDOMAIN, format: 'json' })).json;
  assert.equal(failJson.status, 'fail');
  assert.equal(failJson.violations[0].source, 'paths');
  assert.equal(failJson.violations[0].crossDomain, true);

  const pass = await server.call('gowin_check', { path: XDOMAIN, ignoreCrossDomain: true });
  assert.match(pass.text, /^PASS — no timing violations/);
  assert.match(pass.text, /ignored setup clock_54m -> clock_27m -2\.09 ns \(at least 14 paths\)/);
  assert.match(pass.text, /note: 5 cross-domain path violations ignored/);
  const passJson = (await server.call('gowin_check', { path: XDOMAIN, ignoreCrossDomain: true, format: 'json' })).json;
  assert.equal(passJson.status, 'pass');
  assert.equal(passJson.ok, true);
  assert.equal(passJson.ignoredViolations.length, 5);

  const summary = await server.call('gowin_summary', { path: XDOMAIN, format: 'json' });
  assert.equal(summary.json.status, 'fail');
  assert.match((await server.call('gowin_summary', { path: XDOMAIN })).text, /Timing: 5 VIOLATIONS/);

  const diff = await server.call('gowin_compare', { before: XDOMAIN, after: XDOMAIN, format: 'json' });
  assert.equal(diff.json.violations.persisting.length, 5);
  const diffText = (await server.call('gowin_compare', { before: XDOMAIN, after: XDOMAIN })).text;
  assert.match(diffText, /still\s+setup clock_54m -> clock_27m -2\.09ns/);
  assert.match(diffText, /VERDICT: no regression/);
});

test('gowin_check: an fMax-only violation explains itself and can be waived per clock', async () => {
  const fail = await server.call('gowin_check', { path: FMAXONLY });
  assert.match(fail.text, /^FAIL — 1 timing violation/);
  assert.match(fail.text, /fmax\s+clk_54m\s+-21\.541 MHz\s+32\.455 MHz achieved against a 53\.996 MHz constraint, with no setup violation reported \(setup TNS 0\.000\)/);
  assert.match(fail.text, /6 set_multicycle_path commands in the \.sdc name this clock/);
  assert.match(fail.text, /waive it with fmaxWaivers/);

  const pass = await server.call('gowin_check', { path: FMAXONLY, fmaxWaivers: ['clk_54m'] });
  assert.match(pass.text, /^PASS — no timing violations/);
  assert.match(pass.text, /ignored fmax clk_54m -21\.541 MHz/);
  assert.match(pass.text, /note: 1 fMax-only violation waived \(fmaxWaivers=\["clk_54m"\]\)/);
  const j = (await server.call('gowin_check', { path: FMAXONLY, fmaxWaivers: ['clk_54m'], format: 'json' })).json;
  assert.equal(j.status, 'pass');
  assert.deepEqual(j.thresholds.fmaxWaivers, ['clk_54m']);
  assert.deepEqual(j.ignoredViolations.map((v) => v.clock), ['clk_54m']);

  const summary = await server.call('gowin_summary', { path: FMAXONLY });
  assert.match(summary.text, /Build: fmaxonly  \(GW5AT-60/);
  assert.match(summary.text, /Bitstream: 0xDE97 checksum, body sha256 [0-9a-f]{12}…/);
  assert.match(summary.text, /Timing: 1 VIOLATION/);
  assert.match(summary.text, /clk_54m: 32\.455 MHz vs 53\.996 MHz constraint \(-21\.541\) \[FAIL\]/);
});

test('gowin_summary: picks the newest build and says which others exist, in text and JSON', async () => {
  const r = await server.call('gowin_summary', { path: DEMO });
  assert.match(r.text, /^Build: demo/);
  assert.match(r.text, /others: stale/);
  const j = (await server.call('gowin_summary', { path: DEMO, format: 'json' })).json;
  assert.equal(j.status, 'pass');
  assert.equal(j.clean, true);
  assert.deepEqual(j.siblings, ['stale']);
  assert.match(j.note, /newest of 2 builds/);
  assert.equal(j.bitstream.device, 'GW2AR-18');
  assert.equal(j.constraints.readable, false);

  const named = await server.call('gowin_summary', { path: DEMO, name: 'stale', format: 'json' });
  assert.match(named.text, /"name": "stale"/);
  assert.equal(named.json.status, 'unknown');
  assert.equal(named.json.clean, false);
  assert.equal(named.json.siblings, undefined);

  // The siblings note reaches every per-build tool.
  for (const tool of ['gowin_resources', 'gowin_timing', 'gowin_pins', 'gowin_warnings']) {
    const out = (await server.call(tool, { path: DEMO, format: 'json' })).json;
    assert.deepEqual(out.siblings, ['stale'], tool);
    assert.match(out.note, /pass name to pick one/, tool);
  }
});

test('gowin_timing: maxPaths and paths trim the JSON as well as the text', async () => {
  const two = await server.call('gowin_timing', { path: DEMO, maxPaths: 2, format: 'json' });
  const t = two.json.timing;
  assert.deepEqual(
    [t.setupPaths.length, t.holdPaths.length, t.recoveryPaths.length, t.removalPaths.length],
    [2, 2, 2, 2],
  );
  assert.deepEqual(two.json.paths, { mode: 'worst', maxPaths: 2, parsed: { setup: 3, hold: 3, recovery: 3, removal: 3 } });
  assert.equal(t.worstHold.slack, 0.074);
  assert.ok(t.setupPaths[0].slack <= t.setupPaths[1].slack, 'worst first');
  const text = (await server.call('gowin_timing', { path: DEMO, maxPaths: 2 })).text;
  assert.match(text, /Worst setup paths \(2 of 3\)/);
  assert.match(text, /Recovery: 3 paths, worst/);
  assert.match(text, /Removal: 3 paths, worst/);

  const all = (await server.call('gowin_timing', { path: DEMO, paths: 'all', format: 'json' })).json;
  assert.equal(all.timing.setupPaths.length, 3);
  assert.equal(all.paths.mode, 'all');
  assert.equal(all.paths.maxPaths, undefined);

  const none = await server.call('gowin_timing', { path: DEMO, paths: 'none', format: 'json' });
  assert.deepEqual(none.json.timing.setupPaths, []);
  assert.deepEqual(none.json.timing.removalPaths, []);
  assert.equal(none.json.timing.worstSetup.slack, all.timing.setupPaths[0].slack, 'worstSetup survives the trim');
  const noneText = (await server.call('gowin_timing', { path: DEMO, paths: 'none' })).text;
  assert.match(noneText, /Worst setup: /);
  assert.doesNotMatch(noneText, /Worst setup paths/);

  const fromTr = await server.call('gowin_timing', { path: TRTEXT, format: 'json' });
  assert.equal(fromTr.json.timing.format, 'text');
  assert.match((await server.call('gowin_timing', { path: TRTEXT })).text, /timing read from trtext\.tr — no _tr_content\.html/);
});

test('gowin_list_builds: lists the fixtures with device and timing flag', async () => {
  const r = await server.call('gowin_list_builds', { root: FIXTURES, format: 'json' });
  assert.equal(r.json.builds.length, 7);
  assert.deepEqual(
    [...new Set(r.json.builds.map((b) => b.device))].sort(),
    ['GW2AR-18', 'GW5AT-60'],
  );
  assert.ok(r.json.builds.find((b) => b.name === 'demo').fs.endsWith('demo.fs'));
  const text = (await server.call('gowin_list_builds', { root: FIXTURES })).text;
  assert.match(text, /legacy\s+.*\[no timing\]/);
  assert.match(text, /trtext\s+.*\[timing from \.tr\]/);
});

test('gowin_pins and gowin_warnings over stdio', async () => {
  const pins = await server.call('gowin_pins', { path: DEMO, port: 'CART_MUX*', includeUnused: true, format: 'json' });
  assert.ok(pins.json.ports.length >= 1);
  assert.ok(pins.json.ports.every((p) => p.port.startsWith('CART_MUX')));
  assert.ok(pins.json.packagePins.every((p) => !p.signal || p.signal.startsWith('CART_MUX')), 'used pins filtered by signal, free pins kept');
  assert.ok(pins.json.packagePins.some((p) => !p.signal));
  const pinsText = (await server.call('gowin_pins', { path: DEMO, port: 'CART_*' })).text;
  assert.match(pinsText, /^\d+ of 12 ports; 14 package pins/);
  assert.match(pinsText, /Global clock routing/);

  const warn = await server.call('gowin_warnings', { path: DEMO, level: 'error', format: 'json' });
  assert.deepEqual(warn.json.groups.map((g) => g.code), ['CT1135']);
  assert.match((await server.call('gowin_warnings', { path: DEMO, level: 'error' })).text, /Clocks without a constraint \(TA1132\)/);
});

test('errors come back as tool errors, not protocol failures', async () => {
  const r = await server.call('gowin_check', { path: join(FIXTURES, 'nope') });
  assert.equal(r.isError, true);
  assert.match(r.text, /No Gowin build found/);
  const named = await server.call('gowin_summary', { path: DEMO, name: 'ghost' });
  assert.equal(named.isError, true);
  assert.match(named.text, /No build named "ghost"/);
  const wrong = await server.call('gowin_summary', { path: join(DEMO, 'impl', 'pnr', 'stale.rpt.txt'), name: 'demo' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /is build "stale", not "demo"/);
});
