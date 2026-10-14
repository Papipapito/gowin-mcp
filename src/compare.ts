import { findViolations, timingVerdict } from './analyze.js';
import type { LoadedBuild } from './analyze.js';
import type { ResourceRow, Violation } from './types.js';

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

export interface BuildDiff {
  before: { name: string; createdTime?: string; toolVersion?: string; device?: string };
  after: { name: string; createdTime?: string; toolVersion?: string; device?: string };
  resources: ResourceDelta[];
  fmax: FmaxDelta[];
  violations: {
    introduced: Violation[];
    fixed: Violation[];
    persisting: Violation[];
  };
  /** True when nothing regressed: no new violations and no clock got slower. */
  safe: boolean;
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

function violationKey(v: Violation): string {
  return `${v.kind}:${v.clock}`;
}

export function compareBuilds(before: LoadedBuild, after: LoadedBuild): BuildDiff {
  const notes: string[] = [];

  const bDev = before.resources.build.device;
  const aDev = after.resources.build.device;
  if (bDev && aDev && bDev !== aDev) {
    notes.push(`Different devices (${bDev} vs ${aDev}) — the numbers are not comparable.`);
  }
  const bTool = before.resources.build.toolVersion;
  const aTool = after.resources.build.toolVersion;
  if (bTool && aTool && bTool !== aTool) {
    notes.push(
      `Different tool versions (${bTool} vs ${aTool}) — some drift is the toolchain, not your RTL.`,
    );
  }
  for (const [label, side] of [
    ['before', before],
    ['after', after],
  ] as const) {
    const v = timingVerdict(side.timing);
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
    if (b && a) {
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
  const bV = findViolations(before.timing);
  const aV = findViolations(after.timing);
  const bKeys = new Set(bV.map(violationKey));
  const aKeys = new Set(aV.map(violationKey));

  const introduced = aV.filter((v) => !bKeys.has(violationKey(v)));
  const fixed = bV.filter((v) => !aKeys.has(violationKey(v)));
  const persisting = aV.filter((v) => bKeys.has(violationKey(v)));

  const regressedClocks = fmax.filter((f) => f.statusChange === 'regressed');

  return {
    before: {
      name: before.resources.build.name,
      createdTime: before.resources.build.createdTime,
      toolVersion: bTool,
      device: bDev,
    },
    after: {
      name: after.resources.build.name,
      createdTime: after.resources.build.createdTime,
      toolVersion: aTool,
      device: aDev,
    },
    resources,
    fmax,
    violations: { introduced, fixed, persisting },
    safe: introduced.length === 0 && regressedClocks.length === 0,
    notes,
  };
}
