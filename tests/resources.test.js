import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { parseResourceReport, readBuildHeader } from '../dist/parse-resources.js';
import { DEMO, LEGACY } from './helpers.js';

const DEMO_RPT = join(DEMO, 'impl', 'pnr', 'demo.rpt.txt');
const LEGACY_RPT = join(LEGACY, 'impl', 'pnr', 'legacy.rpt.txt');

test('header: "Tool Version" (new) and "PnR Version" (old) both land in toolVersion', () => {
  const demo = parseResourceReport(DEMO_RPT).build;
  assert.equal(demo.toolVersion, 'V1.9.12.03 (64-bit)');
  assert.equal(demo.device, 'GW2AR-18');
  assert.equal(demo.partNumber, 'GW2AR-LV18QN88C8/I7');
  assert.equal(demo.createdTime, 'Wed Oct 14 19:22:54 2026');
  assert.equal(demo.elapsed, '0h 2m 16s');

  const legacy = parseResourceReport(LEGACY_RPT).build;
  assert.equal(legacy.toolVersion, 'V1.9.9 Beta-4 Education');
  assert.equal(legacy.device, 'GW2AR-18');
});

test('readBuildHeader reads the same header without the body', () => {
  const full = parseResourceReport(DEMO_RPT).build;
  const head = readBuildHeader(DEMO_RPT);
  assert.deepEqual(head, full);
});

test('resource tables: headline rows, breakdown and utilization', () => {
  const r = parseResourceReport(DEMO_RPT);
  assert.equal(r.headline.logic.used, 11469);
  assert.equal(r.headline.logic.available, 20736);
  assert.equal(r.headline.logic.utilization, '56%');
  // The LUT/ALU split sits on the "--LUT,ALU,ROM16" sub-row under Logic.
  const split = r.resources.find((row) => row.breakdown);
  assert.equal(split.depth, 1);
  assert.deepEqual(split.breakdown, { LUT: 9243, ALU: 1416, ROM16: 0 });
  assert.equal(r.headline.cls.utilization, '77%');
  assert.equal(r.headline.bsram.used, 16);
  assert.ok(r.ioBanks.length >= 4, 'I/O bank table parsed');
  assert.ok(r.clockResources.length >= 1, 'clock resource table parsed');
});
