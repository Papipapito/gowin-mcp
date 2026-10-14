import { parseResourceReport } from './parse-resources.js';
import { parseTimingReport } from './parse-timing.js';
import type { FoundBuild } from './discover.js';
import type {
  BuildSummary,
  CheckResult,
  CheckStatus,
  CheckThresholds,
  ClockFmax,
  ResourceReport,
  ResourceRow,
  ThresholdFailure,
  TimingPath,
  TimingReport,
  TimingVerdict,
  TnsRow,
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

export interface ViolationOptions {
  /** Leave out cross-domain path violations (see CheckThresholds.ignoreCrossDomain). */
  ignoreCrossDomain?: boolean;
}

type SlackKind = 'setup' | 'hold';

function tnsKind(row: TnsRow): SlackKind {
  return row.analysis.toLowerCase() === 'hold' ? 'hold' : 'setup';
}

/** Setup and hold violations as the TNS summary states them. */
function tnsViolations(timing: TimingReport): Violation[] {
  const out: Violation[] = [];
  for (const row of timing.tns) {
    if (row.tns >= 0) continue;
    const kind = tnsKind(row);
    out.push({
      kind,
      source: 'tns',
      clock: row.clock,
      amount: row.tns,
      unit: 'ns',
      detail: `${row.endpoints} endpoint${row.endpoints === 1 ? '' : 's'} failing ${kind}`,
    });
  }
  return out;
}

/**
 * Negative slack in the path tables that the TNS summary does not account
 * for, one violation per (from clock, to clock) pair.
 *
 * Gowin's TNS is per clock and leaves out paths whose launch and capture
 * clocks differ: a design can show every TNS row at 0.000 while the setup
 * table opens with a -2 ns clock_54m -> clock_27m path. A pair is only
 * reported here when neither of its clocks already has a negative TNS row of
 * the same kind, so a defect the TNS does count is not listed twice.
 *
 * The path tables are capped by `-max_paths`, so the count is a lower bound.
 */
function pathViolations(timing: TimingReport): Violation[] {
  const out: Violation[] = [];
  const pools: [SlackKind, TimingPath[]][] = [
    ['setup', timing.setupPaths],
    ['hold', timing.holdPaths],
  ];
  for (const [kind, pool] of pools) {
    const counted = new Set(
      timing.tns.filter((r) => r.tns < 0 && tnsKind(r) === kind).map((r) => r.clock),
    );
    const byPair = new Map<string, TimingPath[]>();
    for (const p of pool) {
      if (p.slack >= 0) continue;
      if (counted.has(p.fromClock) || counted.has(p.toClock)) continue;
      const key = `${p.fromClock}\u0000${p.toClock}`;
      const list = byPair.get(key);
      if (list) list.push(p);
      else byPair.set(key, [p]);
    }
    for (const paths of byPair.values()) {
      paths.sort((a, b) => a.slack - b.slack);
      const worst = paths[0];
      const crossDomain = worst.fromClock !== worst.toClock;
      const n = paths.length;
      const pair = `${worst.fromClock} -> ${worst.toClock}`;
      out.push({
        kind,
        source: 'paths',
        clock: crossDomain ? pair : worst.fromClock,
        fromClock: worst.fromClock,
        toClock: worst.toClock,
        crossDomain,
        pathCount: n,
        amount: worst.slack,
        unit: 'ns',
        detail:
          `at least ${n} ${kind} path${n === 1 ? '' : 's'} ${pair} failing, not counted in the TNS` +
          `${crossDomain ? ' (clock domain crossing)' : ''}; worst ${worst.slack} ns: ${worst.from} -> ${worst.to}`,
      });
    }
  }
  return out;
}

/** The cross-domain path violations `ignoreCrossDomain` leaves out of the decision. */
export function crossDomainViolations(timing: TimingReport | undefined): Violation[] {
  if (!timing) return [];
  return pathViolations(timing).filter((v) => v.crossDomain);
}

/**
 * Collects every timing failure into one list.
 *
 * Setup and hold come first from the TNS summary, which is complete for what
 * it counts (the path tables are capped by `-max_paths`), then from the path
 * tables for the negative slack the TNS leaves out: paths between clock
 * domains. See pathViolations.
 */
export function findViolations(
  timing: TimingReport | undefined,
  opts: ViolationOptions = {},
): Violation[] {
  if (!timing) return [];
  const out = [
    ...tnsViolations(timing),
    ...pathViolations(timing).filter((v) => !(opts.ignoreCrossDomain && v.crossDomain)),
  ];

  // A clock that misses its constraint almost always shows up as a setup
  // violation too. Reporting both is the same defect counted twice, so fMax is
  // only raised when nothing in the TNS summary already covers that clock —
  // which is itself worth surfacing, since it means the constraint is missing
  // or the path was excluded from analysis.
  const clocksWithSlackViolation = new Set<string>();
  for (const v of out) {
    if (v.kind !== 'setup') continue;
    clocksWithSlackViolation.add(v.clock);
    if (v.fromClock) clocksWithSlackViolation.add(v.fromClock);
    if (v.toClock) clocksWithSlackViolation.add(v.toClock);
  }
  for (const f of timing.fmax) {
    if (!f.failing || clocksWithSlackViolation.has(f.clock)) continue;
    out.push({
      kind: 'fmax',
      source: 'fmax',
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

/**
 * What the timing report lets us say about the build.
 *
 * "No violations found" is only meaningful when a report was actually read
 * and understood. A missing `_tr_content.html`, a layout the parser does not
 * recognise, or a report with no clocks in it at all (nothing constrained)
 * are all `unknown`: never treat them as a pass.
 */
export function timingVerdict(
  timing: TimingReport | undefined,
  opts: ViolationOptions = {},
): TimingVerdict {
  if (!timing) {
    return {
      status: 'unknown',
      reason: 'no timing report (_tr_content.html is missing — the timing engine did not run)',
      violations: [],
    };
  }
  if (!timing.recognized) {
    return {
      status: 'unknown',
      reason: 'timing report format not recognised (no fMax or TNS summary table found)',
      violations: [],
    };
  }
  if (!timing.fmax.length && !timing.tns.length) {
    return {
      status: 'unknown',
      reason: 'timing report lists no clocks — nothing was constrained, so nothing was analysed',
      violations: [],
    };
  }
  const violations = findViolations(timing, opts);
  if (violations.length) {
    return {
      status: 'fail',
      reason: `${violations.length} timing violation${violations.length === 1 ? '' : 's'}`,
      violations,
    };
  }
  return { status: 'pass', reason: 'no timing violations', violations };
}

/** Attaches the worst offending path to each setup/hold violation, when known. */
export function explainViolation(
  v: Violation,
  timing: TimingReport | undefined,
): string {
  // Path violations already name their worst path.
  if (!timing || v.source !== 'tns') return v.detail;
  const pool = v.kind === 'hold' ? timing.holdPaths : timing.setupPaths;
  const worst = pool
    .filter((p) => p.fromClock === v.clock || p.toClock === v.clock)
    .sort((a, b) => a.slack - b.slack)[0];
  if (!worst) return v.detail;
  return `${v.detail} — worst path ${worst.slack} ns: ${worst.from} -> ${worst.to}`;
}

export function summarize(loaded: LoadedBuild): BuildSummary {
  const verdict = timingVerdict(loaded.timing);
  return {
    build: loaded.resources.build,
    resources: loaded.resources.headline,
    timing: {
      status: verdict.status,
      reason: verdict.reason,
      fmax: loaded.timing?.fmax ?? [],
      violations: verdict.violations,
    },
    status: verdict.status,
    clean: verdict.status === 'pass',
  };
}

/** Utilization as a number 0-100, from the tool's own "66%" cell or recomputed. */
export function utilizationPct(row: ResourceRow | undefined): number | undefined {
  if (!row) return undefined;
  const m = row.utilization?.match(/-?\d+(?:\.\d+)?/);
  if (m) return Number(m[0]);
  if (row.used != null && row.available) return Number(((row.used / row.available) * 100).toFixed(2));
  return undefined;
}

/**
 * CI gate: timing verdict plus optional resource and margin thresholds.
 *
 * `status` is what we know: pass, fail, or unknown (timing could not be
 * verified). `ok` is the decision a pipeline should act on — unknown counts as
 * a failure unless `failOnMissingTiming` is turned off, in which case a build
 * whose resources are within limits is accepted on resources alone.
 */
export function checkBuild(loaded: LoadedBuild, thresholds: CheckThresholds = {}): CheckResult {
  const failOnMissingTiming = thresholds.failOnMissingTiming ?? true;
  const ignoreCrossDomain = thresholds.ignoreCrossDomain ?? false;
  const verdict = timingVerdict(loaded.timing, { ignoreCrossDomain });
  const reasons: string[] = [];
  const notes: string[] = [];
  const thresholdFailures: ThresholdFailure[] = [];
  const ignoredViolations = ignoreCrossDomain ? crossDomainViolations(loaded.timing) : [];

  if (verdict.status === 'fail') reasons.push(verdict.reason);

  // Negative slack the TNS summary does not count. Whoever reads a clean
  // fMax/TNS table next to a FAIL needs to know where the failure came from,
  // and that the fix may be a constraint rather than the RTL.
  const uncounted = verdict.violations.filter((v) => v.source === 'paths');
  if (uncounted.length) {
    const n = uncounted.length;
    notes.push(
      `${n} violation${n === 1 ? '' : 's'} come${n === 1 ? 's' : ''} from the path tables, not the TNS summary. ` +
        "Gowin's TNS does not count paths between clock domains, so the fMax/TNS summary looks clean while these paths fail. " +
        'Check whether the .sdc declares these crossings as false paths (set_false_path / set_clock_groups); if it does, pass ignoreCrossDomain=true. ' +
        'Path counts are lower bounds: the tables are capped by -max_paths.',
    );
  }
  if (ignoredViolations.length) {
    const n = ignoredViolations.length;
    const pairs = ignoredViolations.map((v) => `${v.kind} ${v.clock} (${v.amount} ns)`).join(', ');
    notes.push(
      `${n} cross-domain path violation${n === 1 ? '' : 's'} ignored (ignoreCrossDomain=true): ${pairs}. ` +
        'Only safe when the .sdc declares these crossings as false paths or asynchronous clock groups.',
    );
  }

  if (thresholds.maxUtilization != null) {
    const h = loaded.resources.headline;
    for (const [label, row] of [
      ['CLS', h.cls],
      ['Logic', h.logic],
      ['BSRAM', h.bsram],
    ] as const) {
      const pct = utilizationPct(row);
      if (pct == null || pct <= thresholds.maxUtilization) continue;
      thresholdFailures.push({
        kind: 'utilization',
        name: label,
        value: pct,
        limit: thresholds.maxUtilization,
        detail: `${label} at ${pct}% exceeds maxUtilization ${thresholds.maxUtilization}%`,
      });
    }
  }

  if (thresholds.minFmaxMarginMhz != null && loaded.timing) {
    for (const f of loaded.timing.fmax) {
      if (f.marginMhz >= thresholds.minFmaxMarginMhz) continue;
      // A clock already failing its constraint is reported as a violation;
      // the margin threshold adds the ones that pass but too narrowly.
      if (f.failing && verdict.violations.some((v) => v.clock === f.clock)) continue;
      thresholdFailures.push({
        kind: 'fmaxMargin',
        name: f.clock,
        value: f.marginMhz,
        limit: thresholds.minFmaxMarginMhz,
        detail: `${f.clock} margin ${f.marginMhz} MHz is below minFmaxMarginMhz ${thresholds.minFmaxMarginMhz} (${f.actualMhz} vs ${f.constraintMhz} MHz)`,
      });
    }
  }
  for (const t of thresholdFailures) reasons.push(t.detail);

  let status: CheckStatus;
  if (reasons.length) status = 'fail';
  else if (verdict.status === 'unknown') status = 'unknown';
  else status = 'pass';

  if (verdict.status === 'unknown') {
    // Always on record, even when a threshold already failed the build:
    // the reader must not infer that timing was checked.
    let note = `timing not verified: ${verdict.reason}`;
    if (status === 'unknown') {
      note += failOnMissingTiming
        ? ' — treated as a failure (failOnMissingTiming=true)'
        : ' — accepted on resources alone (failOnMissingTiming=false)';
    }
    reasons.push(note);
  } else if (status === 'pass') {
    reasons.push(verdict.reason);
  }

  reasons.push(...notes);

  return {
    status,
    ok: status === 'pass' || (status === 'unknown' && !failOnMissingTiming),
    reasons,
    violations: verdict.violations,
    timing: { status: verdict.status, reason: verdict.reason },
    thresholds: {
      maxUtilization: thresholds.maxUtilization,
      minFmaxMarginMhz: thresholds.minFmaxMarginMhz,
      failOnMissingTiming,
      ignoreCrossDomain,
    },
    thresholdFailures,
    ignoredViolations,
    notes,
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
