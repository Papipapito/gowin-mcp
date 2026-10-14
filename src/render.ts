import { explainViolation, formatFmax, formatResource, timingVerdict, verdictOptions } from './analyze.js';
import type { LoadedBuild } from './analyze.js';
import type { BuildDiff } from './compare.js';
import type {
  PackagePin,
  PinReport,
  PortPin,
  TimingPath,
  Violation,
  WarningGroup,
  WarningsReport,
} from './types.js';

/** Compact text renderings shared by the tools. JSON output bypasses these. */

export function buildHeader(b: LoadedBuild): string[] {
  const i = b.resources.build;
  const lines = [
    `Build: ${i.name}${i.device ? `  (${i.device}` : ''}${i.partNumber ? `, ${i.partNumber})` : i.device ? ')' : ''}`,
  ];
  if (i.toolVersion) lines.push(`Tool:  ${i.toolVersion}`);
  const timing = [
    i.createdTime,
    i.elapsed ? `PnR ${i.elapsed}` : '',
    i.peakMemory ? `peak ${i.peakMemory}` : '',
  ]
    .filter(Boolean)
    .join('   ');
  if (timing) lines.push(`Built: ${timing}`);
  if (b.found.siblings?.length) {
    lines.push(
      `Note:  newest of ${b.found.siblings.length + 1} builds in ${b.found.implDir}; others: ${b.found.siblings.join(', ')} (pass name to pick one)`,
    );
  }
  if (!b.timing) lines.push('(no timing report found — resources only)');
  else if (b.timing.format === 'text') lines.push(`(timing read from ${b.found.name}.tr — no _tr_content.html)`);
  return lines;
}

export function renderResources(b: LoadedBuild, includeBanks: boolean): string {
  const h = b.resources.headline;
  const out = ['', 'Resources'];
  const lut = h.logic?.breakdown ?? b.resources.resources.find((r) => r.breakdown)?.breakdown;
  out.push(`  ${formatResource('Logic', h.logic)}`);
  if (lut) {
    out.push(`    ${Object.entries(lut).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  for (const [label, row] of [
    ['CLS', h.cls],
    ['Register', h.register],
    ['BSRAM', h.bsram],
    ['DSP', h.dsp],
    ['I/O Port', h.ioPort],
  ] as const) {
    out.push(`  ${formatResource(label, row)}`);
  }

  if (includeBanks) {
    if (b.resources.ioBanks.length) {
      out.push('', 'I/O banks');
      for (const r of b.resources.ioBanks) out.push(`  ${formatResource(r.name, r)}`);
    }
    if (b.resources.clockResources.length) {
      out.push('', 'Clock resources');
      for (const r of b.resources.clockResources) out.push(`  ${formatResource(r.name, r)}`);
    }
  }
  return out.join('\n');
}

/** `violations` overrides the verdict's list, e.g. after gowin_check ignored some. */
export function renderViolations(b: LoadedBuild, violations?: Violation[]): string {
  const verdict = timingVerdict(b.timing, verdictOptions(b));
  const v = violations ?? verdict.violations;
  if (verdict.status === 'unknown') return `\nTiming: UNKNOWN — ${verdict.reason}`;
  if (!v.length) return '\nTiming: CLEAN — no violations';

  const out = [``, `Timing: ${v.length} VIOLATION${v.length === 1 ? '' : 'S'}`];
  for (const x of v) {
    const amt = x.unit === 'ns' ? `${x.amount} ns` : `${x.amount} MHz`;
    out.push(
      `  ${x.kind.padEnd(5)} ${x.clock.padEnd(14)} ${amt.padStart(12)}  ${explainViolation(x, b.timing)}`,
    );
  }
  const uncounted = v.filter((x) => x.source === 'paths').length;
  if (uncounted) {
    out.push(
      `  (${uncounted} of these ${uncounted === 1 ? 'is' : 'are'} not counted in Gowin's TNS summary: negative slack on paths between clock domains)`,
    );
  }
  return out.join('\n');
}

export function renderFmax(b: LoadedBuild): string {
  if (!b.timing?.fmax.length) return '';
  const out = ['', 'fMax per clock'];
  for (const f of [...b.timing.fmax].sort((a, c) => a.marginMhz - c.marginMhz)) {
    out.push(`  ${formatFmax(f)}`);
  }
  if (b.timing.clocksWithoutPaths.length) {
    out.push(`  (no timing paths: ${b.timing.clocksWithoutPaths.join(', ')})`);
  }
  return out.join('\n');
}

function pathLine(p: TimingPath): string {
  const edges = p.fromEdge && p.toEdge && p.fromEdge !== p.toEdge ? ` [${p.fromEdge}->${p.toEdge}]` : '';
  return (
    `  ${String(p.slack).padStart(9)} ns  ${p.fromClock}->${p.toClock}${edges}  ${p.from} -> ${p.to}` +
    (p.dataDelay != null ? `  (delay ${p.dataDelay}, relation ${p.relation})` : '')
  );
}

/** The worst `max` paths of a table; `total` says how many the report holds. */
export function renderPathTable(label: string, paths: TimingPath[], max: number): string[] {
  if (!paths.length || max <= 0) return [];
  const shown = [...paths].sort((x, y) => x.slack - y.slack).slice(0, max);
  const out = ['', `${label}${shown.length < paths.length ? ` (${shown.length} of ${paths.length})` : ''}`];
  for (const p of shown) out.push(pathLine(p));
  return out;
}

/** One line per table: a count and the worst slack is enough for a summary. */
export function renderPathSummary(label: string, paths: TimingPath[]): string[] {
  if (!paths.length) return [];
  const worst = [...paths].sort((x, y) => x.slack - y.slack)[0];
  const failing = paths.filter((p) => p.slack < 0).length;
  return [
    `${label}: ${paths.length} paths, worst ${worst.slack} ns (${worst.fromClock}->${worst.toClock})${failing ? `, ${failing} NEGATIVE` : ''}`,
  ];
}

export function renderDiff(diff: BuildDiff): string {
  const out: string[] = [];
  out.push(`${diff.before.name} (${diff.before.createdTime ?? '?'})`);
  out.push(`  ->  ${diff.after.name} (${diff.after.createdTime ?? '?'})`);
  for (const n of diff.notes) out.push(`  ! ${n}`);
  for (const [label, s] of [
    ['before', diff.before],
    ['after', diff.after],
  ] as const) {
    if (s.note) out.push(`  ! ${label}: ${s.note}`);
  }

  const moved = diff.resources.filter((r) => r.delta != null && r.delta !== 0);
  out.push('', moved.length ? 'Resource changes' : 'Resources: unchanged');
  for (const r of moved.slice(0, 20)) {
    const sign = (r.delta ?? 0) > 0 ? '+' : '';
    const pct = r.deltaPct != null ? ` (${sign}${r.deltaPct}%)` : '';
    out.push(
      `  ${r.name.padEnd(26)} ${String(r.beforeUsed).padStart(8)} -> ${String(r.afterUsed).padStart(8)}  ${sign}${r.delta}${pct}`,
    );
  }

  const fmaxMoved = diff.fmax.filter((f) => f.deltaMhz != null && Math.abs(f.deltaMhz) >= 0.001);
  if (fmaxMoved.length) {
    out.push('', 'fMax changes');
    for (const f of fmaxMoved) {
      const sign = (f.deltaMhz ?? 0) > 0 ? '+' : '';
      const flag = f.statusChange ? `  [${f.statusChange.toUpperCase()}]` : '';
      out.push(
        `  ${f.clock.padEnd(16)} ${String(f.beforeMhz).padStart(9)} -> ${String(f.afterMhz).padStart(9)} MHz  ${sign}${f.deltaMhz}${flag}`,
      );
    }
  }

  const { introduced, fixed, persisting } = diff.violations;
  if (diff.comparable) {
    out.push(
      '',
      `Violations: ${introduced.length} introduced, ${fixed.length} fixed, ${persisting.length} persisting`,
    );
    for (const v of introduced) out.push(`  NEW    ${v.kind} ${v.clock} ${v.amount}${v.unit}`);
    for (const v of fixed) out.push(`  FIXED  ${v.kind} ${v.clock} (was ${v.amount}${v.unit})`);
    for (const v of persisting) out.push(`  still  ${v.kind} ${v.clock} ${v.amount}${v.unit}`);
  } else {
    out.push('', 'Violations: not classified (different devices)');
  }

  if (diff.sameBitstream != null) {
    out.push(`Bitstream: ${diff.sameBitstream ? 'identical body' : 'different'}`);
  }

  if (diff.safe === null) out.push('', 'VERDICT: not comparable — see the notes above.');
  else out.push('', diff.safe ? 'VERDICT: no regression.' : 'VERDICT: REGRESSION — see above.');
  return out.join('\n');
}

function pinLine(p: PortPin | PackagePin, label: string): string {
  const attrs = [
    p.dir,
    p.ioType,
    p.pull ? `pull ${p.pull}` : '',
    p.drive && p.drive !== 'NA' ? `drive ${p.drive}` : '',
    p.site,
    p.cfg ? `cfg ${p.cfg}` : '',
    'diffPair' in p && p.diffPair ? `pair ${p.diffPair}` : '',
    'constrained' in p && !p.constrained ? 'UNCONSTRAINED' : '',
  ]
    .filter(Boolean)
    .join('  ');
  const loc = `pin ${p.pin}${p.bank != null ? `/${p.bank}` : ''}`;
  return `  ${label.padEnd(22)} ${loc.padEnd(11)} ${attrs}`;
}

export function renderPins(
  r: PinReport,
  opts: { ports: PortPin[]; unused: PackagePin[]; includeClocks: boolean; totalPorts: number; totalPins: number },
): string {
  const out: string[] = [];
  out.push(
    `${opts.ports.length} of ${opts.totalPorts} ports; ${opts.totalPins} package pins, ${r.unusedPins} unused`,
  );
  for (const p of opts.ports) out.push(pinLine(p, p.port));
  if (opts.unused.length) {
    out.push('', 'Unused package pins');
    for (const p of opts.unused) out.push(pinLine(p, '(free)'));
  }
  if (opts.includeClocks && r.clocks.length) {
    out.push('', 'Global clock routing');
    for (const c of r.clocks) {
      out.push(`  ${c.signal.padEnd(40)} ${c.type.padEnd(8)} ${c.location ?? ''}`);
    }
  }
  return out.join('\n');
}

export function renderWarnings(r: WarningsReport, groups: WarningGroup[], buildName: string): string {
  const t = r.totals;
  const out = [
    `${buildName}: ${t.errors} error${t.errors === 1 ? '' : 's'}, ${t.warnings} warning${t.warnings === 1 ? '' : 's'} (synthesis ${t.synthesis}, pnr ${t.pnr})`,
  ];
  for (const n of r.notes) out.push(`  ! ${n}`);
  for (const g of groups) {
    const where = g.locations.length
      ? `  @ ${g.locations.slice(0, 3).join(', ')}${g.locations.length > 3 ? ` +${g.locations.length - 3} more` : ''}`
      : '';
    out.push(`  ${g.level.padEnd(5)} ${g.code} x${String(g.count).padEnd(4)} [${g.stage}] ${g.examples[0]}${where}`);
    if (g.hint) out.push(`        -> ${g.hint}`);
  }
  if (groups.length < r.groups.length) {
    out.push(`  (${r.groups.length - groups.length} more code(s) not shown)`);
  }
  if (r.unconstrainedClocks.length) {
    out.push('', 'Clocks without a constraint (TA1132)');
    for (const c of r.unconstrainedClocks) {
      out.push(`  ${c.clock}${c.noTimingPaths ? '   <- also "no timing paths" in the timing report' : ''}`);
    }
  }
  return out.join('\n');
}
