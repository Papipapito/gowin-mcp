import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBuild } from '../dist/discover.js';
import { checkBuild, loadBuild, summarize, timingVerdict } from '../dist/analyze.js';
import { compareBuilds } from '../dist/compare.js';
import { DEMO, FAILING, LEGACY, XDOMAIN, pinFixtureTimes } from './helpers.js';

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

test('compareBuilds keys path violations by clock pair: persisting between two copies', () => {
  const diff = compareBuilds(load(XDOMAIN), load(XDOMAIN));
  assert.equal(diff.safe, true);
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
});

test('failOnMissingTiming=false accepts an unknown build on resources alone', () => {
  const r = checkBuild(load(LEGACY), { failOnMissingTiming: false });
  assert.equal(r.status, 'unknown');
  assert.equal(r.ok, true);
  assert.match(r.reasons.join('\n'), /accepted on resources alone/);
});

test('maxUtilization and minFmaxMarginMhz thresholds', () => {
  // demo: CLS 77%, Logic 56%, BSRAM 35%; clk_eng margin 13.974 MHz.
  const util = checkBuild(load(DEMO), { maxUtilization: 60 });
  assert.equal(util.status, 'fail');
  assert.deepEqual(util.thresholdFailures.map((t) => [t.kind, t.name, t.value]), [['utilization', 'CLS', 77]]);

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
