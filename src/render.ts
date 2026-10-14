import { explainViolation, findViolations, formatFmax, formatResource } from './analyze.js';
import type { LoadedBuild } from './analyze.js';
import type { BuildDiff } from './compare.js';
import type { TimingPath } from './types.js';

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

export function renderViolations(b: LoadedBuild): string {
  const v = findViolations(b.timing);
  if (!b.timing) return '\nTiming: no report';
  if (!v.length) return '\nTiming: CLEAN — no violations';

  const out = [``, `Timing: ${v.length} VIOLATION${v.length === 1 ? '' : 'S'}`];
  for (const x of v) {
    const amt = x.unit === 'ns' ? `${x.amount} ns` : `${x.amount} MHz`;
    out.push(
      `  ${x.kind.padEnd(5)} ${x.clock.padEnd(14)} ${amt.padStart(12)}  ${explainViolation(x, b.timing)}`,
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

export function renderPathTable(label: string, paths: TimingPath[], max: number): string[] {
  if (!paths.length) return [];
  const out = ['', label];
  for (const p of [...paths].sort((x, y) => x.slack - y.slack).slice(0, max)) {
    out.push(
      `  ${String(p.slack).padStart(9)} ns  ${p.fromClock}->${p.toClock}  ${p.from} -> ${p.to}` +
        (p.dataDelay != null ? `  (delay ${p.dataDelay}, relation ${p.relation})` : ''),
    );
  }
  return out;
}

export function renderDiff(diff: BuildDiff): string {
  const out: string[] = [];
  out.push(`${diff.before.name} (${diff.before.createdTime ?? '?'})`);
  out.push(`  ->  ${diff.after.name} (${diff.after.createdTime ?? '?'})`);
  for (const n of diff.notes) out.push(`  ! ${n}`);

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
  out.push(
    '',
    `Violations: ${introduced.length} introduced, ${fixed.length} fixed, ${persisting.length} persisting`,
  );
  for (const v of introduced) out.push(`  NEW    ${v.kind} ${v.clock} ${v.amount}${v.unit}`);
  for (const v of fixed) out.push(`  FIXED  ${v.kind} ${v.clock} (was ${v.amount}${v.unit})`);
  for (const v of persisting) out.push(`  still  ${v.kind} ${v.clock} ${v.amount}${v.unit}`);

  out.push('', diff.safe ? 'VERDICT: no regression.' : 'VERDICT: REGRESSION — see above.');
  return out.join('\n');
}
