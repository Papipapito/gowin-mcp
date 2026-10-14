import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { parseTimingHtml, parseTimingReport } from '../dist/parse-timing.js';
import { extractTextTables, parseTimingText, parseTimingTextReport } from '../dist/parse-timing-text.js';
import { DEMO, FAILING, FMAXONLY, TRTEXT, XDOMAIN } from './helpers.js';

const DEMO_HTML = join(DEMO, 'impl', 'pnr', 'demo_tr_content.html');
const FAIL_HTML = join(FAILING, 'impl', 'pnr', 'fail_tr_content.html');
const XDOMAIN_HTML = join(XDOMAIN, 'impl', 'pnr', 'xdomain_tr_content.html');
const FMAXONLY_HTML = join(FMAXONLY, 'impl', 'pnr', 'fmaxonly_tr_content.html');
const TRTEXT_TR = join(TRTEXT, 'impl', 'pnr', 'trtext.tr');

test('setup, hold, recovery and removal tables are kept apart', () => {
  const t = parseTimingReport(DEMO_HTML);
  assert.equal(t.recognized, true);
  assert.equal(t.format, 'html');
  assert.equal(t.setupPaths.length, 3);
  assert.equal(t.holdPaths.length, 3);
  assert.equal(t.recoveryPaths.length, 3);
  assert.equal(t.removalPaths.length, 3);
  // The worst hold path must come from the hold table, not from recovery.
  const worstHold = [...t.holdPaths].sort((a, b) => a.slack - b.slack)[0];
  assert.equal(worstHold.slack, 0.074);
  assert.equal(worstHold.to, 'u_top/u_core/u_blkpcm/u_engine/TL_RAM/mem_mem_0_0_s/DI[0]');
  assert.deepEqual(t.worstHold, worstHold);
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
  assert.equal(t.setupPaths[0].slack, -0.412, 'tables come out worst slack first');
  assert.equal(t.worstSetup.slack, -0.412);
});

test('a CRLF report with a clean TNS but negative cross-domain paths', () => {
  const t = parseTimingReport(XDOMAIN_HTML);
  assert.equal(t.recognized, true);
  assert.equal(t.tns.length, 38);
  assert.ok(t.tns.every((r) => r.tns === 0));
  assert.equal(t.fmax.length, 6);
  assert.ok(t.fmax.every((f) => !f.failing));
  assert.equal(t.setupPaths.length, 18);
  assert.equal(t.setupPaths.filter((p) => p.slack < 0).length, 14);
  assert.ok(t.setupPaths.filter((p) => p.slack < 0).every((p) => p.fromClock === 'clock_54m' && p.toClock === 'clock_27m'));
  assert.equal(t.holdPaths.length, 6);
  assert.ok(t.holdPaths.every((p) => p.slack < 0 && p.fromClock !== p.toClock));
  assert.equal(t.recoveryPaths.length, 3);
  assert.equal(t.removalPaths.length, 3);
  assert.equal(t.clocksWithoutPaths.length, 13);
});

test('launch and capture edges come from the clk:[R] / clk:[F] suffix', () => {
  const t = parseTimingReport(FMAXONLY_HTML);
  assert.equal(t.setupPaths.length, 5);
  assert.deepEqual(t.setupPaths.map((p) => p.slack), [0.544, 0.668, 0.677, 0.871, 0.871], 'sorted worst first');
  const half = t.setupPaths.filter((p) => p.fromEdge !== p.toEdge);
  assert.equal(half.length, 2);
  assert.ok(half.every((p) => p.fromClock === 'clk_54m' && p.toClock === 'clk_54m' && p.fromEdge === 'F' && p.toEdge === 'R'));
  assert.ok(t.setupPaths.every((p) => p.fromEdge && p.toEdge), 'every row carries both edges');
  assert.equal(t.worstSetup.slack, 0.544);
  assert.equal(t.worstSetup.fromClock, 'clk_86');
  const bad = t.fmax.find((f) => f.failing);
  assert.deepEqual([bad.clock, bad.actualMhz, bad.constraintMhz, bad.marginMhz], ['clk_54m', 32.455, 53.996, -21.541]);
  assert.equal(t.tns.length, 34);
  assert.equal(t.clocksWithoutPaths.length, 5);
});

test('an HTML without the summary tables is not recognised', () => {
  const t = parseTimingHtml('<html><body><h1>Nothing here</h1><table><tr><td>x</td></tr></table></body></html>');
  assert.equal(t.recognized, false);
  assert.equal(t.fmax.length, 0);
  assert.equal(t.setupPaths.length, 0);
  assert.equal(t.worstSetup, undefined);
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

test('the plain-text <name>.tr report parses into the same shape as the HTML', () => {
  const t = parseTimingTextReport(TRTEXT_TR);
  assert.equal(t.recognized, true);
  assert.equal(t.format, 'text');
  assert.equal(t.fmax.length, 5);
  const eng = t.fmax.find((f) => f.clock === 'clk_eng');
  assert.deepEqual([eng.constraintMhz, eng.actualMhz, eng.logicLevel, eng.entity, eng.failing], [37.125, 56.069, 22, 'TOP', false]);
  assert.equal(t.tns.length, 24);
  assert.ok(t.tns.every((r) => r.tns === 0 && (r.analysis === 'Setup' || r.analysis === 'Hold')), 'setup/hold capitalised like the HTML');
  assert.equal(t.clocksWithoutPaths.length, 7);
  assert.ok(t.clocksWithoutPaths.includes('u_top/u_pll_main/rpll_inst/CLKOUTD3.default_gen_clk'));
  assert.deepEqual(
    [t.setupPaths.length, t.holdPaths.length, t.recoveryPaths.length, t.removalPaths.length],
    [3, 3, 3, 3],
    'each table is told apart by its heading',
  );
  assert.deepEqual(
    { slack: t.worstSetup.slack, from: t.worstSetup.from, fromClock: t.worstSetup.fromClock, fromEdge: t.worstSetup.fromEdge, relation: t.worstSetup.relation, dataDelay: t.worstSetup.dataDelay },
    { slack: 2.765, from: 'u_top/u_core/u_sdram/ff_main_timer_0_s2/Q', fromClock: 'clk_108m', fromEdge: 'R', relation: 9.259, dataDelay: 6.459 },
  );
  assert.equal(t.worstHold.slack, 0.074);
  assert.ok(t.removalPaths.every((p) => p.to.endsWith('/PRESET') || p.to.endsWith('/CLEAR')));
});

test('text tables are sliced by the ==== rule, so empty cells keep their column', () => {
  const tables = extractTextTables(readFileSync(TRTEXT_TR, 'utf8'));
  const clocks = tables.find((t) => t.heading.includes('Clock Summary'));
  assert.ok(clocks);
  const header = clocks.rows[0];
  assert.deepEqual(header.slice(0, 3), ['NO.', 'Clock Name', 'Type']);
  const base = clocks.rows.find((r) => r[1] === 'clk27');
  assert.equal(base[header.indexOf('Source')], '', 'a base clock has no Source');
  assert.equal(base[header.indexOf('Objects')], 'CLK_27M', 'and the last column is not shifted into it');
  const gen = clocks.rows.find((r) => r[1] === 'u_top/u_div27/CLKOUT.default_gen_clk');
  assert.equal(gen[header.indexOf('Master')], 'clk_108m');

  const empty = parseTimingText('nothing that looks like a report\n');
  assert.equal(empty.recognized, false);
});
