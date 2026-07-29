#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { discoverBuilds, resolveBuild } from './discover.js';
import {
  explainViolation,
  findViolations,
  formatFmax,
  formatResource,
  loadBuild,
  summarize,
} from './analyze.js';
import { compareBuilds } from './compare.js';
import type { LoadedBuild } from './analyze.js';

const PATH_ARG = {
  type: 'string' as const,
  description:
    'Path to the build: the project directory, its impl/ directory, or the .rpt.txt itself.',
};
const FORMAT_ARG = {
  type: 'string' as const,
  enum: ['text', 'json'],
  description: 'Output format. Defaults to text, which is far more compact.',
};

const TOOLS = [
  {
    name: 'gowin_list_builds',
    description:
      'Find Gowin EDA builds under a directory tree. Returns project name, device, and when each was built, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Directory to search.' },
        maxDepth: { type: 'number', description: 'Search depth, default 8.' },
      },
      required: ['root'],
    },
  },
  {
    name: 'gowin_summary',
    description:
      'Headline report for one build: device, resource usage, fMax per clock, and every timing violation. Start here.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_ARG, format: FORMAT_ARG },
      required: ['path'],
    },
  },
  {
    name: 'gowin_resources',
    description:
      'Full resource usage for one build: logic, CLS, registers, BSRAM, DSP, I/O banks and clock resources.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        format: FORMAT_ARG,
        includeBanks: {
          type: 'boolean',
          description: 'Include the I/O bank and clock resource tables.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'gowin_timing',
    description:
      'Timing detail for one build: fMax per clock, total negative slack, and the worst setup/hold paths with their endpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        format: FORMAT_ARG,
        maxPaths: { type: 'number', description: 'Worst paths to show, default 10.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'gowin_check',
    description:
      'Pass/fail gate. Returns only the timing violations, with the offending path for each. Empty means the build closed timing.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_ARG, format: FORMAT_ARG },
      required: ['path'],
    },
  },
  {
    name: 'gowin_compare',
    description:
      'Diff two builds: resource deltas, fMax change per clock, and which violations were introduced, fixed, or persist. Use this to see what a change actually cost.',
    inputSchema: {
      type: 'object',
      properties: {
        before: { ...PATH_ARG, description: 'Baseline build path.' },
        after: { ...PATH_ARG, description: 'New build path.' },
        format: FORMAT_ARG,
      },
      required: ['before', 'after'],
    },
  },
];

function must(path: string): LoadedBuild {
  const found = resolveBuild(path);
  if (!found) {
    throw new Error(
      `No Gowin build found at ${path}. Expected an impl/pnr/<name>.rpt.txt below it.`,
    );
  }
  return loadBuild(found);
}

function buildHeader(b: LoadedBuild): string[] {
  const i = b.resources.build;
  const lines = [`Build: ${i.name}${i.device ? `  (${i.device}` : ''}${i.partNumber ? `, ${i.partNumber})` : i.device ? ')' : ''}`];
  if (i.toolVersion) lines.push(`Tool:  ${i.toolVersion}`);
  const timing = [i.createdTime, i.elapsed ? `PnR ${i.elapsed}` : '', i.peakMemory ? `peak ${i.peakMemory}` : '']
    .filter(Boolean)
    .join('   ');
  if (timing) lines.push(`Built: ${timing}`);
  if (!b.timing) lines.push('(no timing report found — resources only)');
  return lines;
}

function renderResources(b: LoadedBuild, includeBanks: boolean): string {
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
      for (const r of b.resources.ioBanks) {
        out.push(`  ${formatResource(r.name, r)}`);
      }
    }
    if (b.resources.clockResources.length) {
      out.push('', 'Clock resources');
      for (const r of b.resources.clockResources) {
        out.push(`  ${formatResource(r.name, r)}`);
      }
    }
  }
  return out.join('\n');
}

function renderViolations(b: LoadedBuild): string {
  const v = findViolations(b.timing);
  if (!b.timing) return '\nTiming: no report';
  if (!v.length) return '\nTiming: CLEAN — no violations';

  const out = [``, `Timing: ${v.length} VIOLATION${v.length === 1 ? '' : 'S'}`];
  for (const x of v) {
    const amt = x.unit === 'ns' ? `${x.amount} ns` : `${x.amount} MHz`;
    out.push(`  ${x.kind.padEnd(5)} ${x.clock.padEnd(14)} ${amt.padStart(12)}  ${explainViolation(x, b.timing)}`);
  }
  return out.join('\n');
}

function renderFmax(b: LoadedBuild): string {
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

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function json(v: unknown) {
  return text(JSON.stringify(v, null, 2));
}

async function main(): Promise<void> {
  const server = new Server(
    { name: 'gowin-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as Record<string, unknown>;
    const asJson = a.format === 'json';

    try {
      switch (req.params.name) {
        case 'gowin_list_builds': {
          const builds = discoverBuilds(String(a.root), Number(a.maxDepth ?? 8));
          if (asJson) return json(builds);
          if (!builds.length) return text(`No Gowin builds under ${a.root}.`);
          const lines = builds.map((b) => {
            let device = '';
            try {
              device = loadBuild(b).resources.build.device ?? '';
            } catch {
              /* report unreadable; path is still worth listing */
            }
            return `${b.mtime.slice(0, 16).replace('T', ' ')}  ${device.padEnd(10)}  ${b.name.padEnd(20)}  ${b.projectDir}${b.trContent ? '' : '  [no timing]'}`;
          });
          return text(`${builds.length} build(s):\n${lines.join('\n')}`);
        }

        case 'gowin_summary': {
          const b = must(String(a.path));
          if (asJson) return json(summarize(b));
          return text(
            [buildHeader(b).join('\n'), renderResources(b, false), renderViolations(b), renderFmax(b)]
              .filter(Boolean)
              .join('\n'),
          );
        }

        case 'gowin_resources': {
          const b = must(String(a.path));
          if (asJson) return json(b.resources);
          return text(
            [buildHeader(b).join('\n'), renderResources(b, a.includeBanks !== false)].join('\n'),
          );
        }

        case 'gowin_timing': {
          const b = must(String(a.path));
          if (!b.timing) return text('No timing report for this build.');
          if (asJson) return json(b.timing);

          const max = Number(a.maxPaths ?? 10);
          const out = [buildHeader(b).join('\n'), renderFmax(b), renderViolations(b)];

          for (const [label, paths] of [
            ['Worst setup paths', b.timing.setupPaths],
            ['Worst hold paths', b.timing.holdPaths],
          ] as const) {
            if (!paths.length) continue;
            out.push('', label);
            for (const p of [...paths].sort((x, y) => x.slack - y.slack).slice(0, max)) {
              out.push(
                `  ${String(p.slack).padStart(9)} ns  ${p.fromClock}->${p.toClock}  ${p.from} -> ${p.to}` +
                  (p.dataDelay != null ? `  (delay ${p.dataDelay}, relation ${p.relation})` : ''),
              );
            }
          }
          return text(out.filter(Boolean).join('\n'));
        }

        case 'gowin_check': {
          const b = must(String(a.path));
          const v = findViolations(b.timing);
          if (asJson) return json({ clean: v.length === 0, violations: v });
          return text(
            v.length
              ? `FAIL — ${v.length} violation(s)${renderViolations(b)}`
              : 'PASS — no timing violations.',
          );
        }

        case 'gowin_compare': {
          const before = must(String(a.before));
          const after = must(String(a.after));
          const diff = compareBuilds(before, after);
          if (asJson) return json(diff);

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
          out.push('', `Violations: ${introduced.length} introduced, ${fixed.length} fixed, ${persisting.length} persisting`);
          for (const v of introduced) out.push(`  NEW    ${v.kind} ${v.clock} ${v.amount}${v.unit}`);
          for (const v of fixed) out.push(`  FIXED  ${v.kind} ${v.clock} (was ${v.amount}${v.unit})`);
          for (const v of persisting) out.push(`  still  ${v.kind} ${v.clock} ${v.amount}${v.unit}`);

          out.push('', diff.safe ? 'VERDICT: no regression.' : 'VERDICT: REGRESSION — see above.');
          return text(out.join('\n'));
        }

        default:
          throw new Error(`Unknown tool: ${req.params.name}`);
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
