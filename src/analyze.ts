import { readBitstream } from './bitstream.js';
import { parseResourceReport } from './parse-resources.js';
import { parseTimingReport } from './parse-timing.js';
import { parseTimingTextReport } from './parse-timing-text.js';
import { clockExceptions, constraintsInfo, readSdc } from './sdc.js';
import type { SdcInfo } from './sdc.js';
import type { FoundBuild } from './discover.js';
import type {
  BitstreamInfo,
  BuildSummary,
  CheckResult,
  CheckStatus,
  CheckThresholds,
  ClockFmax,
  ResourceReport,
  ResourceRow,
  SiblingNote,
  ThresholdFailure,
  TimingPath,
  TimingReport,
  TimingVerdict,
  TnsRow,
  Violation,
} from './types.js';

/** Loads and cross-checks the reports that make up one build. */
export interface LoadedBuild {
  found: FoundBuild;
  resources: ResourceReport;
  timing?: TimingReport;
  /** The .sdc the report names, when it can be found; informs the fMax check. */
  sdc: SdcInfo;
}

export function loadBuild(found: FoundBuild): LoadedBuild {
  const resources = parseResourceReport(found.rptTxt);
  let timing: TimingReport | undefined;
  if (found.trContent) timing = parseTimingReport(found.trContent);
  else if (found.tr) timing = parseTimingTextReport(found.tr);
  return {
    found,
    resources,
    timing,
    sdc: readSdc(resources.build.sdcFile, found.projectDir),
  };
}

export interface ViolationOptions {
  /** Leave out cross-domain path violations (see CheckThresholds.ignoreCrossDomain). */
  ignoreCrossDomain?: boolean;
  /** Clocks whose fMax-only violation is waived (see CheckThresholds.fmaxWaivers). */
  fmaxWaivers?: string[];
  /** The build's constraints, used to explain an fMax-only violation. */
  sdc?: SdcInfo;
}

/** Options a loaded build supplies on its own. */
export function verdictOptions(b: LoadedBuild): ViolationOptions {
  return { sdc: b.sdc };
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

/**
 * Why a clock can miss its fMax with a clean TNS, and what to do about it.
 *
 * Gowin's Max Frequency summary derives the figure from the worst path's
 * (relation - slack) as if that were one clock period. A path under a
 * `set_multicycle_path -end 2` has a relation of two periods, and a path
 * launched on one edge and captured on the other has half a period, so a
 * clock whose paths carry such exceptions reads as failing although every
 * endpoint meets its constraint — which is exactly what a 0.000 TNS says.
 */
function fmaxDetail(f: ClockFmax, timing: TimingReport, sdc: SdcInfo | undefined): string {
  const tnsRow = timing.tns.find((r) => r.clock === f.clock && tnsKind(r) === 'setup');
  const tns = tnsRow ? `setup TNS ${tnsRow.tns.toFixed(3)}` : 'no setup TNS row';
  let s = `${f.actualMhz} MHz achieved against a ${f.constraintMhz} MHz constraint, with no setup violation reported (${tns})`;

  const evidence: string[] = [];
  const ex = clockExceptions(sdc, f.clock);
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
  if (ex.multicycle) evidence.push(`${plural(ex.multicycle, 'set_multicycle_path command')} in the .sdc name${ex.multicycle === 1 ? 's' : ''} this clock`);
  if (ex.falsePath) evidence.push(`${plural(ex.falsePath, 'set_false_path command')} in the .sdc name${ex.falsePath === 1 ? 's' : ''} it`);
  const halfCycle = timing.setupPaths.filter(
    (p) =>
      (p.fromClock === f.clock || p.toClock === f.clock) && p.fromEdge && p.toEdge && p.fromEdge !== p.toEdge,
  ).length;
  if (halfCycle) {
    evidence.push(
      `${halfCycle} of its reported setup path${halfCycle === 1 ? ' is a' : 's are'} half-cycle relation${halfCycle === 1 ? '' : 's'} (launch and capture on opposite edges)`,
    );
  }

  let unread = '';
  if (sdc && !sdc.readable) {
    unread = sdc.reported
      ? ` The .sdc at ${sdc.reported} could not be read, so its exceptions were not checked.`
      : ' The report names no .sdc (the build was placed without timing constraints), so there are no exceptions to check.';
  }
  if (evidence.length) {
    s +=
      `. ${evidence.join('; ')}. Gowin derives fMax from the worst path's relation minus its slack as if that were a single period, ` +
      'so paths under a multicycle or half-cycle relation pull the figure below the constraint although they meet it. ' +
      `If that is the case here, waive it with fmaxWaivers; otherwise check that the constraint covers the domain.${unread}`;
  } else if (unread) {
    s += ` — check the constraint covers this domain.${unread}`;
  } else {
    s += ' — check the constraint covers this domain (the .sdc names this clock in no multicycle or false-path command)';
  }
  return s;
}

/** Case-insensitive clock name, or a glob with * and ?. */
export function clockMatcher(pattern: string): (clock: string) => boolean {
  if (/[*?]/.test(pattern)) {
    const re = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
      'i',
    );
    return (clock) => re.test(clock);
  }
  const want = pattern.toLowerCase();
  return (clock) => clock.toLowerCase() === want;
}

function waived(v: Violation, waivers: string[] | undefined): boolean {
  if (v.source !== 'fmax' || !waivers?.length) return false;
  return waivers.some((w) => clockMatcher(w)(v.clock));
}

/**
 * Collects every timing failure, then splits it into the ones that count
 * and the ones the options set aside.
 *
 * Setup and hold come first from the TNS summary, which is complete for what
 * it counts (the path tables are capped by `-max_paths`), then from the path
 * tables for the negative slack the TNS leaves out: paths between clock
 * domains (see pathViolations). fMax is only raised for a clock that no
 * setup violation already covers — the same defect is not counted twice, and
 * an fMax shortfall with a clean TNS is itself worth surfacing: the
 * constraint is missing, or the shortfall is how Gowin reports exceptions
 * (see fmaxDetail).
 */
export function splitViolations(
  timing: TimingReport | undefined,
  opts: ViolationOptions = {},
): { kept: Violation[]; ignored: Violation[] } {
  if (!timing) return { kept: [], ignored: [] };
  const all = [...tnsViolations(timing), ...pathViolations(timing)];

  const clocksWithSlackViolation = new Set<string>();
  for (const v of all) {
    if (v.kind !== 'setup') continue;
    clocksWithSlackViolation.add(v.clock);
    if (v.fromClock) clocksWithSlackViolation.add(v.fromClock);
    if (v.toClock) clocksWithSlackViolation.add(v.toClock);
  }
  for (const f of timing.fmax) {
    if (!f.failing || clocksWithSlackViolation.has(f.clock)) continue;
    all.push({
      kind: 'fmax',
      source: 'fmax',
      clock: f.clock,
      amount: f.marginMhz,
      unit: 'MHz',
      detail: fmaxDetail(f, timing, opts.sdc),
    });
  }

  // Worst first: most negative slack, then largest frequency shortfall.
  all.sort((a, b) => a.amount - b.amount);
  const kept: Violation[] = [];
  const ignored: Violation[] = [];
  for (const v of all) {
    const out = (opts.ignoreCrossDomain && v.crossDomain) || waived(v, opts.fmaxWaivers);
    (out ? ignored : kept).push(v);
  }
  return { kept, ignored };
}

/** The violations that count under `opts`. */
export function findViolations(timing: TimingReport | undefined, opts: ViolationOptions = {}): Violation[] {
  return splitViolations(timing, opts).kept;
}

/** The violations `opts` set aside (cross-domain paths, waived fMax). */
export function ignoredViolations(timing: TimingReport | undefined, opts: ViolationOptions = {}): Violation[] {
  return splitViolations(timing, opts).ignored;
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
      reason: 'no timing report (_tr_content.html is missing and there is no <name>.tr — the timing engine did not run)',
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

/** The `siblings` / `note` pair every tool publishes when a build was chosen among several. */
export function siblingNote(found: FoundBuild): SiblingNote {
  if (!found.siblings?.length) return {};
  return {
    siblings: found.siblings,
    note: `newest of ${found.siblings.length + 1} builds in ${found.implDir}; others: ${found.siblings.join(', ')} (pass name to pick one)`,
  };
}

/** The bitstream header and body hash, when the .fs is there and readable. */
export function bitstreamOf(found: FoundBuild): BitstreamInfo | undefined {
  if (!found.fs) return undefined;
  try {
    return readBitstream(found.fs);
  } catch {
    return undefined;
  }
}

export function summarize(loaded: LoadedBuild): BuildSummary {
  const verdict = timingVerdict(loaded.timing, verdictOptions(loaded));
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
    bitstream: bitstreamOf(loaded.found),
    constraints: constraintsInfo(loaded.sdc),
    ...siblingNote(loaded.found),
  };
}

/**
 * Utilization as a number 0-100: recomputed from used/available when both
 * are there (the tool rounds its own column), else the tool's "66%" cell.
 */
export function utilizationPct(row: ResourceRow | undefined): number | undefined {
  if (!row) return undefined;
  if (row.utilizationPct != null) return row.utilizationPct;
  const m = row.utilization?.match(/-?\d+(?:\.\d+)?/);
  if (m) return Number(m[0]);
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
  const fmaxWaivers = thresholds.fmaxWaivers ?? [];
  const opts: ViolationOptions = { ignoreCrossDomain, fmaxWaivers, sdc: loaded.sdc };
  const verdict = timingVerdict(loaded.timing, opts);
  const reasons: string[] = [];
  const notes: string[] = [];
  const thresholdFailures: ThresholdFailure[] = [];
  const ignored = ignoredViolations(loaded.timing, opts);

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
  const ignoredCross = ignored.filter((v) => v.crossDomain);
  if (ignoredCross.length) {
    const n = ignoredCross.length;
    const pairs = ignoredCross.map((v) => `${v.kind} ${v.clock} (${v.amount} ns)`).join(', ');
    notes.push(
      `${n} cross-domain path violation${n === 1 ? '' : 's'} ignored (ignoreCrossDomain=true): ${pairs}. ` +
        'Only safe when the .sdc declares these crossings as false paths or asynchronous clock groups.',
    );
  }
  const waivedFmax = ignored.filter((v) => v.source === 'fmax');
  if (waivedFmax.length) {
    const n = waivedFmax.length;
    const list = waivedFmax.map((v) => `${v.clock} (${v.amount} MHz)`).join(', ');
    notes.push(
      `${n} fMax-only violation${n === 1 ? '' : 's'} waived (fmaxWaivers=${JSON.stringify(fmaxWaivers)}): ${list}. ` +
        "Only safe when the clock's setup TNS is 0 and the shortfall is how Gowin reports its multicycle or half-cycle paths; a TNS violation is never waived.",
    );
  }
  if (fmaxWaivers.length && loaded.timing) {
    const clocks = loaded.timing.fmax.map((f) => f.clock);
    const unmatched = fmaxWaivers.filter((w) => !clocks.some((c) => clockMatcher(w)(c)));
    if (unmatched.length) {
      notes.push(`fmaxWaivers names no clock of this report: ${unmatched.join(', ')} (clocks: ${clocks.join(', ') || 'none'}).`);
    }
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
      const reported = row?.utilization;
      const rounded = reported && reported !== `${pct}%` ? ` (${reported} as the tool rounds it)` : '';
      thresholdFailures.push({
        kind: 'utilization',
        name: label,
        value: pct,
        limit: thresholds.maxUtilization,
        reported,
        detail: `${label} at ${pct}%${rounded} exceeds maxUtilization ${thresholds.maxUtilization}%`,
      });
    }
  }

  if (thresholds.minFmaxMarginMhz != null && loaded.timing) {
    for (const f of loaded.timing.fmax) {
      if (f.marginMhz >= thresholds.minFmaxMarginMhz) continue;
      // A clock already failing its constraint is reported as a violation
      // (or deliberately waived); the margin threshold adds the ones that
      // pass but too narrowly.
      const covered = (v: Violation) => v.clock === f.clock || v.fromClock === f.clock || v.toClock === f.clock;
      if (f.failing && (verdict.violations.some(covered) || waivedFmax.some(covered))) continue;
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
      fmaxWaivers,
    },
    thresholdFailures,
    ignoredViolations: ignored,
    notes,
    ...siblingNote(loaded.found),
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
