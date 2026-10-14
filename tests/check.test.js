import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBuild } from '../dist/discover.js';
import { checkBuild, loadBuild, summarize, timingVerdict } from '../dist/analyze.js';
import { compareBuilds } from '../dist/compare.js';
import { DEMO, FAILING, LEGACY, pinFixtureTimes } from './helpers.js';

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
