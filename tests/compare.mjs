// Compare two real builds end-to-end.
// Usage: node tests/compare.mjs <before> <after>
import { resolveBuild } from '../dist/discover.js';
import { loadBuild } from '../dist/analyze.js';
import { compareBuilds } from '../dist/compare.js';

const [, , beforePath, afterPath] = process.argv;
if (!beforePath || !afterPath) {
  console.error('usage: node tests/compare.mjs <before> <after>');
  process.exit(1);
}

const load = (p) => {
  const f = resolveBuild(p);
  if (!f) throw new Error(`no build at ${p}`);
  return loadBuild(f);
};

const d = compareBuilds(load(beforePath), load(afterPath));

console.log(`${d.before.name} (${d.before.createdTime})`);
console.log(`  -> ${d.after.name} (${d.after.createdTime})`);
for (const n of d.notes) console.log(`  ! ${n}`);

console.log('\n=== RESOURCE CHANGES ===');
const moved = d.resources.filter((r) => r.delta);
if (!moved.length) console.log('  (none)');
for (const r of moved.slice(0, 15)) {
  const s = r.delta > 0 ? '+' : '';
  console.log(`  ${r.name.padEnd(26)} ${String(r.beforeUsed).padStart(7)} -> ${String(r.afterUsed).padStart(7)}  ${s}${r.delta}${r.deltaPct != null ? ` (${s}${r.deltaPct}%)` : ''}`);
}

console.log('\n=== FMAX CHANGES ===');
const fm = d.fmax.filter((f) => f.deltaMhz != null && Math.abs(f.deltaMhz) >= 0.001);
if (!fm.length) console.log('  (none)');
for (const f of fm) {
  const s = f.deltaMhz > 0 ? '+' : '';
  console.log(`  ${f.clock.padEnd(16)} ${String(f.beforeMhz).padStart(9)} -> ${String(f.afterMhz).padStart(9)} MHz  ${s}${f.deltaMhz}${f.statusChange ? `  [${f.statusChange.toUpperCase()}]` : ''}`);
}

console.log('\n=== VIOLATIONS ===');
console.log('  introduced:', d.violations.introduced.map((v) => `${v.kind}/${v.clock}`).join(', ') || '(none)');
console.log('  fixed     :', d.violations.fixed.map((v) => `${v.kind}/${v.clock}`).join(', ') || '(none)');
console.log('  persisting:', d.violations.persisting.map((v) => `${v.kind}/${v.clock}`).join(', ') || '(none)');
console.log('\nVERDICT:', d.safe ? 'no regression' : 'REGRESSION');
