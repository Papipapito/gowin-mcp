import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { discoverBuilds, resolveBuild } from '../dist/discover.js';
import { DEMO, FIXTURES, LEGACY, TRTEXT, pinFixtureTimes } from './helpers.js';

pinFixtureTimes();

test('discoverBuilds finds every build under the fixtures tree, newest first', () => {
  const builds = discoverBuilds(FIXTURES);
  assert.deepEqual(
    builds.map((b) => b.name).sort(),
    ['demo', 'fail', 'fmaxonly', 'legacy', 'stale', 'trtext', 'xdomain'],
  );
  for (let i = 1; i < builds.length; i++) {
    assert.ok(builds[i - 1].mtime >= builds[i].mtime, 'sorted by mtime descending');
  }
  const legacy = builds.find((b) => b.name === 'legacy');
  assert.equal(legacy.trContent, undefined, 'legacy build has no timing HTML');
  assert.equal(legacy.tr, undefined);
  assert.equal(legacy.fs, undefined);
  assert.equal(legacy.projectDir, LEGACY);

  const demo = builds.find((b) => b.name === 'demo');
  assert.ok(demo.fs.endsWith('demo.fs'), 'the bitstream is located next to the report');
  const trtext = builds.find((b) => b.name === 'trtext');
  assert.equal(trtext.trContent, undefined);
  assert.ok(trtext.tr.endsWith('trtext.tr'), 'the plain-text timing report is located');
});

test('resolveBuild picks the most recent report when several share one pnr/', () => {
  const b = resolveBuild(DEMO);
  assert.equal(b.name, 'demo');
  assert.deepEqual(b.siblings, ['stale'], 'the skipped build is reported');
  assert.ok(b.trContent?.endsWith('demo_tr_content.html'));
});

test('resolveBuild accepts the impl/ directory, impl/pnr/ itself, and the .rpt.txt', () => {
  assert.equal(resolveBuild(join(DEMO, 'impl')).name, 'demo');
  const pnr = resolveBuild(join(DEMO, 'impl', 'pnr'));
  assert.equal(pnr.name, 'demo', 'impl/pnr/ resolves to its impl/');
  assert.deepEqual(pnr.siblings, ['stale']);
  assert.equal(resolveBuild(join(TRTEXT, 'impl', 'pnr') + '/').name, 'trtext', 'trailing slash');

  const direct = resolveBuild(join(DEMO, 'impl', 'pnr', 'stale.rpt.txt'));
  assert.equal(direct.name, 'stale');
  assert.equal(direct.siblings, undefined, 'an explicit file has no siblings note');
  assert.equal(direct.implDir, join(DEMO, 'impl'));
  assert.equal(direct.projectDir, DEMO);
});

test('resolveBuild takes the .rpt.txt path with forward slashes and either case', () => {
  const forward = join(DEMO, 'impl', 'pnr', 'stale.rpt.txt').replace(/\\/g, '/');
  const b = resolveBuild(forward);
  assert.ok(b, 'a forward-slash path still finds the report');
  assert.equal(b.name, 'stale');
  assert.ok(b.fs.endsWith('stale.fs'));
  if (process.platform === 'win32') {
    const shouted = resolveBuild(forward.toUpperCase());
    assert.equal(shouted.name, 'stale', 'the build keeps the name of the directory entry, not the spelling typed');
    assert.ok(shouted.rptTxt.endsWith('stale.rpt.txt'));
  }
});

test('resolveBuild with a name picks that build or throws, also against an explicit .rpt.txt', () => {
  assert.equal(resolveBuild(DEMO, 'stale').name, 'stale');
  assert.equal(resolveBuild(DEMO, 'STALE.rpt.txt').name, 'stale', 'case and suffix tolerant');
  assert.throws(() => resolveBuild(DEMO, 'nope'), /No build named "nope".*Available: demo, stale/);

  const file = join(DEMO, 'impl', 'pnr', 'stale.rpt.txt');
  assert.equal(resolveBuild(file, 'stale').name, 'stale');
  assert.throws(() => resolveBuild(file, 'demo'), /is build "stale", not "demo"/);
});

test('resolveBuild returns undefined where there is nothing to find', () => {
  assert.equal(resolveBuild(join(FIXTURES, 'does-not-exist')), undefined);
  assert.equal(resolveBuild(join(DEMO, 'impl', 'pnr', 'ghost.rpt.txt')), undefined);
});
