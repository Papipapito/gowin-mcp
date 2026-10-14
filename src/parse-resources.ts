import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import type { BuildInfo, ResourceReport, ResourceRow } from './types.js';

/**
 * Parses `impl/pnr/<name>.rpt.txt`, the plain-text PnR report emitted by
 * Gowin EDA. The HTML sibling carries the same numbers but the text form is
 * stable across tool versions and far cheaper to read.
 */

const HEADER_KEYS: Record<string, keyof BuildInfo> = {
  // Gowin renamed this field: releases up to ~1.9.9 write "PnR Version",
  // later ones write "Tool Version". Both mean the same thing.
  'Tool Version': 'toolVersion',
  'PnR Version': 'toolVersion',
  'Part Number': 'partNumber',
  Device: 'device',
  'Device Version': 'deviceVersion',
  'Created Time': 'createdTime',
  'Design File': 'designFile',
  'Physical Constraints File': 'constraintsFile',
  'Timing Constraints File': 'sdcFile',
};

function parseHeader(text: string, implDir: string, name: string): BuildInfo {
  const info: BuildInfo = { implDir, name };
  // Lines look like:  <Tool Version>: V1.9.11.03 Education
  // Created Time omits the space after the colon, hence \s* rather than \s.
  for (const m of text.matchAll(/^\s*<([^>]+)>:\s*(.+?)\s*$/gm)) {
    const key = HEADER_KEYS[m[1]];
    if (key) (info as unknown as Record<string, unknown>)[key] = m[2];
  }

  const total = text.match(
    /Total Time and Memory Usage:.*?Elapsed time = ([^,]+),\s*Peak memory usage = (\S+)/,
  );
  if (total) {
    info.elapsed = total[1].trim();
    info.peakMemory = total[2].trim();
  }
  return info;
}

/** `28034/59904` -> [28034, 59904];  `471` -> [471, undefined]. */
function parseUsage(cell: string): { used?: number; available?: number } {
  const frac = cell.match(/^([\d.]+)\s*\/\s*([\d.]+)/);
  if (frac) return { used: Number(frac[1]), available: Number(frac[2]) };
  const single = cell.match(/^([\d.]+)/);
  if (single) return { used: Number(single[1]) };
  return {};
}

/** `25208(21883 LUT, 3325 ALU, 0 ROM16)` -> {LUT: 21883, ALU: 3325, ROM16: 0}. */
function parseBreakdown(cell: string): Record<string, number> | undefined {
  const inner = cell.match(/\(([^)]+)\)/);
  if (!inner) return undefined;
  const out: Record<string, number> = {};
  for (const part of inner[1].split(',')) {
    const m = part.trim().match(/^([\d.]+)\s+(.+)$/);
    if (m) out[m[2].trim()] = Number(m[1]);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Reads a pipe-delimited Gowin table that starts after `heading` and ends at
 * the `====` rule. Separator rows (`----`) and the column header are skipped.
 */
function parseTable(text: string, heading: RegExp): ResourceRow[] {
  const start = text.search(heading);
  if (start < 0) return [];
  const rest = text.slice(start);
  const end = rest.search(/^\s*={3,}\s*$/m);
  const body = end > 0 ? rest.slice(0, end) : rest;

  const rows: ResourceRow[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes('|')) continue;
    if (/^\s*-{3,}/.test(line)) continue;

    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 2) continue;

    let name = cells[0];
    if (!name) continue;
    // Column header of the table itself.
    if (/^Resources?$/i.test(name) || /^I\/O Bank$/i.test(name)) continue;
    if (/^Clock Resource$/i.test(name)) continue;

    let depth = 0;
    if (name.startsWith('--')) {
      depth = 1;
      name = name.replace(/^-+/, '').trim();
    }

    const usageCell = cells[1] ?? '';
    const utilCell = (cells[2] ?? '').trim();
    const { used, available } = parseUsage(usageCell);

    rows.push({
      name,
      depth,
      used,
      available,
      utilization: utilCell && utilCell !== '-' ? utilCell : undefined,
      raw: usageCell,
      breakdown: parseBreakdown(usageCell),
    });
  }
  return rows;
}

/**
 * Reads only the "PnR Messages" header of a report — device, tool version,
 * timestamps. The header sits in the first kilobyte, so this avoids loading
 * the (50-120 KB) report body, let alone the timing HTML, when listing many
 * builds.
 */
export function readBuildHeader(rptTxtPath: string): BuildInfo {
  const name = basename(rptTxtPath).replace(/\.rpt\.txt$/i, '');
  const implDir = rptTxtPath.replace(/[\\/]pnr[\\/][^\\/]+$/i, '');

  const buf = Buffer.alloc(4096);
  const fd = openSync(rptTxtPath, 'r');
  let head = '';
  try {
    head = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0));
  } finally {
    closeSync(fd);
  }
  // "Created Time" is the last header field; if the chunk stopped short of
  // it, the file has an unusual preamble — fall back to reading all of it.
  if (!/<Created Time>/.test(head)) head = readFileSync(rptTxtPath, 'utf8');
  return parseHeader(head, implDir, name);
}

function pick(rows: ResourceRow[], name: string): ResourceRow | undefined {
  return rows.find((r) => r.depth === 0 && r.name.toLowerCase() === name.toLowerCase());
}

export function parseResourceReport(rptTxtPath: string): ResourceReport {
  const text = readFileSync(rptTxtPath, 'utf8');
  const name = basename(rptTxtPath).replace(/\.rpt\.txt$/i, '');
  const implDir = rptTxtPath.replace(/[\\/]pnr[\\/][^\\/]+$/i, '');

  const build = parseHeader(text, implDir, name);
  const resources = parseTable(text, /^\s*\d*\.?\s*Resource Usage Summary/m);
  const ioBanks = parseTable(text, /^\s*\d*\.?\s*I\/O Bank Usage Summary/m);
  const clockResources = parseTable(text, /^\s*\d*\.?\s*Clock Resource Usage Summary/m);

  return {
    build,
    resources,
    ioBanks,
    clockResources,
    headline: {
      logic: pick(resources, 'Logic'),
      cls: pick(resources, 'CLS'),
      register: pick(resources, 'Register'),
      bsram: pick(resources, 'BSRAM'),
      dsp: pick(resources, 'DSP'),
      ioPort: pick(resources, 'I/O Port'),
    },
  };
}
