import { readFileSync } from 'node:fs';
import {
  assembleTiming,
  headerHas,
  parseFmax,
  parsePaths,
  parseTns,
  pathKindFor,
} from './parse-timing.js';
import type { PathKind } from './parse-timing.js';
import type { ClockFmax, TimingPath, TimingReport, TnsRow } from './types.js';

/**
 * Parses `impl/pnr/<name>.tr`, the plain-text twin of the timing report that
 * Gowin EDA V1.9.12.04 writes on every run (earlier releases only on request).
 * It is the fallback when `_tr_content.html` is missing: same sections, same
 * numbers, a third of the size.
 *
 * Every table is a header line, a rule of `=` runs, and rows indented by at
 * least one space:
 *
 *     NO.   Clock Name   Constraint     Actual Fmax    Level   Entity
 *    ===== ============ ============== ============== ======= ========
 *     1     clk_108m     108.003(MHz)   153.992(MHz)   10      TOP
 *   No timing paths to get frequency of clk27!
 *
 * Cells are sliced by the column spans of the rule, not split on whitespace:
 * the Clock Summary leaves Source/Master empty for base clocks, and a split
 * would shift every cell after the gap. A line at column 0 ends the table.
 */

const RULE = /^\s*=+( =+)+\s*$/;
/** "2.3 Max Frequency Summary", "3.1.1 Setup Paths Table" — the directory copies are tab-indented and do not match. */
const HEADING = /^\d+(\.\d+)*\.?\s+\S/;

interface TextTable {
  heading: string;
  /** rows[0] is the column header. */
  rows: string[][];
}

export function extractTextTables(text: string): TextTable[] {
  const lines = text.split(/\r?\n/);
  const out: TextTable[] = [];
  let heading = '';
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (HEADING.test(l)) {
      heading = l.trim();
      continue;
    }
    if (!RULE.test(l)) continue;
    const spans = [...l.matchAll(/=+/g)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const);
    const last = spans.length - 1;
    const slice = (s: string): string[] =>
      spans.map(([a, b], k) => (k === last ? s.slice(a) : s.slice(a, b)).trim());
    const rows = [slice(lines[i - 1])];
    let j = i + 1;
    for (; j < lines.length && /^\s/.test(lines[j]) && lines[j].trim(); j++) rows.push(slice(lines[j]));
    out.push({ heading, rows });
    i = j - 1;
  }
  return out;
}

export function parseTimingText(text: string): TimingReport {
  let fmax: ClockFmax[] = [];
  let tns: TnsRow[] = [];
  let fmaxTableSeen = false;
  let tnsTableSeen = false;
  const paths: Record<PathKind, TimingPath[]> = { setup: [], hold: [], recovery: [], removal: [] };

  for (const t of extractTextTables(text)) {
    if (headerHas(t.rows, 'Clock Name', 'Actual Fmax')) {
      fmaxTableSeen = true;
      fmax = fmax.concat(parseFmax(t.rows));
    } else if (headerHas(t.rows, 'Analysis Type', 'TNS')) {
      tnsTableSeen = true;
      tns = tns.concat(parseTns(t.rows));
    } else if (headerHas(t.rows, 'Path Slack', 'From Node')) {
      const kind = pathKindFor(t.heading);
      if (kind) paths[kind] = paths[kind].concat(parsePaths(t.rows));
    }
  }

  const clocksWithoutPaths = [
    ...text.matchAll(/No timing paths to get frequency of ([^!\r\n]+)!/g),
  ].map((m) => m[1].trim());

  return assembleTiming({
    fmax,
    tns,
    paths,
    clocksWithoutPaths,
    recognized: fmaxTableSeen || tnsTableSeen,
    format: 'text',
  });
}

export function parseTimingTextReport(trPath: string): TimingReport {
  return parseTimingText(readFileSync(trPath, 'utf8'));
}
