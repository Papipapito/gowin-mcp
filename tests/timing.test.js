import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { parseTimingHtml, parseTimingReport } from '../dist/parse-timing.js';
import { DEMO, FAILING } from './helpers.js';

const DEMO_HTML = join(DEMO, 'impl', 'pnr', 'demo_tr_content.html');
const FAIL_HTML = join(FAILING, 'impl', 'pnr', 'fail_tr_content.html');

test('setup, hold, recovery and removal tables are kept apart', () => {
  const t = parseTimingReport(DEMO_HTML);
  assert.equal(t.recognized, true);
  assert.equal(t.setupPaths.length, 3);
  assert.equal(t.holdPaths.length, 3);
  assert.equal(t.recoveryPaths.length, 3);
  assert.equal(t.removalPaths.length, 3);
  // The worst hold path must come from the hold table, not from recovery.
  const worstHold = [...t.holdPaths].sort((a, b) => a.slack - b.slack)[0];
  assert.equal(worstHold.slack, 0.074);
  assert.equal(worstHold.to, 'u_top/u_core/u_blkpcm/u_engine/TL_RAM/mem_mem_0_0_s/DI[0]');
  const worstRecovery = [...t.recoveryPaths].sort((a, b) => a.slack - b.slack)[0];
  assert.ok(worstRecovery.to.endsWith('/CLEAR'), 'recovery paths end on async clear pins');
});

test('fMax, TNS and clocks without paths', () => {
  const t = parseTimingReport(DEMO_HTML);
  assert.equal(t.fmax.length, 7);
  const eng = t.fmax.find((f) => f.clock === 'clk_eng');
  assert.equal(eng.constraintMhz, 40);
  assert.equal(eng.actualMhz, 53.974);
  assert.equal(eng.failing, false);
  assert.equal(eng.marginMhz, 13.974);
  assert.equal(t.tns.length, 28);
  assert.ok(t.tns.every((r) => r.tns === 0), 'clean build');
  assert.equal(t.clocksWithoutPaths.length, 7);
  assert.ok(t.clocksWithoutPaths.includes('u_top/u_div5m4/CLKOUT.default_gen_clk'));
});

test('a failing build reports negative TNS and a failing fMax', () => {
  const t = parseTimingReport(FAIL_HTML);
  const bad = t.tns.filter((r) => r.tns < 0);
  assert.deepEqual(bad.map((r) => [r.clock, r.analysis, r.tns, r.endpoints]), [['clk_eng', 'Setup', -0.412, 2]]);
  assert.deepEqual(t.fmax.filter((f) => f.failing).map((f) => f.clock), ['clk_eng']);
  assert.equal([...t.setupPaths].sort((a, b) => a.slack - b.slack)[0].slack, -0.412);
});

test('an HTML without the summary tables is not recognised', () => {
  const t = parseTimingHtml('<html><body><h1>Nothing here</h1><table><tr><td>x</td></tr></table></body></html>');
  assert.equal(t.recognized, false);
  assert.equal(t.fmax.length, 0);
  assert.equal(t.setupPaths.length, 0);
});

test('legacy layout without section headings falls back to the hold marker', () => {
  const row = (n, slack) =>
    `<tr><td>${n}</td><td>${slack}</td><td>a/Q</td><td>b/D</td><td>clk:[R]</td><td>clk:[R]</td><td>10</td><td>0</td><td>1</td></tr>`;
  const header =
    '<tr><th>Path Number</th><th>Path Slack</th><th>From Node</th><th>To Node</th><th>From Clock</th><th>To Clock</th><th>Relation</th><th>Clock Skew</th><th>Data Delay</th></tr>';
  const html =
    '<table><tr><th>Clock Name</th><th>Analysis Type</th><th>TNS</th><th>Number of Endpoints</th></tr><tr><td>clk</td><td>Setup</td><td>0.000</td><td>0</td></tr></table>' +
    `<table>${header}${row(1, 2.5)}</table>` +
    'Hold Paths Table' +
    `<table>${header}${row(1, 0.1)}${row(2, 0.2)}</table>`;
  const t = parseTimingHtml(html);
  assert.equal(t.recognized, true);
  assert.equal(t.setupPaths.length, 1);
  assert.equal(t.holdPaths.length, 2);
});
