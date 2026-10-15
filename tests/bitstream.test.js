import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { readBitstream } from '../dist/bitstream.js';
import { DEMO, FMAXONLY } from './helpers.js';

const DEMO_FS = join(DEMO, 'impl', 'pnr', 'demo.fs');
const STALE_FS = join(DEMO, 'impl', 'pnr', 'stale.fs');
const FMAXONLY_FS = join(FMAXONLY, 'impl', 'pnr', 'fmaxonly.fs');

test('the .fs header: tool version, device, checksum, user code and creation time', () => {
  const b = readBitstream(DEMO_FS);
  assert.equal(b.path, DEMO_FS);
  assert.equal(b.toolVersion, 'V1.9.12.03 (64-bit) (86715)');
  assert.equal(b.device, 'GW2AR-18');
  assert.equal(b.deviceVersion, 'C');
  assert.equal(b.partNumber, 'GW2AR-LV18QN88C8/I7');
  assert.equal(b.devicePackage, 'GW2AR-18C-QFN88');
  assert.match(b.checksum, /^0x[0-9A-F]{4}$/);
  assert.match(b.userCode, /^0x[0-9A-F]{8}$/);
  assert.equal(b.createdTime, 'Wed Oct 14 19:22:50 2026');
  assert.equal(b.size, readFileSync(DEMO_FS).length);
  assert.equal(b.bodyLines, 6);
  assert.match(b.bodySha256, /^[0-9a-f]{64}$/);

  const g = readBitstream(FMAXONLY_FS);
  assert.deepEqual([g.device, g.deviceVersion, g.checksum, g.userCode], ['GW5AT-60', 'B', '0xDE97', '0x0000DE97']);
});

test('the body hash ignores the // header, so a rebuild with a new Created Time compares equal', () => {
  const a = readBitstream(DEMO_FS);
  const b = readBitstream(STALE_FS);
  assert.notEqual(a.createdTime, b.createdTime);
  assert.equal(a.bodySha256, b.bodySha256);
  assert.equal(a.bodyLines, b.bodyLines);
  assert.notEqual(a.bodySha256, readBitstream(FMAXONLY_FS).bodySha256, 'one data line differs');
});

test('releases up to V1.9.9 write the version as GOWIN Version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gowin-mcp-fs-'));
  const old = join(dir, 'old.fs');
  writeFileSync(
    old,
    readFileSync(DEMO_FS, 'utf8').replace('//Tool Version: V1.9.12.03 (64-bit) (86715)', '//GOWIN Version: V1.9.9 Beta-4 Education'),
  );
  const b = readBitstream(old);
  assert.equal(b.toolVersion, 'V1.9.9 Beta-4 Education');
  assert.equal(b.bodySha256, readBitstream(DEMO_FS).bodySha256);
});

test('CRLF and LF bodies hash the same', () => {
  const crlf = readFileSync(DEMO_FS, 'utf8');
  assert.ok(crlf.includes('\r\n'), 'the fixture is written with CRLF like the tool does');
  const dir = mkdtempSync(join(tmpdir(), 'gowin-mcp-fs-'));
  const lf = join(dir, 'lf.fs');
  writeFileSync(lf, crlf.replace(/\r\n/g, '\n'));
  assert.equal(readBitstream(lf).bodySha256, readBitstream(DEMO_FS).bodySha256);
});
