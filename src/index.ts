#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { discoverBuilds, resolveBuild } from './discover.js';
import { checkBuild, loadBuild, summarize } from './analyze.js';
import { readBuildHeader } from './parse-resources.js';
import { parsePinReport, portMatcher } from './parse-pins.js';
import { readWarnings } from './parse-log.js';
import type { LoadedBuild } from './analyze.js';
import { compareBuilds } from './compare.js';
import * as S from './schemas.js';
import {
  buildHeader,
  renderDiff,
  renderFmax,
  renderPathSummary,
  renderPathTable,
  renderPins,
  renderWarnings,
  renderResources,
  renderViolations,
} from './render.js';

import { createRequire } from 'node:module';

/** Single source of truth: the version in package.json. */
export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

/** Every tool only reads report files already on disk. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function must(path: string, name?: string): LoadedBuild {
  const found = resolveBuild(path, name);
  if (!found) {
    throw new Error(
      `No Gowin build found at ${path}. Expected an impl/pnr/<name>.rpt.txt below it.`,
    );
  }
  return loadBuild(found);
}

/**
 * Builds a tool result carrying both renderings: `structuredContent` for
 * clients that read the output schema, and a text block that is either the
 * compact rendering or, when `format: "json"` was asked for, the JSON itself.
 */
function result<T extends object>(
  structured: T,
  textRendering: string,
  format: 'text' | 'json' | undefined,
) {
  const text = format === 'json' ? JSON.stringify(structured, null, 2) : textRendering;
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: structured as Record<string, unknown>,
  };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
    isError: true,
  };
}

/** Wraps a handler so thrown errors become MCP error results instead of protocol failures. */
function guarded<A, R>(fn: (args: A) => R): (args: A) => R | ReturnType<typeof errorResult> {
  return (args: A) => {
    try {
      return fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'gowin-mcp', version: VERSION });

  server.registerTool(
    'gowin_list_builds',
    {
      title: 'List Gowin builds',
      description:
        'Find Gowin EDA builds under a directory tree. Returns project name, device, and when each was built, newest first.',
      inputSchema: {
        root: z.string().describe('Directory to search.'),
        maxDepth: z.number().optional().describe('Search depth, default 8.'),
        format: S.FormatArg,
      },
      outputSchema: { builds: z.array(S.ListedBuild) },
      annotations: READ_ONLY,
    },
    guarded(({ root, maxDepth, format }) => {
      const builds = discoverBuilds(root, maxDepth ?? 8).map((b) => {
        // Only the header is needed here; parsing the full report (and the
        // timing HTML behind it) for every build made listing a tree slow.
        try {
          const h = readBuildHeader(b.rptTxt);
          return { ...b, device: h.device, toolVersion: h.toolVersion, createdTime: h.createdTime };
        } catch {
          // Report unreadable; the path is still worth listing.
          return { ...b, device: undefined, toolVersion: undefined, createdTime: undefined };
        }
      });
      const lines = builds.map(
        (b) =>
          `${b.mtime.slice(0, 16).replace('T', ' ')}  ${(b.device ?? '').padEnd(10)}  ${b.name.padEnd(20)}  ${b.projectDir}${b.trContent ? '' : '  [no timing]'}`,
      );
      const text = builds.length
        ? `${builds.length} build(s):\n${lines.join('\n')}`
        : `No Gowin builds under ${root}.`;
      return result({ builds }, text, format);
    }),
  );

  server.registerTool(
    'gowin_summary',
    {
      title: 'Build summary',
      description:
        'Headline report for one build: device, resource usage, fMax per clock, and every timing violation. Start here.',
      inputSchema: { path: S.PathArg, name: S.NameArg, format: S.FormatArg },
      outputSchema: S.BuildSummary.shape,
      annotations: READ_ONLY,
    },
    guarded(({ path, name, format }) => {
      const b = must(path, name);
      const text = [buildHeader(b).join('\n'), renderResources(b, false), renderViolations(b), renderFmax(b)]
        .filter(Boolean)
        .join('\n');
      return result(summarize(b), text, format);
    }),
  );

  server.registerTool(
    'gowin_resources',
    {
      title: 'Resource usage',
      description:
        'Full resource usage for one build: logic, CLS, registers, BSRAM, DSP, I/O banks and clock resources.',
      inputSchema: {
        path: S.PathArg,
        name: S.NameArg,
        format: S.FormatArg,
        includeBanks: z
          .boolean()
          .optional()
          .describe('Include the I/O bank and clock resource tables. Default true.'),
      },
      outputSchema: S.ResourceReport.shape,
      annotations: READ_ONLY,
    },
    guarded(({ path, name, format, includeBanks }) => {
      const b = must(path, name);
      const text = [buildHeader(b).join('\n'), renderResources(b, includeBanks !== false)].join('\n');
      return result(b.resources, text, format);
    }),
  );

  server.registerTool(
    'gowin_timing',
    {
      title: 'Timing detail',
      description:
        'Timing detail for one build: fMax per clock, total negative slack, the worst setup/hold paths with their endpoints, and a summary of the recovery/removal checks.',
      inputSchema: {
        path: S.PathArg,
        name: S.NameArg,
        format: S.FormatArg,
        maxPaths: z.number().optional().describe('Worst paths to show, default 10.'),
      },
      outputSchema: { hasTiming: z.boolean(), timing: S.TimingReport.optional() },
      annotations: READ_ONLY,
    },
    guarded(({ path, name, format, maxPaths }) => {
      const b = must(path, name);
      if (!b.timing) {
        return result({ hasTiming: false }, 'No timing report for this build.', format);
      }
      const max = maxPaths ?? 10;
      const out = [buildHeader(b).join('\n'), renderFmax(b), renderViolations(b)];
      out.push(...renderPathTable('Worst setup paths', b.timing.setupPaths, max));
      out.push(...renderPathTable('Worst hold paths', b.timing.holdPaths, max));
      const async = [
        ...renderPathSummary('Recovery', b.timing.recoveryPaths),
        ...renderPathSummary('Removal', b.timing.removalPaths),
      ];
      if (async.length) out.push('', ...async);
      return result({ hasTiming: true, timing: b.timing }, out.filter(Boolean).join('\n'), format);
    }),
  );

  server.registerTool(
    'gowin_check',
    {
      title: 'Build gate',
      description:
        'Pass/fail/unknown gate for CI. Lists timing violations with the offending path for each, plus optional thresholds on utilization and fMax margin. Negative paths between clock domains count as violations even though Gowin leaves them out of the TNS summary (set ignoreCrossDomain when they are declared false paths). "unknown" means timing could not be verified (no _tr_content.html, unrecognised report, or no clocks analysed) and is never a pass.',
      inputSchema: {
        path: S.PathArg,
        name: S.NameArg,
        format: S.FormatArg,
        maxUtilization: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Fail when CLS, Logic or BSRAM utilization exceeds this percentage.'),
        minFmaxMarginMhz: z
          .number()
          .optional()
          .describe('Fail when any clock achieves less than constraint + this many MHz.'),
        failOnMissingTiming: z
          .boolean()
          .optional()
          .describe('Default true: an unknown timing status fails the gate. Set false to accept on resources alone.'),
        ignoreCrossDomain: z
          .boolean()
          .optional()
          .describe(
            'Default false. Set true when the paths between clock domains are declared false paths (set_false_path / set_clock_groups in the .sdc): their negative slack is then listed but does not fail the gate.',
          ),
      },
      outputSchema: S.CheckResult.shape,
      annotations: READ_ONLY,
    },
    guarded(({ path, name, format, maxUtilization, minFmaxMarginMhz, failOnMissingTiming, ignoreCrossDomain }) => {
      const b = must(path, name);
      const r = checkBuild(b, { maxUtilization, minFmaxMarginMhz, failOnMissingTiming, ignoreCrossDomain });
      const head = `${r.status.toUpperCase()} — ${r.reasons[0]}`;
      const lines = [head];
      if (r.status === 'unknown' && r.ok) lines.push('ok=true (gate accepted the build on resources)');
      if (r.status === 'fail') {
        if (r.violations.length) lines.push(renderViolations(b, r.violations));
        for (const t of r.thresholdFailures) lines.push(`  threshold ${t.kind.padEnd(11)} ${t.detail}`);
      }
      for (const v of r.ignoredViolations) {
        lines.push(`  ignored ${v.kind} ${v.clock} ${v.amount} ns (at least ${v.pathCount} path${v.pathCount === 1 ? '' : 's'})`);
      }
      for (const n of r.notes) lines.push(`  note: ${n}`);
      if (b.found.siblings?.length) lines.push(buildHeader(b).find((l) => l.startsWith('Note:')) ?? '');
      return result(r, lines.filter(Boolean).join('\n'), format);
    }),
  );

  server.registerTool(
    'gowin_compare',
    {
      title: 'Compare builds',
      description:
        'Diff two builds: resource deltas, fMax change per clock, and which violations were introduced, fixed, or persist. Use this to see what a change actually cost.',
      inputSchema: {
        before: S.PathArg.describe('Baseline build path.'),
        beforeName: S.NameArg,
        after: S.PathArg.describe('New build path.'),
        afterName: S.NameArg,
        format: S.FormatArg,
      },
      outputSchema: S.BuildDiff.shape,
      annotations: READ_ONLY,
    },
    guarded(({ before, beforeName, after, afterName, format }) => {
      const diff = compareBuilds(must(before, beforeName), must(after, afterName));
      return result(diff, renderDiff(diff), format);
    }),
  );

  server.registerTool(
    'gowin_pins',
    {
      title: 'Pin assignment',
      description:
        'Pin assignment as placed: every top-level port with its package pin, bank, I/O standard, drive, pull mode and dual-function role, plus the global clock routing. Filter by port name (substring or glob).',
      inputSchema: {
        path: S.PathArg,
        name: S.NameArg,
        format: S.FormatArg,
        port: z
          .string()
          .optional()
          .describe('Only ports whose name contains this text, or matches it as a glob (* and ?). Case-insensitive.'),
        includeUnused: z
          .boolean()
          .optional()
          .describe('Also list package pins with no signal on them. Default false.'),
        includeClocks: z
          .boolean()
          .optional()
          .describe('Include the global clock routing table. Default true.'),
      },
      outputSchema: S.PinReport.shape,
      annotations: READ_ONLY,
    },
    guarded(({ path, name, format, port, includeUnused, includeClocks }) => {
      const found = resolveBuild(path, name);
      if (!found) throw new Error(`No Gowin build found at ${path}.`);
      const r = parsePinReport(found.rptTxt);
      const match = portMatcher(port);
      const ports = r.ports.filter((p) => match(p.port));
      const unused = includeUnused ? r.packagePins.filter((p) => !p.signal) : [];
      const text = renderPins(r, { ports, unused, includeClocks: includeClocks !== false });
      // The structured result is filtered the same way so both views agree.
      const structured = {
        ...r,
        ports,
        packagePins: includeUnused ? r.packagePins : r.packagePins.filter((p) => p.signal && match(p.signal)),
        clocks: includeClocks !== false ? r.clocks : [],
      };
      return result(structured, text, format);
    }),
  );

  server.registerTool(
    'gowin_warnings',
    {
      title: 'Synthesis and PnR warnings',
      description:
        'WARN/ERROR lines from impl/gwsynthesis/<name>.log and impl/pnr/<name>.log grouped by diagnostic code, with a hint for the common ones. Cross-checks TA1132 (clock detected but not created) against the timing report to list clocks that are missing a constraint.',
      inputSchema: {
        path: S.PathArg,
        name: S.NameArg,
        format: S.FormatArg,
        stage: z.enum(['synthesis', 'pnr', 'all']).optional().describe('Which log to read. Default all.'),
        level: z.enum(['error', 'warn', 'all']).optional().describe('Minimum severity. Default all.'),
        code: z.string().optional().describe('Only this diagnostic code, e.g. TA1132.'),
        maxGroups: z.number().optional().describe('Codes to show in the text rendering, default 15.'),
      },
      outputSchema: S.WarningsReport.shape,
      annotations: READ_ONLY,
    },
    guarded(({ path, name, format, stage, level, code, maxGroups }) => {
      const found = resolveBuild(path, name);
      if (!found) throw new Error(`No Gowin build found at ${path}.`);
      const b = loadBuild(found);
      const r = readWarnings(found, b.timing?.clocksWithoutPaths);
      const filtered = r.groups.filter(
        (g) =>
          (!stage || stage === 'all' || g.stage === stage) &&
          (!level || level === 'all' || (level === 'error' ? g.level === 'ERROR' : g.level !== 'INFO')) &&
          (!code || g.code.toLowerCase() === code.toLowerCase()),
      );
      const structured = { ...r, groups: filtered };
      const text = renderWarnings(structured, filtered.slice(0, maxGroups ?? 15), found.name);
      return result(structured, text, format);
    }),
  );

  return server;
}

async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
