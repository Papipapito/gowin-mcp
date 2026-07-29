import { parseResourceReport } from './parse-resources.js';
import { parseTimingReport } from './parse-timing.js';
import type { FoundBuild } from './discover.js';
import type {
  BuildSummary,
  ClockFmax,
  ResourceReport,
  TimingReport,
  Violation,
} from './types.js';

/** Loads and cross-checks the two reports that make up one build. */
export interface LoadedBuild {
  found: FoundBuild;
  resources: ResourceReport;
  timing?: TimingReport;
}

export function loadBuild(found: FoundBuild): LoadedBuild {
  return {
    found,
    resources: parseResourceReport(found.rptTxt),
    timing: found.trContent ? parseTimingReport(found.trContent) : undefined,
  };
}

/**
 * Collects every timing failure into one list.
 *
 * Setup and hold come from the TNS summary rather than the path tables: the
 * path tables are capped by `-max_paths` at report time, so a design with more
 * violations than the cap would under-report. TNS is always complete.
 */
export function findViolations(timing: TimingReport | undefined): Violation[] {
  if (!timing) return [];
  const out: Violation[] = [];

  for (const row of timing.tns) {
    if (row.tns >= 0) continue;
    const kind = row.analysis.toLowerCase() === 'hold' ? 'hold' : 'setup';
    out.push({
      kind,
      clock: row.clock,
      amount: row.tns,
      unit: 'ns',
      detail: `${row.endpoints} endpoint${row.endpoints === 1 ? '' : 's'} failing ${kind}`,
    });
  }

  // A clock that misses its constraint almost always shows up as a setup
  // violation too. Reporting both is the same defect counted twice, so fMax is
  // only raised when nothing in the TNS summary already covers that clock —
  // which is itself worth surfacing, since it means the constraint is missing
  // or the path was excluded from analysis.
  const clocksWithSlackViolation = new Set(
    out.filter((v) => v.kind === 'setup').map((v) => v.clock),
  );
  for (const f of timing.fmax) {
    if (!f.failing || clocksWithSlackViolation.has(f.clock)) continue;
    out.push({
      kind: 'fmax',
      clock: f.clock,
      amount: f.marginMhz,
      unit: 'MHz',
      detail: `${f.actualMhz} MHz achieved against a ${f.constraintMhz} MHz constraint, with no setup violation reported — check the constraint covers this domain`,
    });
  }

  // Worst first: most negative slack, then largest frequency shortfall.
  out.sort((a, b) => a.amount - b.amount);
  return out;
}

/** Attaches the worst offending path to each setup/hold violation, when known. */
export function explainViolation(
  v: Violation,
  timing: TimingReport | undefined,
): string {
  if (!timing || v.kind === 'fmax') return v.detail;
  const pool = v.kind === 'hold' ? timing.holdPaths : timing.setupPaths;
  const worst = pool
    .filter((p) => p.fromClock === v.clock || p.toClock === v.clock)
    .sort((a, b) => a.slack - b.slack)[0];
  if (!worst) return v.detail;
  return `${v.detail} — worst path ${worst.slack} ns: ${worst.from} -> ${worst.to}`;
}

export function summarize(loaded: LoadedBuild): BuildSummary {
  const violations = findViolations(loaded.timing);
  return {
    build: loaded.resources.build,
    resources: loaded.resources.headline,
    timing: {
      fmax: loaded.timing?.fmax ?? [],
      violations,
    },
    clean: violations.length === 0,
  };
}

/** Human-readable one-liner for a resource row, e.g. "CLS 19618/29952 (66%)". */
export function formatResource(
  label: string,
  row: { used?: number; available?: number; utilization?: string } | undefined,
): string {
  if (!row || row.used == null) return `${label}: n/a`;
  const of = row.available != null ? `/${row.available}` : '';
  const pct = row.utilization ? ` (${row.utilization})` : '';
  return `${label}: ${row.used}${of}${pct}`;
}

export function formatFmax(f: ClockFmax): string {
  const mark = f.failing ? 'FAIL' : 'ok';
  const sign = f.marginMhz >= 0 ? '+' : '';
  return `${f.clock}: ${f.actualMhz} MHz vs ${f.constraintMhz} MHz constraint (${sign}${f.marginMhz}) [${mark}]`;
}
