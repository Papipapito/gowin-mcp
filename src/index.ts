#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { discoverBuilds, resolveBuild } from './discover.js';
import { findViolations, loadBuild, summarize } from './analyze.js';
import { readBuildHeader } from './parse-resources.js';
import type { LoadedBuild } from './analyze.js';
import { compareBuilds } from './compare.js';
import * as S from './schemas.js';
import {
  buildHeader,
  renderDiff,
  renderFmax,
  renderPathTable,
  renderResources,
  renderViolations,
} from './render.js';

export const VERSION = '0.1.0-beta.1';

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
        'Timing detail for one build: fMax per clock, total negative slack, and the worst setup/hold paths with their endpoints.',
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
      return result({ hasTiming: true, timing: b.timing }, out.filter(Boolean).join('\n'), format);
    }),
  );

  server.registerTool(
    'gowin_check',
    {
      title: 'Timing gate',
      description:
        'Pass/fail gate. Returns only the timing violations, with the offending path for each. Empty means the build closed timing.',
      inputSchema: { path: S.PathArg, name: S.NameArg, format: S.FormatArg },
      outputSchema: { clean: z.boolean(), violations: z.array(S.Violation) },
      annotations: READ_ONLY,
    },
    guarded(({ path, name, format }) => {
      const b = must(path, name);
      const v = findViolations(b.timing);
      const text = v.length
        ? `FAIL — ${v.length} violation(s)${renderViolations(b)}`
        : 'PASS — no timing violations.';
      return result({ clean: v.length === 0, violations: v }, text, format);
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

  return server;
}

async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
