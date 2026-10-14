import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBuild } from '../dist/discover.js';
import { loadBuild } from '../dist/analyze.js';
import { parseLogText, pattern, quoted, readWarnings } from '../dist/parse-log.js';
import { DEMO, LEGACY, pinFixtureTimes } from './helpers.js';

pinFixtureTimes();

test('log lines: level, code, message and source location', () => {
  const msgs = parseLogText(
    [
      'Running placement......',
      "WARN  (TA1132) :  'u_top/u_div27/CLKOUT.default_gen_clk' was determined to be a clock but was not created.",
      'ERROR  (CT1135) : "C:\\work\\demo\\constraints\\demo.cst":12 | Can\'t find object named \'u_top/u_missing\'',
      'WARN  (EX2478) : Non-net output port \'cx\' cannot be initialized at declaration in SystemVerilog mode("C:\\work\\demo\\hdmi\\hdmi.sv":83)',
      'ERROR (EX3937) : Instantiating unknown module \'foo\'',
    ].join('\n'),
    'pnr',
  );
  assert.equal(msgs.length, 4);
  assert.deepEqual(
    msgs.map((m) => [m.level, m.code, m.file, m.line]),
    [
      ['WARN', 'TA1132', undefined, undefined],
      ['ERROR', 'CT1135', 'C:\\work\\demo\\constraints\\demo.cst', 12],
      ['WARN', 'EX2478', 'C:\\work\\demo\\hdmi\\hdmi.sv', 83],
      ['ERROR', 'EX3937', undefined, undefined],
    ],
  );
  assert.equal(msgs[1].message, "Can't find object named 'u_top/u_missing'", 'leading location stripped');
  assert.equal(msgs[2].message, "Non-net output port 'cx' cannot be initialized at declaration in SystemVerilog mode");
});

test('pattern and quoted: an apostrophe is not a quote', () => {
  const ta1117 = 'Can\'t calculate clocks\' relationship between: "u_top/u_divdac/CLKOUT.default_gen_clk" and "clk_54m"';
  assert.equal(pattern(ta1117), "Can't calculate clocks' relationship between: X and X");
  assert.deepEqual(quoted(ta1117), ['u_top/u_divdac/CLKOUT.default_gen_clk', 'clk_54m']);

  const ex0200 = 'Property "syn_ramstyle" set invalid for "mem_simple_dual_port_async_read(DATA_WIDTH=8,DEPTH=32\'b00000000000000000000000000001001)"';
  assert.equal(pattern(ex0200), 'Property X set invalid for X', "the 32'b literal inside the name does not end the quote");
  assert.deepEqual(quoted(ex0200), ['syn_ramstyle', "mem_simple_dual_port_async_read(DATA_WIDTH=8,DEPTH=32'b00000000000000000000000000001001)"]);

  assert.equal(pattern("Can't find object named 'u_top/u_missing'"), "Can't find object named X");
  assert.equal(pattern("'u_top/u_div27/CLKOUT.default_gen_clk' was determined to be a clock but was not created."), 'X was determined to be a clock but was not created.');
  assert.deepEqual(quoted("'u_top/u_div27/CLKOUT.default_gen_clk' was determined to be a clock"), ['u_top/u_div27/CLKOUT.default_gen_clk']);
  assert.equal(pattern('Expression size 8 truncated to fit in target size 7'), 'Expression size N truncated to fit in target size N');
});

test('readWarnings groups by code and cross-checks TA1132 with the timing report', () => {
  const found = resolveBuild(DEMO);
  const b = loadBuild(found);
  const r = readWarnings(found, b.timing.clocksWithoutPaths);

  assert.ok(r.logs.pnr && r.logs.synthesis);
  assert.equal(r.totals.errors, 1);
  assert.ok(r.totals.warnings > 10);
  assert.equal(r.groups[0].code, 'CT1135', 'errors sort first');
  assert.equal(r.groups[0].locations[0], 'constraints/demo.cst:12');
  assert.equal(r.groups[0].pattern, "Can't find object named X");

  const ta = r.groups.find((g) => g.code === 'TA1132');
  assert.equal(ta.count, 3);
  assert.equal(ta.stage, 'pnr');
  assert.match(ta.hint, /create_clock/);

  const rel = r.groups.find((g) => g.code === 'TA1117');
  assert.equal(rel.count, 2);
  assert.equal(rel.pattern, "Can't calculate clocks' relationship between: X and X");

  const ex = r.groups.find((g) => g.code === 'EX2478');
  assert.ok(ex.count >= 2);
  assert.equal(ex.stage, 'synthesis');
  assert.ok(ex.locations.every((l) => /\.sv:\d+$/.test(l) || /\.v:\d+$/.test(l)));

  assert.deepEqual(r.unconstrainedClocks, [
    { clock: 'u_top/u_div5m4/CLKOUT.default_gen_clk', noTimingPaths: true },
    { clock: 'u_top/u_div27/CLKOUT.default_gen_clk', noTimingPaths: false },
    { clock: 'u_top/u_divdac/CLKOUT.default_gen_clk', noTimingPaths: false },
  ]);
  assert.deepEqual(r.notes, []);
});

test('missing logs are reported, not invented', () => {
  const r = readWarnings(resolveBuild(LEGACY), undefined);
  assert.equal(r.logs.pnr, undefined);
  assert.equal(r.logs.synthesis, undefined);
  assert.equal(r.groups.length, 0);
  assert.equal(r.notes.length, 2);
});
