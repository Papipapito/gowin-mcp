import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBuild } from '../dist/discover.js';
import { checkBuild, loadBuild, summarize, timingVerdict } from '../dist/analyze.js';
import { compareBuilds } from '../dist/compare.js';
import { DEMO, FAILING, FMAXONLY, LEGACY, TRTEXT, XDOMAIN, pinFixtureTimes } from './helpers.js';

pinFixtureTimes();
const load = (dir, name) => loadBuild(resolveBuild(dir, name));

test('timingVerdict: unknown when there is no report, an unrecognised one, or no clocks', () => {
  assert.equal(timingVerdict(undefined).status, 'unknown');
  assert.match(timingVerdict(undefined).reason, /_tr_content\.html is missing/);
  const empty = { fmax: [], clocksWithoutPaths: [], tns: [], setupPaths: [], holdPaths: [], recoveryPaths: [], removalPaths: [] };
  assert.equal(timingVerdict({ ...empty, recognized: false }).status, 'unknown');
  assert.equal(timingVerdict({ ...empty, recognized: true }).status, 'unknown');
  assert.match(timingVerdict({ ...empty, recognized: true }).reason, /no clocks/);
});

test('a clean build passes and a build with violations fails', () => {
  const ok = checkBuild(load(DEMO));
  assert.equal(ok.status, 'pass');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.violations, []);
  assert.deepEqual(ok.thresholds.fmaxWaivers, []);

  const bad = checkBuild(load(FAILING));
  assert.equal(bad.status, 'fail');
  assert.equal(bad.ok, false);
  assert.deepEqual(
    bad.violations.map((v) => [v.kind, v.clock, v.amount]),
    [['setup', 'clk_eng', -0.412]],
    'fMax shortfall on the same clock is not double-counted',
  );
  assert.equal(bad.violations[0].source, 'tns');
  assert.equal(bad.notes.length, 0);
});

test('negative paths between clock domains fail the gate even when every TNS row is 0', () => {
  const b = load(XDOMAIN);
  assert.ok(b.timing.tns.every((r) => r.tns >= 0), 'the TNS summary of this fixture is clean');
  assert.ok(b.timing.fmax.every((f) => !f.failing), 'and so is fMax');

  const r = checkBuild(b);
  assert.equal(r.status, 'fail');
  assert.equal(r.ok, false);
  assert.equal(r.timing.status, 'fail');
  assert.match(r.reasons[0], /^5 timing violations$/);

  const [worst, ...holds] = r.violations;
  assert.deepEqual(
    [worst.kind, worst.source, worst.clock, worst.amount, worst.fromClock, worst.toClock, worst.crossDomain, worst.pathCount],
    ['setup', 'paths', 'clock_54m -> clock_27m', -2.09, 'clock_54m', 'clock_27m', true, 14],
  );
  assert.match(worst.detail, /^at least 14 setup paths clock_54m -> clock_27m/);
  assert.match(worst.detail, /worst -2\.09 ns: u_cpu\/RD_s0\/Q -> u_uart\/ff_rx_state_0_s0\/CE$/);
  assert.deepEqual(
    holds.map((v) => [v.kind, v.clock, v.amount, v.pathCount]),
    [
      ['hold', 'clock_VideoDHClk -> clock_108m', -0.694, 1],
      ['hold', 'clock_VideoDHClk -> clock_108i', -0.694, 1],
      ['hold', 'clock_VideoDLClk -> clock_108m', -0.628, 2],
      ['hold', 'clock_VideoDLClk -> clock_108i', -0.628, 2],
    ],
    'one violation per clock pair, worst slack first',
  );
  assert.ok(r.violations.every((v) => v.source === 'paths' && v.crossDomain));
  assert.deepEqual(r.ignoredViolations, []);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /5 violations come from the path tables, not the TNS summary/);
  assert.match(r.notes[0], /set_false_path \/ set_clock_groups/);
  assert.match(r.notes[0], /ignoreCrossDomain=true/);
  assert.equal(r.thresholds.ignoreCrossDomain, false);

  const s = summarize(b);
  assert.equal(s.status, 'fail');
  assert.equal(s.clean, false);
  assert.equal(s.timing.violations.length, 5, 'gowin_summary reports them too');
});

test('ignoreCrossDomain=true passes when every negative path is a clock domain crossing', () => {
  const r = checkBuild(load(XDOMAIN), { ignoreCrossDomain: true });
  assert.equal(r.status, 'pass');
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
  assert.equal(r.ignoredViolations.length, 5);
  assert.ok(r.ignoredViolations.every((v) => v.crossDomain));
  assert.equal(r.thresholds.ignoreCrossDomain, true);
  assert.match(r.reasons[0], /^no timing violations$/);
  assert.match(r.notes[0], /5 cross-domain path violations ignored \(ignoreCrossDomain=true\)/);
  assert.match(r.reasons.join('\n'), /ignored/, 'the ignored set is on record in reasons too');

  // A TNS violation is never ignored by this option.
  const bad = checkBuild(load(FAILING), { ignoreCrossDomain: true });
  assert.equal(bad.status, 'fail');
  assert.deepEqual(bad.ignoredViolations, []);
});

test('an fMax shortfall with a clean TNS is an fMax-only violation that explains itself from the .sdc', () => {
  const b = load(FMAXONLY);
  assert.equal(b.resources.build.device, 'GW5AT-60');
  assert.ok(b.timing.tns.every((r) => r.tns === 0), 'every TNS row is 0.000');
  assert.deepEqual(b.timing.fmax.filter((f) => f.failing).map((f) => f.clock), ['clk_54m']);
  assert.equal(b.sdc.readable, true, 'the .sdc named in the report is found under the project (constraints/)');
  assert.ok(b.sdc.path.endsWith('fmaxonly.sdc'));

  const r = checkBuild(b);
  assert.equal(r.status, 'fail');
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  const [v] = r.violations;
  assert.deepEqual([v.kind, v.source, v.clock, v.amount, v.unit], ['fmax', 'fmax', 'clk_54m', -21.541, 'MHz']);
  assert.match(v.detail, /^32\.455 MHz achieved against a 53\.996 MHz constraint, with no setup violation reported \(setup TNS 0\.000\)/);
  assert.match(v.detail, /6 set_multicycle_path commands in the \.sdc name this clock/);
  assert.match(v.detail, /2 of its reported setup paths are half-cycle relations/);
  assert.match(v.detail, /Gowin derives fMax from the worst path's relation minus its slack/);
  assert.match(v.detail, /waive it with fmaxWaivers/);
  assert.doesNotMatch(v.detail, /set_false_path/, 'no false path names this clock');

  const s = summarize(b);
  assert.equal(s.status, 'fail');
  assert.equal(s.timing.violations[0].detail, v.detail, 'gowin_summary carries the same explanation');
  assert.deepEqual(
    { readable: s.constraints.readable, multicyclePaths: s.constraints.multicyclePaths, falsePaths: s.constraints.falsePaths, clockGroups: s.constraints.clockGroups },
    { readable: true, multicyclePaths: 6, falsePaths: 2, clockGroups: 3 },
  );
  assert.ok(s.constraints.clocks.includes('clk_54m'));
});

test('fmaxWaivers moves the fMax-only violation to ignoredViolations; a TNS violation is never waived', () => {
  const r = checkBuild(load(FMAXONLY), { fmaxWaivers: ['clk_54m'] });
  assert.equal(r.status, 'pass');
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.ignoredViolations.map((v) => [v.kind, v.clock]), [['fmax', 'clk_54m']]);
  assert.deepEqual(r.thresholds.fmaxWaivers, ['clk_54m']);
  assert.match(r.reasons[0], /^no timing violations$/);
  assert.match(r.notes[0], /1 fMax-only violation waived \(fmaxWaivers=\["clk_54m"\]\): clk_54m \(-21\.541 MHz\)/);
  assert.match(r.notes[0], /a TNS violation is never waived/);

  // Globs and case do not matter; a waiver that names no clock is pointed out.
  assert.equal(checkBuild(load(FMAXONLY), { fmaxWaivers: ['CLK_54*'] }).status, 'pass');
  const typo = checkBuild(load(FMAXONLY), { fmaxWaivers: ['clk_54', 'clk_54m'] });
  assert.equal(typo.status, 'pass');
  assert.match(typo.notes.join('\n'), /fmaxWaivers names no clock of this report: clk_54 /);

  // The margin threshold does not re-flag a waived clock; it still catches the others.
  const margin = checkBuild(load(FMAXONLY), { fmaxWaivers: ['clk_54m'], minFmaxMarginMhz: 5 });
  assert.deepEqual(margin.thresholdFailures.map((t) => t.name), ['clk_86']);

  // clk_eng in FAILING has a setup TNS violation: the waiver leaves it alone.
  const bad = checkBuild(load(FAILING), { fmaxWaivers: ['clk_eng'] });
  assert.equal(bad.status, 'fail');
  assert.deepEqual(bad.violations.map((v) => v.source), ['tns']);
  assert.deepEqual(bad.ignoredViolations, []);
});

test('an fMax-only violation without .sdc evidence still says to check the constraint', () => {
  const b = load(FMAXONLY);
  // Same report, constraints unreadable.
  const gone = { ...b, sdc: { ...b.sdc, readable: false, path: undefined, multicyclePaths: [], falsePaths: [], clockGroups: [] } };
  const r = checkBuild(gone);
  assert.equal(r.status, 'fail');
  assert.match(r.violations[0].detail, /The \.sdc at .*fmaxonly\.sdc could not be read, so its exceptions were not checked\.$/);
  assert.match(r.violations[0].detail, /2 of its reported setup paths are half-cycle relations/, 'the path-table evidence does not depend on the .sdc');
  assert.doesNotMatch(r.violations[0].detail, /set_multicycle_path/);

  // No evidence at all: the plain advice.
  const bare = { ...gone, timing: { ...b.timing, setupPaths: b.timing.setupPaths.filter((p) => p.fromEdge === p.toEdge) } };
  assert.match(checkBuild(bare).violations[0].detail, /— check the constraint covers this domain\. The \.sdc at .* could not be read/);
  const silent = { ...b, sdc: { ...b.sdc, multicyclePaths: [], falsePaths: [] }, timing: bare.timing };
  assert.match(checkBuild(silent).violations[0].detail, /names this clock in no multicycle or false-path command\)$/);
});

test('compareBuilds keys path violations by clock pair: persisting between two copies', () => {
  const diff = compareBuilds(load(XDOMAIN), load(XDOMAIN));
  assert.equal(diff.safe, true);
  assert.equal(diff.comparable, true);
  assert.deepEqual(diff.violations.introduced, []);
  assert.deepEqual(diff.violations.fixed, []);
  assert.deepEqual(
    diff.violations.persisting.map((v) => v.clock),
    [
      'clock_54m -> clock_27m',
      'clock_VideoDHClk -> clock_108m',
      'clock_VideoDHClk -> clock_108i',
      'clock_VideoDLClk -> clock_108m',
      'clock_VideoDLClk -> clock_108i',
    ],
  );

  // Against a clean build they are all introduced, and the gate flags the regression.
  const intro = compareBuilds(load(DEMO), load(XDOMAIN));
  assert.equal(intro.safe, false);
  assert.equal(intro.violations.introduced.length, 5);
  assert.equal(compareBuilds(load(XDOMAIN), load(DEMO)).violations.fixed.length, 5);
});

test('compareBuilds across devices: safe is null and violations are not classified', () => {
  const diff = compareBuilds(load(FMAXONLY), load(DEMO));
  assert.equal(diff.comparable, false);
  assert.equal(diff.safe, null);
  assert.deepEqual(diff.violations, { introduced: [], fixed: [], persisting: [] }, 'the clk_54m fMax violation is not "fixed" by a different design');
  assert.ok(diff.fmax.every((f) => f.statusChange === undefined));
  assert.match(diff.notes[0], /Different devices \(GW5AT-60 vs GW2AR-18\).*safe is null/);
  assert.match(diff.notes.join('\n'), /Violations per side, unclassified: before 1, after 0/);
  assert.equal(diff.sameBitstream, false);
});

test('compareBuilds reports siblings per side and whether the bitstreams match', () => {
  const diff = compareBuilds(load(DEMO), load(DEMO, 'stale'));
  assert.deepEqual(diff.before.siblings, ['stale']);
  assert.match(diff.before.note, /newest of 2 builds/);
  assert.equal(diff.after.siblings, undefined, 'a named build has no siblings note');
  assert.equal(diff.sameBitstream, true, 'demo.fs and stale.fs differ only in the Created Time header');
  assert.match(diff.notes.join('\n'), /same body/);
  assert.equal(diff.before.bitstream.bodySha256, diff.after.bitstream.bodySha256);
  assert.notEqual(diff.before.bitstream.createdTime, diff.after.bitstream.createdTime);
});

test('missing timing is unknown, never clean, and fails the gate by default', () => {
  const legacy = load(LEGACY);
  const r = checkBuild(legacy);
  assert.equal(r.status, 'unknown');
  assert.equal(r.ok, false);
  assert.equal(r.timing.status, 'unknown');
  assert.match(r.reasons.join('\n'), /treated as a failure \(failOnMissingTiming=true\)/);

  const s = summarize(legacy);
  assert.equal(s.status, 'unknown');
  assert.equal(s.clean, false);
  assert.equal(s.timing.status, 'unknown');
  assert.equal(s.bitstream, undefined, 'no .fs next to this report');
  assert.equal(s.constraints.readable, false);
});

test('failOnMissingTiming=false accepts an unknown build on resources alone', () => {
  const r = checkBuild(load(LEGACY), { failOnMissingTiming: false });
  assert.equal(r.status, 'unknown');
  assert.equal(r.ok, true);
  assert.match(r.reasons.join('\n'), /accepted on resources alone/);
});

test('maxUtilization uses the recomputed percentage and quotes the rounded one', () => {
  // demo: CLS 7915/10368 = 76.34% ("77%"), Logic 55.31%, BSRAM 34.78%; clk_eng margin 13.974 MHz.
  const util = checkBuild(load(DEMO), { maxUtilization: 60 });
  assert.equal(util.status, 'fail');
  assert.deepEqual(
    util.thresholdFailures.map((t) => [t.kind, t.name, t.value, t.reported]),
    [['utilization', 'CLS', 76.34, '77%']],
  );
  assert.match(util.thresholdFailures[0].detail, /CLS at 76\.34% \(77% as the tool rounds it\) exceeds maxUtilization 60%/);

  // fmaxonly: CLS 29142/29952 = 97.30%, which the tool rounds up to 98%.
  // A 97.5% limit holds on the real number; BSRAM at 118/118 does not.
  const close = checkBuild(load(FMAXONLY), { maxUtilization: 97.5, fmaxWaivers: ['clk_54m'] });
  assert.deepEqual(close.thresholdFailures.map((t) => [t.name, t.value, t.reported]), [['BSRAM', 100, '100%']]);
  assert.doesNotMatch(close.thresholdFailures[0].detail, /rounds/, 'nothing to quote when both agree');

  // legacy (V1.9.9) puts the percentage inside the usage cell; the recomputed value still gates.
  const old = checkBuild(load(LEGACY), { maxUtilization: 50, failOnMissingTiming: false });
  assert.deepEqual(old.thresholdFailures.map((t) => [t.name, t.value]), [['CLS', 56.92]]);

  const margin = checkBuild(load(DEMO), { minFmaxMarginMhz: 14 });
  assert.equal(margin.status, 'fail');
  assert.deepEqual(margin.thresholdFailures.map((t) => [t.kind, t.name]), [['fmaxMargin', 'clk_eng']]);

  const fine = checkBuild(load(DEMO), { maxUtilization: 80, minFmaxMarginMhz: 10 });
  assert.equal(fine.status, 'pass');
  assert.equal(fine.thresholdFailures.length, 0);

  // A threshold breach on a build without timing fails but still records
  // that timing was not verified.
  const both = checkBuild(load(LEGACY), { maxUtilization: 1 });
  assert.equal(both.status, 'fail');
  assert.match(both.reasons.join('\n'), /timing not verified/);
});

test('compareBuilds notes an unknown side and flags a regression', () => {
  const diff = compareBuilds(load(DEMO), load(FAILING));
  assert.equal(diff.safe, false);
  assert.deepEqual(diff.violations.introduced.map((v) => v.clock), ['clk_eng']);
  assert.ok(diff.fmax.some((f) => f.clock === 'clk_eng' && f.statusChange === 'regressed'));

  const unknown = compareBuilds(load(LEGACY), load(DEMO));
  assert.ok(unknown.notes.some((n) => /"before" build is unknown/.test(n)));
});

test('summarize and checkBuild carry siblings and a note when a build was chosen among several', () => {
  const s = summarize(load(DEMO));
  assert.deepEqual(s.siblings, ['stale']);
  assert.match(s.note, /^newest of 2 builds in .*; others: stale \(pass name to pick one\)$/);
  const r = checkBuild(load(DEMO));
  assert.deepEqual(r.siblings, ['stale']);
  assert.equal(r.note, s.note);
  assert.equal(summarize(load(DEMO, 'stale')).siblings, undefined);
  assert.equal(checkBuild(load(FMAXONLY)).note, undefined);
});

test('a build whose timing exists only as <name>.tr is verified from the text report', () => {
  const b = load(TRTEXT);
  assert.equal(b.found.trContent, undefined);
  assert.ok(b.found.tr.endsWith('trtext.tr'));
  assert.equal(b.timing.format, 'text');
  const r = checkBuild(b);
  assert.equal(r.status, 'pass');
  assert.equal(r.timing.status, 'pass');
  const s = summarize(b);
  assert.equal(s.timing.fmax.length, 5);
  assert.equal(s.build.toolVersion, 'V1.9.12.04 (64-bit)');
});
