import { readFileSync } from 'node:fs';
import type { ClockFmax, TimingPath, TimingReport, TnsRow } from './types.js';

/**
 * Parses `impl/pnr/<name>_tr_content.html`, the timing report body produced by
 * Gowin EDA. `<name>.tr.html` is only a ~350-byte frameset wrapper — the data
 * lives in the `_tr_content` sibling, which is routinely over a megabyte.
 *
 * Tables are read structurally (tr/td) rather than by flattening the document,
 * so column drift between tool versions surfaces as a missing field instead of
 * a silently misaligned number.
 */

interface RawTable {
  offset: number;
  rows: string[][];
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decode(s: string): string {
  return s
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function cellText(html: string): string {
  return decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractTables(html: string): RawTable[] {
  const tables: RawTable[] = [];
  for (const t of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows: string[][] = [];
    for (const r of t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells: string[] = [];
      for (const c of r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        cells.push(cellText(c[1]));
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push({ offset: t.index ?? 0, rows });
  }
  return tables;
}

/** `50.000(MHz)` -> 50, `-1.826` -> -1.826, junk -> undefined. */
function num(cell: string | undefined): number | undefined {
  if (cell == null) return undefined;
  const m = cell.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

/** `clk_54m:[R]` -> `clk_54m`. */
function bareClock(cell: string): string {
  return cell.replace(/:\[[^\]]*\]\s*$/, '').trim();
}

function headerHas(rows: string[][], ...needles: string[]): boolean {
  const head = rows.slice(0, 3).flat().join(' ').toLowerCase();
  return needles.every((n) => head.includes(n.toLowerCase()));
}

/** Drops header rows so only data survives. */
function dataRows(rows: string[][], headerNeedle: string): string[][] {
  const idx = rows.findIndex((r) =>
    r.join(' ').toLowerCase().includes(headerNeedle.toLowerCase()),
  );
  return idx >= 0 ? rows.slice(idx + 1) : rows;
}

function parseFmax(rows: string[][]): ClockFmax[] {
  const out: ClockFmax[] = [];
  for (const r of dataRows(rows, 'Actual Fmax')) {
    // NO. | Clock Name | Constraint | Actual Fmax | Logic Level | Entity
    if (r.length < 4) continue;
    const clock = r[1]?.trim();
    const constraintMhz = num(r[2]);
    const actualMhz = num(r[3]);
    if (!clock || constraintMhz == null || actualMhz == null) continue;

    out.push({
      clock,
      constraintMhz,
      actualMhz,
      logicLevel: num(r[4]),
      entity: r[5]?.trim() || undefined,
      failing: actualMhz < constraintMhz,
      marginMhz: Number((actualMhz - constraintMhz).toFixed(3)),
    });
  }
  return out;
}

function parseTns(rows: string[][]): TnsRow[] {
  const out: TnsRow[] = [];
  for (const r of dataRows(rows, 'Analysis Type')) {
    // Clock Name | Analysis Type | TNS | Number of Endpoints
    if (r.length < 4) continue;
    const clock = r[0]?.trim();
    const analysis = r[1]?.trim();
    const tns = num(r[2]);
    const endpoints = num(r[3]);
    if (!clock || !analysis || tns == null) continue;
    out.push({ clock, analysis, tns, endpoints: endpoints ?? 0 });
  }
  return out;
}

function parsePaths(rows: string[][]): TimingPath[] {
  const out: TimingPath[] = [];
  for (const r of dataRows(rows, 'Path Slack')) {
    // Path Number | Path Slack | From Node | To Node | From Clock | To Clock
    //            | Relation | Clock Skew | Data Delay
    if (r.length < 6) continue;
    const index = num(r[0]);
    const slack = num(r[1]);
    if (index == null || slack == null) continue;

    out.push({
      index,
      slack,
      from: r[2]?.trim() ?? '',
      to: r[3]?.trim() ?? '',
      fromClock: bareClock(r[4] ?? ''),
      toClock: bareClock(r[5] ?? ''),
      relation: num(r[6]),
      clockSkew: num(r[7]),
      dataDelay: num(r[8]),
    });
  }
  return out;
}

export function parseTimingReport(trContentPath: string): TimingReport {
  const html = readFileSync(trContentPath, 'utf8');
  const tables = extractTables(html);

  // Setup and hold path tables share an identical header, so they are told
  // apart by document position relative to the "Hold Paths" heading.
  const holdMarker = html.search(/Hold\s+Paths\s+Table/i);

  let fmax: ClockFmax[] = [];
  let tns: TnsRow[] = [];
  let setupPaths: TimingPath[] = [];
  let holdPaths: TimingPath[] = [];

  for (const t of tables) {
    if (headerHas(t.rows, 'Clock Name', 'Actual Fmax')) {
      fmax = fmax.concat(parseFmax(t.rows));
    } else if (headerHas(t.rows, 'Analysis Type', 'TNS')) {
      tns = tns.concat(parseTns(t.rows));
    } else if (headerHas(t.rows, 'Path Slack', 'From Node')) {
      const paths = parsePaths(t.rows);
      if (holdMarker >= 0 && t.offset > holdMarker) holdPaths = holdPaths.concat(paths);
      else setupPaths = setupPaths.concat(paths);
    }
  }

  const clocksWithoutPaths = [
    ...html.matchAll(/No timing paths to get frequency of ([^!<]+)!/g),
  ].map((m) => decode(m[1]).trim());

  return { fmax, clocksWithoutPaths, tns, setupPaths, holdPaths };
}
