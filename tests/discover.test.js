import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { discoverBuilds, resolveBuild } from '../dist/discover.js';
import { DEMO, FIXTURES, LEGACY, pinFixtureTimes } from './helpers.js';

pinFixtureTimes();

test('discoverBuilds finds every build under the fixtures tree, newest first', () => {
  const builds = discoverBuilds(FIXTURES);
  assert.deepEqual(
    builds.map((b) => b.name).sort(),
    ['demo', 'fail', 'legacy', 'stale', 'xdomain'],
  );
  for (let i = 1; i < builds.length; i++) {
    assert.ok(builds[i - 1].mtime >= builds[i].mtime, 'sorted by mtime descending');
  }
  const legacy = builds.find((b) => b.name === 'legacy');
  assert.equal(legacy.trContent, undefined, 'legacy build has no timing HTML');
  assert.equal(legacy.projectDir, LEGACY);
});

test('resolveBuild picks the most recent report when several share one pnr/', () => {
  const b = resolveBuild(DEMO);
  assert.equal(b.name, 'demo');
  assert.deepEqual(b.siblings, ['stale'], 'the skipped build is reported');
  assert.ok(b.trContent?.endsWith('demo_tr_content.html'));
});

test('resolveBuild accepts the impl/ directory and the .rpt.txt itself', () => {
  assert.equal(resolveBuild(join(DEMO, 'impl')).name, 'demo');
  const direct = resolveBuild(join(DEMO, 'impl', 'pnr', 'stale.rpt.txt'));
  assert.equal(direct.name, 'stale');
  assert.equal(direct.siblings, undefined, 'an explicit file has no siblings note');
});

test('resolveBuild with a name picks that build or throws', () => {
  assert.equal(resolveBuild(DEMO, 'stale').name, 'stale');
  assert.equal(resolveBuild(DEMO, 'STALE.rpt.txt').name, 'stale', 'case and suffix tolerant');
  assert.throws(() => resolveBuild(DEMO, 'nope'), /No build named "nope".*Available: demo, stale/);
});

test('resolveBuild returns undefined where there is nothing to find', () => {
  assert.equal(resolveBuild(join(FIXTURES, 'does-not-exist')), undefined);
});
