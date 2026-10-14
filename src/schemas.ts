import { z } from 'zod';

/**
 * Zod schemas shared by every tool: the input shapes clients send and the
 * output shapes published as `outputSchema` / `structuredContent`.
 *
 * Output schemas mirror the interfaces in types.ts. Keeping them hand-written
 * (rather than deriving the types from zod) keeps the parsers free of any
 * runtime dependency and lets the MCP layer stay thin.
 */

export const PathArg = z
  .string()
  .describe(
    'Path to the build: the project directory, its impl/ directory, or the .rpt.txt itself.',
  );

export const FormatArg = z
  .enum(['text', 'json'])
  .optional()
  .describe('Output format. Defaults to text, which is far more compact.');

export const NameArg = z
  .string()
  .optional()
  .describe(
    'When several builds share one impl/pnr/, pick this one by name (the <name> of <name>.rpt.txt). Default: the most recent.',
  );

export const BuildInfo = z.object({
  implDir: z.string(),
  name: z.string(),
  toolVersion: z.string().optional(),
  partNumber: z.string().optional(),
  device: z.string().optional(),
  deviceVersion: z.string().optional(),
  createdTime: z.string().optional(),
  designFile: z.string().optional(),
  constraintsFile: z.string().optional(),
  sdcFile: z.string().optional(),
  elapsed: z.string().optional(),
  peakMemory: z.string().optional(),
});

export const ResourceRow = z.object({
  name: z.string(),
  depth: z.number(),
  used: z.number().optional(),
  available: z.number().optional(),
  utilization: z.string().optional(),
  raw: z.string(),
  breakdown: z.record(z.string(), z.number()).optional(),
});

export const Headline = z.object({
  logic: ResourceRow.optional(),
  cls: ResourceRow.optional(),
  register: ResourceRow.optional(),
  bsram: ResourceRow.optional(),
  dsp: ResourceRow.optional(),
  ioPort: ResourceRow.optional(),
});

export const ResourceReport = z.object({
  build: BuildInfo,
  resources: z.array(ResourceRow),
  ioBanks: z.array(ResourceRow),
  clockResources: z.array(ResourceRow),
  headline: Headline,
});

export const ClockFmax = z.object({
  clock: z.string(),
  constraintMhz: z.number(),
  actualMhz: z.number(),
  logicLevel: z.number().optional(),
  entity: z.string().optional(),
  failing: z.boolean(),
  marginMhz: z.number(),
});

export const TnsRow = z.object({
  clock: z.string(),
  analysis: z.string(),
  tns: z.number(),
  endpoints: z.number(),
});

export const TimingPath = z.object({
  index: z.number(),
  slack: z.number(),
  from: z.string(),
  to: z.string(),
  fromClock: z.string(),
  toClock: z.string(),
  relation: z.number().optional(),
  clockSkew: z.number().optional(),
  dataDelay: z.number().optional(),
});

export const TimingReport = z.object({
  fmax: z.array(ClockFmax),
  clocksWithoutPaths: z.array(z.string()),
  tns: z.array(TnsRow),
  setupPaths: z.array(TimingPath),
  holdPaths: z.array(TimingPath),
  recoveryPaths: z.array(TimingPath),
  removalPaths: z.array(TimingPath),
  recognized: z.boolean(),
});

export const Violation = z.object({
  kind: z.enum(['setup', 'hold', 'fmax']),
  clock: z.string(),
  amount: z.number(),
  unit: z.enum(['ns', 'MHz']),
  detail: z.string(),
});

export const BuildSummary = z.object({
  build: BuildInfo,
  resources: Headline,
  timing: z.object({
    fmax: z.array(ClockFmax),
    violations: z.array(Violation),
  }),
  clean: z.boolean(),
});

export const FoundBuild = z.object({
  projectDir: z.string(),
  implDir: z.string(),
  name: z.string(),
  rptTxt: z.string(),
  trContent: z.string().optional(),
  mtime: z.string(),
  siblings: z.array(z.string()).optional(),
});

export const ListedBuild = FoundBuild.extend({
  device: z.string().optional(),
  toolVersion: z.string().optional(),
  createdTime: z.string().optional(),
});

export const ResourceDelta = z.object({
  name: z.string(),
  beforeUsed: z.number().optional(),
  afterUsed: z.number().optional(),
  delta: z.number().optional(),
  deltaPct: z.number().optional(),
  available: z.number().optional(),
});

export const FmaxDelta = z.object({
  clock: z.string(),
  beforeMhz: z.number().optional(),
  afterMhz: z.number().optional(),
  deltaMhz: z.number().optional(),
  constraintMhz: z.number().optional(),
  statusChange: z.enum(['regressed', 'fixed']).optional(),
});

const DiffSide = z.object({
  name: z.string(),
  createdTime: z.string().optional(),
  toolVersion: z.string().optional(),
  device: z.string().optional(),
});

export const BuildDiff = z.object({
  before: DiffSide,
  after: DiffSide,
  resources: z.array(ResourceDelta),
  fmax: z.array(FmaxDelta),
  violations: z.object({
    introduced: z.array(Violation),
    fixed: z.array(Violation),
    persisting: z.array(Violation),
  }),
  safe: z.boolean(),
  notes: z.array(z.string()),
});
