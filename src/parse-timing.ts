import { readFileSync } from 'node:fs';
import type { ClockEdge, ClockFmax, TimingPath, TimingReport, TnsRow } from './types.js';

/**
 * Parses `impl/pnr/<name>_tr_content.html`, the timing report body produced by
 * Gowin EDA. `<name>.tr.html` is only a ~350-byte frameset wrapper — the data
 * lives in the `_tr_content` sibling, which is routinely over a megabyte.
 *
 * Tables are read structurally (tr/td) rather than by flattening the document,
 * so column drift between tool versions surfaces as a missing field instead of
 * a silently misaligned number.
 *
 * The row parsers (parseFmax / parseTns / parsePaths) take plain string
 * cells, so parse-timing-text.ts feeds them the same tables cut out of the
 * `<name>.tr` plain-text report.
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

export function decode(s: string): string {
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

/** `clk_54m:[F]` -> `F`. */
function clockEdge(cell: string): ClockEdge | undefined {
  const m = cell.match(/:\[([RF])\]\s*$/);
  return m ? (m[1] as ClockEdge) : undefined;
}

export function headerHas(rows: string[][], ...needles: string[]): boolean {
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

export function parseFmax(rows: string[][]): ClockFmax[] {
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

export function parseTns(rows: string[][]): TnsRow[] {
  const out: TnsRow[] = [];
  for (const r of dataRows(rows, 'Analysis Type')) {
    // Clock Name | Analysis Type | TNS | Number of Endpoints
    if (r.length < 4) continue;
    const clock = r[0]?.trim();
    const analysis = r[1]?.trim();
    const tns = num(r[2]);
    const endpoints = num(r[3]);
    if (!clock || !analysis || tns == null) continue;
    // The text report writes "setup"/"hold"; the HTML "Setup"/"Hold".
    out.push({
      clock,
      analysis: analysis.charAt(0).toUpperCase() + analysis.slice(1),
      tns,
      endpoints: endpoints ?? 0,
    });
  }
  return out;
}

export function parsePaths(rows: string[][]): TimingPath[] {
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
      fromEdge: clockEdge(r[4] ?? ''),
      toEdge: clockEdge(r[5] ?? ''),
      relation: num(r[6]),
      clockSkew: num(r[7]),
      dataDelay: num(r[8]),
    });
  }
  return out;
}

export type PathKind = 'setup' | 'hold' | 'recovery' | 'removal';

/**
 * Every "<h2>/<h3>" heading with its document offset. The four path tables
 * share one column layout, so the only thing that tells them apart is the
 * heading immediately above each: "Setup Paths Table", "Hold Paths Table",
 * "Recovery Paths Table", "Removal Paths Table".
 */
function headings(html: string): { offset: number; text: string }[] {
  const out: { offset: number; text: string }[] = [];
  for (const m of html.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)) {
    out.push({ offset: m.index ?? 0, text: cellText(m[1]) });
  }
  return out;
}

export function pathKindFor(heading: string | undefined): PathKind | undefined {
  const m = heading?.match(/\b(Setup|Hold|Recovery|Removal)\s+Paths\s+Table/i);
  return m ? (m[1].toLowerCase() as PathKind) : undefined;
}

/** Worst slack first; the tool's own numbering survives in `index`. */
function bySlack(paths: TimingPath[]): TimingPath[] {
  return [...paths].sort((a, b) => a.slack - b.slack || a.index - b.index);
}

export interface TimingParts {
  fmax: ClockFmax[];
  tns: TnsRow[];
  paths: Record<PathKind, TimingPath[]>;
  clocksWithoutPaths: string[];
  recognized: boolean;
  format: 'html' | 'text';
}

/** Sorts the path tables and picks the worst of each; shared by both parsers. */
export function assembleTiming(p: TimingParts): TimingReport {
  const setupPaths = bySlack(p.paths.setup);
  const holdPaths = bySlack(p.paths.hold);
  return {
    fmax: p.fmax,
    clocksWithoutPaths: p.clocksWithoutPaths,
    tns: p.tns,
    setupPaths,
    holdPaths,
    recoveryPaths: bySlack(p.paths.recovery),
    removalPaths: bySlack(p.paths.removal),
    worstSetup: setupPaths[0],
    worstHold: holdPaths[0],
    recognized: p.recognized,
    format: p.format,
  };
}

export function parseTimingHtml(html: string): TimingReport {
  const tables = extractTables(html);
  const heads = headings(html);
  // Legacy fallback for a report with no section headings at all: anything
  // past the "Hold Paths" marker is hold, everything before it is setup.
  const holdMarker = html.search(/Hold\s+Paths\s+Table/i);

  let fmax: ClockFmax[] = [];
  let tns: TnsRow[] = [];
  let fmaxTableSeen = false;
  let tnsTableSeen = false;
  const paths: Record<PathKind, TimingPath[]> = {
    setup: [],
    hold: [],
    recovery: [],
    removal: [],
  };

  let h = 0;
  for (const t of tables) {
    if (headerHas(t.rows, 'Clock Name', 'Actual Fmax')) {
      fmaxTableSeen = true;
      fmax = fmax.concat(parseFmax(t.rows));
    } else if (headerHas(t.rows, 'Analysis Type', 'TNS')) {
      tnsTableSeen = true;
      tns = tns.concat(parseTns(t.rows));
    } else if (headerHas(t.rows, 'Path Slack', 'From Node')) {
      // Nearest heading above this table. Tables are in document order, so
      // the heading cursor only ever moves forward.
      while (h < heads.length && heads[h].offset < t.offset) h++;
      const above = h > 0 ? heads[h - 1].text : undefined;
      let kind = pathKindFor(above);
      if (!kind && !heads.length) kind = holdMarker >= 0 && t.offset > holdMarker ? 'hold' : 'setup';
      // A path-shaped table under some other heading (e.g. the per-exception
      // report) is not one of the four summaries; leave it out rather than
      // guess.
      if (kind) paths[kind] = paths[kind].concat(parsePaths(t.rows));
    }
  }

  const clocksWithoutPaths = [
    ...html.matchAll(/No timing paths to get frequency of ([^!<]+)!/g),
  ].map((m) => decode(m[1]).trim());

  return assembleTiming({
    fmax,
    tns,
    paths,
    clocksWithoutPaths,
    recognized: fmaxTableSeen || tnsTableSeen,
    format: 'html',
  });
}

export function parseTimingReport(trContentPath: string): TimingReport {
  return parseTimingHtml(readFileSync(trContentPath, 'utf8'));
}
