import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { clockExceptions, findSdc, parseSdc, readSdc } from '../dist/sdc.js';
import { DEMO, FMAXONLY } from './helpers.js';

const SDC = join(FMAXONLY, 'constraints', 'fmaxonly.sdc');

test('parseSdc: clocks and exception commands, comments in both styles ignored', () => {
  const s = parseSdc(readFileSync(SDC, 'utf8'));
  assert.equal(s.clocks.length, 15);
  assert.ok(s.clocks.includes('clk_54m') && s.clocks.includes('ddr_clk1x'));
  assert.equal(s.multicyclePaths.length, 6);
  assert.equal(s.falsePaths.length, 2, 'the set_false_path inside a // comment does not count');
  assert.equal(s.clockGroups.length, 3);
  assert.ok(s.multicyclePaths.every((c) => c.startsWith('set_multicycle_path -from [get_clocks {clk_54m}]')));

  const inline = parseSdc('create_clock -name a -period 10 [get_ports x] # trailing comment\nset_false_path -from [get_clocks a] // and another\n');
  assert.deepEqual(inline.clocks, ['a']);
  assert.deepEqual(inline.falsePaths, ['set_false_path -from [get_clocks a]']);
});

test('clockExceptions counts the commands that name a clock as a whole token', () => {
  const s = { readable: true, ...parseSdc(readFileSync(SDC, 'utf8')) };
  assert.deepEqual(clockExceptions(s, 'clk_54m'), { multicycle: 6, falsePath: 0, clockGroups: 3 });
  assert.deepEqual(clockExceptions(s, 'clk_5'), { multicycle: 0, falsePath: 0, clockGroups: 0 }, 'prefix of a name is not a match');
  assert.deepEqual(clockExceptions(s, 'clk_86'), { multicycle: 0, falsePath: 0, clockGroups: 2 });
  assert.deepEqual(clockExceptions(undefined, 'clk_54m'), { multicycle: 0, falsePath: 0, clockGroups: 0 });
  assert.deepEqual(clockExceptions({ ...s, readable: false }, 'clk_54m'), { multicycle: 0, falsePath: 0, clockGroups: 0 });
});

test('findSdc falls back to the file name under the project when the reported path is gone', () => {
  assert.equal(findSdc('C:\\work\\fmaxonly\\constraints\\fmaxonly.sdc', FMAXONLY), SDC);
  assert.equal(findSdc('/somewhere/else/fmaxonly.sdc', FMAXONLY), SDC, 'posix path, same file name');
  assert.equal(findSdc('C:\\work\\demo\\constraints\\demo.sdc', DEMO), undefined, 'demo has no .sdc copy');
  assert.equal(findSdc(undefined, DEMO), undefined);
  assert.equal(findSdc(SDC, FMAXONLY), SDC, 'an existing path is used as is');

  const r = readSdc('C:\\work\\demo\\constraints\\demo.sdc', DEMO);
  assert.equal(r.readable, false);
  assert.equal(r.reported, 'C:\\work\\demo\\constraints\\demo.sdc');
  assert.equal(r.path, undefined);
  assert.deepEqual(r.clocks, []);
});
