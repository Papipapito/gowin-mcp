import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { filterPinReport, parsePinReport, portMatcher } from '../dist/parse-pins.js';
import { DEMO, LEGACY } from './helpers.js';

test('ports, package pins and global clocks from a V1.9.12 report (CFG column present)', () => {
  const r = parsePinReport(join(DEMO, 'impl', 'pnr', 'demo.rpt.txt'));
  assert.equal(r.ports.length, 12);
  assert.equal(r.packagePins.length, 14);
  assert.equal(r.clocks.length, 8);

  const clk = r.ports.find((p) => p.port === 'CLK_27M');
  assert.deepEqual(
    { pin: clk.pin, bank: clk.bank, dir: clk.dir, ioType: clk.ioType, pull: clk.pull, cfg: clk.cfg, site: clk.site, constrained: clk.constrained, drive: clk.drive },
    { pin: '4', bank: '7', dir: 'in', ioType: 'LVCMOS33', pull: 'NONE', cfg: 'LPLL1_T_in', site: 'IOL7[A]', constrained: true, drive: 'NA' },
  );
  assert.equal(clk.diffPair, undefined, '"-" cells are absent');

  const free = r.packagePins.find((p) => p.pin === '85');
  assert.equal(free.signal, undefined);
  assert.equal(free.bank, '0');
  assert.equal(r.unusedPins, r.packagePins.filter((p) => !p.signal).length);

  assert.deepEqual(r.clocks[0], { signal: 'CLK_27M_d', type: 'PRIMARY', location: 'TR TL BR BL' });
});

test('a V1.9.9 report without the CFG column maps columns by name', () => {
  const r = parsePinReport(join(LEGACY, 'impl', 'pnr', 'legacy.rpt.txt'));
  assert.ok(r.ports.length > 0);
  const p = r.ports[0];
  assert.equal(p.port, 'ex_clk_27m');
  assert.equal(p.pin, '4');
  assert.equal(p.bank, '7');
  assert.equal(p.ioType, 'LVCMOS33', 'IO Type is still IO Type when CFG is missing');
  assert.equal(p.cfg, undefined);
  assert.equal(p.bankVccio, '3.3');
});

test('portMatcher: substring by default, glob with * and ?', () => {
  assert.equal(portMatcher(undefined)('anything'), true);
  assert.equal(portMatcher('sdram')('O_sdram_clk'), true);
  assert.equal(portMatcher('SDRAM')('O_sdram_clk'), true);
  assert.equal(portMatcher('tmds_*_p[0]')('tmds_data_p[0]'), true);
  assert.equal(portMatcher('tmds_*_p[0]')('tmds_data_p[1]'), false);
  assert.equal(portMatcher('CART_MUX_SIG[?]')('CART_MUX_SIG[3]'), true);
});

test('filterPinReport: port filters package pins by signal even with includeUnused', () => {
  const full = parsePinReport(join(DEMO, 'impl', 'pnr', 'demo.rpt.txt'));
  const free = full.packagePins.filter((p) => !p.signal);
  const data = full.packagePins.filter((p) => p.signal?.startsWith('CART_MUX'));
  assert.ok(free.length >= 1 && data.length >= 1 && data.length + free.length < full.packagePins.length);

  const narrow = filterPinReport(full, { port: 'CART_MUX*' });
  assert.ok(narrow.report.ports.length >= 1);
  assert.ok(narrow.report.ports.every((p) => p.port.startsWith('CART_MUX')));
  assert.deepEqual(narrow.report.packagePins, data, 'used pins whose signal matches, nothing else');
  assert.deepEqual(narrow.unused, []);
  assert.equal(narrow.report.unusedPins, full.unusedPins, 'the count is still for the whole package');

  const withFree = filterPinReport(full, { port: 'CART_MUX*', includeUnused: true });
  assert.equal(withFree.report.packagePins.length, data.length + free.length, 'matching signals plus the free pins');
  assert.ok(withFree.report.packagePins.every((p) => !p.signal || p.signal.startsWith('CART_MUX')));
  assert.deepEqual(withFree.unused, free);

  const noClocks = filterPinReport(full, { includeClocks: false });
  assert.deepEqual(noClocks.report.clocks, []);
  assert.equal(noClocks.report.ports.length, full.ports.length);
  assert.equal(noClocks.report.packagePins.length, full.packagePins.length - free.length, 'free pins only with includeUnused');
});
