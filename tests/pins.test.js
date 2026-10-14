import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { parsePinReport, portMatcher } from '../dist/parse-pins.js';
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
