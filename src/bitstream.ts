import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BitstreamInfo } from './types.js';

/**
 * Reads `impl/pnr/<name>.fs`, the ASCII bitstream Gowin EDA writes: a block
 * of `//Key: value` header lines followed by the configuration data as lines
 * of 0/1 characters. The header carries the tool version, device, checksum
 * and creation time; the body is what gets programmed.
 *
 * The body is hashed with the `//` lines left out, so two files built from
 * the same netlist and placement compare equal even though every build
 * rewrites `//Created Time`.
 */

const HEADER_KEYS: Record<string, keyof BitstreamInfo> = {
  'Tool Version': 'toolVersion',
  // Releases up to V1.9.9 wrote the version under this key.
  'GOWIN Version': 'toolVersion',
  Device: 'device',
  'Device Version': 'deviceVersion',
  'Part Number': 'partNumber',
  'Device-package': 'devicePackage',
  CheckSum: 'checksum',
  UserCode: 'userCode',
  'Created Time': 'createdTime',
};

const SLASH = 0x2f;
const LF = 0x0a;
const CR = 0x0d;

export function readBitstream(path: string): BitstreamInfo {
  const buf = readFileSync(path);
  const info: BitstreamInfo = { path, size: buf.length, bodySha256: '', bodyLines: 0 };
  const hash = createHash('sha256');
  let lines = 0;
  let pos = 0;
  while (pos < buf.length) {
    let nl = buf.indexOf(LF, pos);
    if (nl < 0) nl = buf.length;
    let end = nl;
    if (end > pos && buf[end - 1] === CR) end--;
    if (buf[pos] === SLASH && buf[pos + 1] === SLASH) {
      const m = buf.toString('utf8', pos + 2, end).match(/^([^:]+):\s*(.*?)\s*$/);
      const key = m ? HEADER_KEYS[m[1].trim()] : undefined;
      if (m && key) (info as unknown as Record<string, unknown>)[key] = m[2];
    } else if (end > pos) {
      hash.update(buf.subarray(pos, end));
      hash.update('\n');
      lines++;
    }
    pos = nl + 1;
  }
  info.bodySha256 = hash.digest('hex');
  info.bodyLines = lines;
  return info;
}
