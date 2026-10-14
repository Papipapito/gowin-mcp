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
  TimingReport,
  TimingVerdict,
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

/**
 * What the timing report lets us say about the build.
 *
 * "No violations found" is only meaningful when a report was actually read
 * and understood. A missing `_tr_content.html`, a layout the parser does not
 * recognise, or a report with no clocks in it at all (nothing constrained)
 * are all `unknown`: never treat them as a pass.
 */
export function timingVerdict(timing: TimingReport | undefined): TimingVerdict {
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
  const violations = findViolations(timing);
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
  if (!timing || v.kind === 'fmax') return v.detail;
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
  const verdict = timingVerdict(loaded.timing);
  const reasons: string[] = [];
  const thresholdFailures: ThresholdFailure[] = [];

  if (verdict.status === 'fail') reasons.push(verdict.reason);

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
    },
    thresholdFailures,
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
