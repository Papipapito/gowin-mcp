import { z } from 'zod';

/**
 * Zod schemas shared by every tool: the input shapes clients send and the
 * documented shapes of the JSON each tool returns with `format: "json"`.
 *
 * The output schemas are no longer published as MCP `outputSchema`: a tool
 * that declares one must return `structuredContent` (SDK 1.30 enforces it),
 * and clients that understand structured content then show that JSON
 * instead of the compact text rendering, which defeats the default output.
 * They stay here as the contract the tests hold the JSON to, and mirror the
 * interfaces in types.ts. Keeping them hand-written (rather than deriving
 * the types from zod) keeps the parsers free of any runtime dependency.
 */

export const PathArg = z
  .string()
  .describe(
    'Path to the build: the project directory, its impl/ directory, impl/pnr/ itself, or the .rpt.txt. Either kind of slash.',
  );

export const FormatArg = z
  .enum(['text', 'json'])
  .optional()
  .describe(
    'Output format. Default text: a compact rendering, returned as the only content. json: the full JSON as text and as structuredContent.',
  );

export const NameArg = z
  .string()
  .optional()
  .describe(
    'When several builds share one impl/pnr/, pick this one by name (the <name> of <name>.rpt.txt). Default: the most recent, with the others listed under siblings.',
  );

const SiblingNote = {
  siblings: z.array(z.string()).optional().describe('Other builds in the same impl/pnr/ when none was named.'),
  note: z.string().optional().describe('Which build was chosen and how to pick another.'),
};

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
  utilization: z.string().optional().describe('As the tool rounds it, e.g. "98%".'),
  utilizationPct: z.number().optional().describe('used/available recomputed, two decimals.'),
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
  ...SiblingNote,
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
  fromEdge: z.enum(['R', 'F']).optional(),
  toEdge: z.enum(['R', 'F']).optional(),
  relation: z.number().optional(),
  clockSkew: z.number().optional(),
  dataDelay: z.number().optional(),
});

export const TimingReport = z.object({
  fmax: z.array(ClockFmax),
  clocksWithoutPaths: z.array(z.string()),
  tns: z.array(TnsRow),
  setupPaths: z.array(TimingPath).describe('Worst slack first.'),
  holdPaths: z.array(TimingPath),
  recoveryPaths: z.array(TimingPath),
  removalPaths: z.array(TimingPath),
  worstSetup: TimingPath.optional(),
  worstHold: TimingPath.optional(),
  recognized: z.boolean(),
  format: z.enum(['html', 'text']).optional().describe('html = _tr_content.html; text = <name>.tr fallback.'),
});

export const PathsShown = z.object({
  mode: z.enum(['worst', 'all', 'none']),
  maxPaths: z.number().optional(),
  parsed: z.object({ setup: z.number(), hold: z.number(), recovery: z.number(), removal: z.number() }),
});

export const TimingOutput = z.object({
  hasTiming: z.boolean(),
  timing: TimingReport.optional(),
  paths: PathsShown.optional().describe('How the four path tables were trimmed for output.'),
  ...SiblingNote,
});

export const Violation = z.object({
  kind: z.enum(['setup', 'hold', 'fmax']),
  clock: z.string().describe('The clock, or "from -> to" for a path between two clock domains.'),
  amount: z.number(),
  unit: z.enum(['ns', 'MHz']),
  detail: z.string(),
  source: z
    .enum(['tns', 'paths', 'fmax'])
    .describe('paths = negative slack in the path tables that the TNS summary does not count (cross-domain).'),
  fromClock: z.string().optional(),
  toClock: z.string().optional(),
  crossDomain: z.boolean().optional(),
  pathCount: z.number().optional().describe('Lower bound: the path tables are capped by -max_paths.'),
});

export const CheckStatus = z
  .enum(['pass', 'fail', 'unknown'])
  .describe('unknown = timing could not be verified; never a pass.');

export const BitstreamInfo = z.object({
  path: z.string(),
  toolVersion: z.string().optional(),
  device: z.string().optional(),
  deviceVersion: z.string().optional(),
  partNumber: z.string().optional(),
  devicePackage: z.string().optional(),
  checksum: z.string().optional(),
  userCode: z.string().optional(),
  createdTime: z.string().optional(),
  size: z.number(),
  bodySha256: z.string().describe('SHA-256 of the data lines (no // header), line endings stripped.'),
  bodyLines: z.number(),
});

export const ConstraintsInfo = z.object({
  reported: z.string().optional(),
  path: z.string().optional(),
  readable: z.boolean(),
  clocks: z.array(z.string()),
  multicyclePaths: z.number(),
  falsePaths: z.number(),
  clockGroups: z.number(),
});

export const BuildSummary = z.object({
  build: BuildInfo,
  resources: Headline,
  timing: z.object({
    status: CheckStatus,
    reason: z.string(),
    fmax: z.array(ClockFmax),
    violations: z.array(Violation),
  }),
  status: CheckStatus,
  clean: z.boolean().describe('True only when status is pass.'),
  bitstream: BitstreamInfo.optional(),
  constraints: ConstraintsInfo.optional(),
  ...SiblingNote,
});

export const ThresholdFailure = z.object({
  kind: z.enum(['utilization', 'fmaxMargin']),
  name: z.string(),
  value: z.number(),
  limit: z.number(),
  reported: z.string().optional(),
  detail: z.string(),
});

export const CheckResult = z.object({
  status: CheckStatus,
  ok: z.boolean().describe('The CI decision. False for fail, and for unknown unless failOnMissingTiming is false.'),
  reasons: z.array(z.string()),
  violations: z.array(Violation),
  timing: z.object({ status: CheckStatus, reason: z.string() }),
  thresholds: z.object({
    maxUtilization: z.number().optional(),
    minFmaxMarginMhz: z.number().optional(),
    failOnMissingTiming: z.boolean(),
    ignoreCrossDomain: z.boolean(),
    fmaxWaivers: z.array(z.string()),
  }),
  thresholdFailures: z.array(ThresholdFailure),
  ignoredViolations: z.array(Violation),
  notes: z.array(z.string()),
  ...SiblingNote,
});

export const FoundBuild = z.object({
  projectDir: z.string(),
  implDir: z.string(),
  name: z.string(),
  rptTxt: z.string(),
  trContent: z.string().optional(),
  tr: z.string().optional(),
  fs: z.string().optional(),
  mtime: z.string(),
  siblings: z.array(z.string()).optional(),
});

export const ListedBuild = FoundBuild.extend({
  device: z.string().optional(),
  toolVersion: z.string().optional(),
  createdTime: z.string().optional(),
});

export const ListOutput = z.object({ builds: z.array(ListedBuild) });

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
  bitstream: BitstreamInfo.optional(),
  ...SiblingNote,
});

export const BuildDiff = z.object({
  before: DiffSide,
  after: DiffSide,
  comparable: z.boolean().describe('False for different devices: violations unclassified, safe null.'),
  resources: z.array(ResourceDelta),
  fmax: z.array(FmaxDelta),
  violations: z.object({
    introduced: z.array(Violation),
    fixed: z.array(Violation),
    persisting: z.array(Violation),
  }),
  safe: z.boolean().nullable(),
  sameBitstream: z.boolean().optional(),
  notes: z.array(z.string()),
});

export const ClockSignal = z.object({
  signal: z.string(),
  type: z.string(),
  location: z.string().optional(),
});

const IoAttributes = {
  dir: z.string().optional(),
  site: z.string().optional(),
  cfg: z.string().optional(),
  ioType: z.string().optional(),
  drive: z.string().optional(),
  pull: z.string().optional(),
  pciClamp: z.string().optional(),
  hysteresis: z.string().optional(),
  openDrain: z.string().optional(),
  vref: z.string().optional(),
  singleResistor: z.string().optional(),
  diffResistor: z.string().optional(),
  bankVccio: z.string().optional(),
};

export const PortPin = z.object({
  port: z.string(),
  pin: z.string(),
  bank: z.string().optional(),
  diffPair: z.string().optional(),
  constrained: z.boolean(),
  ...IoAttributes,
});

export const PackagePin = z.object({
  pin: z.string(),
  bank: z.string().optional(),
  signal: z.string().optional(),
  ...IoAttributes,
});

export const PinReport = z.object({
  clocks: z.array(ClockSignal),
  ports: z.array(PortPin),
  packagePins: z.array(PackagePin),
  unusedPins: z.number(),
  ...SiblingNote,
});

export const LogLevel = z.enum(['WARN', 'ERROR', 'INFO']);
export const LogStage = z.enum(['synthesis', 'pnr']);

export const WarningGroup = z.object({
  code: z.string(),
  level: LogLevel,
  stage: LogStage,
  count: z.number(),
  pattern: z.string(),
  hint: z.string().optional(),
  examples: z.array(z.string()),
  locations: z.array(z.string()),
});

export const WarningsReport = z.object({
  logs: z.object({ pnr: z.string().optional(), synthesis: z.string().optional() }),
  totals: z.object({
    errors: z.number(),
    warnings: z.number(),
    pnr: z.number(),
    synthesis: z.number(),
  }),
  groups: z.array(WarningGroup),
  unconstrainedClocks: z.array(z.object({ clock: z.string(), noTimingPaths: z.boolean() })),
  notes: z.array(z.string()),
  ...SiblingNote,
});
