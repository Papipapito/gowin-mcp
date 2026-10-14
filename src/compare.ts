import { bitstreamOf, findViolations, siblingNote, timingVerdict, verdictOptions } from './analyze.js';
import type { LoadedBuild } from './analyze.js';
import type { BitstreamInfo, ResourceRow, SiblingNote, Violation } from './types.js';

/**
 * Build-to-build diff. The question this answers is "what did my change
 * actually cost?" — the one thing a single report can never tell you.
 */

export interface ResourceDelta {
  name: string;
  beforeUsed?: number;
  afterUsed?: number;
  delta?: number;
  /** Percent change relative to `before`, omitted when before is 0/unknown. */
  deltaPct?: number;
  available?: number;
}

export interface FmaxDelta {
  clock: string;
  beforeMhz?: number;
  afterMhz?: number;
  deltaMhz?: number;
  constraintMhz?: number;
  /** Set when the clock went from passing to failing, or the reverse. */
  statusChange?: 'regressed' | 'fixed';
}

export interface DiffSide extends SiblingNote {
  name: string;
  createdTime?: string;
  toolVersion?: string;
  device?: string;
  bitstream?: BitstreamInfo;
}

export interface BuildDiff {
  before: DiffSide;
  after: DiffSide;
  /**
   * False when the two builds target different devices: the resource
   * numbers mean different things, and a violation only one side has is not
   * "introduced" or "fixed" — it belongs to another design. Violations are
   * then left unclassified and `safe` is null.
   */
  comparable: boolean;
  resources: ResourceDelta[];
  fmax: FmaxDelta[];
  violations: {
    introduced: Violation[];
    fixed: Violation[];
    persisting: Violation[];
  };
  /**
   * True when nothing regressed: no violation that the "before" build did
   * not have, and no clock that went from meeting its constraint to missing
   * it. A clock that got slower but still meets its constraint is not a
   * regression here; `fmax[].deltaMhz` has the figure. Null when the builds
   * are not comparable.
   */
  safe: boolean | null;
  /** True when both bitstreams are present and their bodies hash equal: the same configuration. */
  sameBitstream?: boolean;
  notes: string[];
}

function indexRows(rows: ResourceRow[]): Map<string, ResourceRow> {
  const m = new Map<string, ResourceRow>();
  for (const r of rows) {
    // Sub-rows are namespaced so "--SP" under BSRAM cannot collide with a
    // top-level row of the same name.
    const key = r.depth === 0 ? r.name : `  ${r.name}`;
    if (!m.has(key)) m.set(key, r);
  }
  return m;
}

/**
 * Identity of a violation across builds. A path violation is keyed by its
 * clock pair, so a clock_54m -> clock_27m crossing is tracked apart from a
 * TNS violation on either clock; a same-domain path violation shares the key
 * of the TNS row for that clock, since it is the same defect counted differently.
 */
function violationKey(v: Violation): string {
  if (v.source === 'paths' && v.crossDomain) return `${v.kind}:${v.fromClock}->${v.toClock}`;
  return `${v.kind}:${v.source === 'paths' ? v.fromClock ?? v.clock : v.clock}`;
}

function side(b: LoadedBuild): DiffSide {
  const i = b.resources.build;
  return {
    name: i.name,
    createdTime: i.createdTime,
    toolVersion: i.toolVersion,
    device: i.device,
    bitstream: bitstreamOf(b.found),
    ...siblingNote(b.found),
  };
}

export function compareBuilds(before: LoadedBuild, after: LoadedBuild): BuildDiff {
  const notes: string[] = [];

  const bDev = before.resources.build.device;
  const aDev = after.resources.build.device;
  const comparable = !(bDev && aDev && bDev !== aDev);
  if (!comparable) {
    notes.push(
      `Different devices (${bDev} vs ${aDev}) — the numbers are not comparable; violations were not classified and safe is null.`,
    );
  }
  const bTool = before.resources.build.toolVersion;
  const aTool = after.resources.build.toolVersion;
  if (bTool && aTool && bTool !== aTool) {
    notes.push(
      `Different tool versions (${bTool} vs ${aTool}) — some drift is the toolchain, not your RTL.`,
    );
  }
  for (const [label, x] of [
    ['before', before],
    ['after', after],
  ] as const) {
    const v = timingVerdict(x.timing, verdictOptions(x));
    if (v.status === 'unknown') {
      notes.push(`Timing of the "${label}" build is unknown (${v.reason}); only resources were compared for it.`);
    }
  }

  // --- resources -----------------------------------------------------------
  const bRes = indexRows(before.resources.resources);
  const aRes = indexRows(after.resources.resources);
  const resources: ResourceDelta[] = [];

  for (const key of new Set([...bRes.keys(), ...aRes.keys()])) {
    const b = bRes.get(key);
    const a = aRes.get(key);
    const beforeUsed = b?.used;
    const afterUsed = a?.used;
    const delta =
      beforeUsed != null && afterUsed != null
        ? Number((afterUsed - beforeUsed).toFixed(3))
        : undefined;

    resources.push({
      name: key.trim(),
      beforeUsed,
      afterUsed,
      delta,
      deltaPct:
        delta != null && beforeUsed
          ? Number(((delta / beforeUsed) * 100).toFixed(2))
          : undefined,
      available: a?.available ?? b?.available,
    });
  }
  // Biggest movers first; unchanged rows sink to the bottom.
  resources.sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0));

  // --- fMax ----------------------------------------------------------------
  const bF = new Map((before.timing?.fmax ?? []).map((f) => [f.clock, f]));
  const aF = new Map((after.timing?.fmax ?? []).map((f) => [f.clock, f]));
  const fmax: FmaxDelta[] = [];

  for (const clock of new Set([...bF.keys(), ...aF.keys()])) {
    const b = bF.get(clock);
    const a = aF.get(clock);
    const deltaMhz =
      b && a ? Number((a.actualMhz - b.actualMhz).toFixed(3)) : undefined;

    let statusChange: FmaxDelta['statusChange'];
    if (comparable && b && a) {
      if (!b.failing && a.failing) statusChange = 'regressed';
      else if (b.failing && !a.failing) statusChange = 'fixed';
    }

    fmax.push({
      clock,
      beforeMhz: b?.actualMhz,
      afterMhz: a?.actualMhz,
      deltaMhz,
      constraintMhz: a?.constraintMhz ?? b?.constraintMhz,
      statusChange,
    });
  }
  fmax.sort((x, y) => (x.deltaMhz ?? 0) - (y.deltaMhz ?? 0));

  // --- violations ----------------------------------------------------------
  const bV = findViolations(before.timing, verdictOptions(before));
  const aV = findViolations(after.timing, verdictOptions(after));
  let introduced: Violation[] = [];
  let fixed: Violation[] = [];
  let persisting: Violation[] = [];
  if (comparable) {
    const bKeys = new Set(bV.map(violationKey));
    const aKeys = new Set(aV.map(violationKey));
    introduced = aV.filter((v) => !bKeys.has(violationKey(v)));
    fixed = bV.filter((v) => !aKeys.has(violationKey(v)));
    persisting = aV.filter((v) => bKeys.has(violationKey(v)));
  } else if (bV.length || aV.length) {
    notes.push(`Violations per side, unclassified: before ${bV.length}, after ${aV.length}.`);
  }

  const regressedClocks = fmax.filter((f) => f.statusChange === 'regressed');

  const b = side(before);
  const a = side(after);
  const sameBitstream =
    b.bitstream && a.bitstream ? b.bitstream.bodySha256 === a.bitstream.bodySha256 : undefined;
  if (sameBitstream) notes.push('Both .fs files have the same body: the two builds program the device identically.');

  return {
    before: b,
    after: a,
    comparable,
    resources,
    fmax,
    violations: { introduced, fixed, persisting },
    safe: comparable ? introduced.length === 0 && regressedClocks.length === 0 : null,
    sameBitstream,
    notes,
  };
}
