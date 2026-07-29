// Smoke test against real Gowin EDA output.
// Usage: node tests/smoke.mjs <path-to-project-or-impl-dir>
import { resolveBuild, discoverBuilds } from '../dist/discover.js';
import { loadBuild, findViolations, explainViolation, formatFmax, formatResource } from '../dist/analyze.js';

const target = process.argv[2];
if (!target) {
  console.error('usage: node tests/smoke.mjs <path>');
  process.exit(1);
}

const found = resolveBuild(target);
if (!found) {
  console.error(`no build found at ${target}`);
  process.exit(1);
}

const b = loadBuild(found);
const i = b.resources.build;

console.log('=== BUILD ===');
console.log('name        ', i.name);
console.log('device      ', i.device, '/', i.partNumber, 'rev', i.deviceVersion);
console.log('tool        ', i.toolVersion);
console.log('created     ', i.createdTime);
console.log('pnr elapsed ', i.elapsed, '  peak', i.peakMemory);
console.log('cst         ', i.constraintsFile);
console.log('sdc         ', i.sdcFile);

console.log('\n=== RESOURCES (headline) ===');
const h = b.resources.headline;
for (const [k, v] of Object.entries(h)) console.log(' ', formatResource(k, v));
console.log('  breakdown:', JSON.stringify(h.logic?.breakdown ?? b.resources.resources.find(r => r.breakdown)?.breakdown));
console.log('  rows parsed:', b.resources.resources.length, '| io banks:', b.resources.ioBanks.length, '| clock res:', b.resources.clockResources.length);

if (!b.timing) {
  console.log('\n(no timing report)');
  process.exit(0);
}

console.log('\n=== FMAX ===');
for (const f of [...b.timing.fmax].sort((a, c) => a.marginMhz - c.marginMhz)) console.log(' ', formatFmax(f));
console.log('  clocks without paths:', b.timing.clocksWithoutPaths.length);

console.log('\n=== VIOLATIONS ===');
const v = findViolations(b.timing);
if (!v.length) console.log('  CLEAN');
for (const x of v) console.log(`  ${x.kind} ${x.clock} ${x.amount}${x.unit} :: ${explainViolation(x, b.timing)}`);

console.log('\n=== WORST SETUP PATHS ===');
for (const p of [...b.timing.setupPaths].sort((a, c) => a.slack - c.slack).slice(0, 3)) {
  console.log(`  ${p.slack} ns  ${p.fromClock}->${p.toClock}  ${p.from} -> ${p.to}  (relation ${p.relation}, skew ${p.clockSkew}, delay ${p.dataDelay})`);
}
console.log('  setup paths parsed:', b.timing.setupPaths.length, '| hold paths:', b.timing.holdPaths.length, '| tns rows:', b.timing.tns.length);
