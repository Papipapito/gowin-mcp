/** Shared shapes for parsed Gowin EDA build artifacts. */

export interface BuildInfo {
  /** Absolute path to the impl/ directory of the build. */
  implDir: string;
  /** Project base name, e.g. "project" or "tn_vdp_v3_v9958". */
  name: string;
  toolVersion?: string;
  partNumber?: string;
  device?: string;
  deviceVersion?: string;
  createdTime?: string;
  designFile?: string;
  constraintsFile?: string;
  sdcFile?: string;
  /** Wall-clock place & route time as reported by the tool. */
  elapsed?: string;
  peakMemory?: string;
}

/** One row of a Gowin "Resource | Usage | Utilization" table. */
export interface ResourceRow {
  name: string;
  /** Nesting depth: 0 for top-level rows, 1 for "--" sub-rows. */
  depth: number;
  used?: number;
  available?: number;
  /** Percentage as reported by the tool (rounded, e.g. "98%"; not recomputed). */
  utilization?: string;
  /**
   * used / available as a percentage with two decimals, recomputed from the
   * numbers. The tool rounds its own column: 29142/29952 is 97.30 but
   * reported as 98%. Absent when the row has no "used/available" pair.
   */
  utilizationPct?: number;
  /** Raw usage cell, kept because some rows carry a breakdown. */
  raw: string;
  /** Parsed breakdown, e.g. {LUT: 21883, ALU: 3325, ROM16: 0}. */
  breakdown?: Record<string, number>;
}

export interface ResourceReport {
  build: BuildInfo;
  resources: ResourceRow[];
  ioBanks: ResourceRow[];
  clockResources: ResourceRow[];
  /** Fast lookup for the headline numbers. */
  headline: {
    logic?: ResourceRow;
    cls?: ResourceRow;
    register?: ResourceRow;
    bsram?: ResourceRow;
    dsp?: ResourceRow;
    ioPort?: ResourceRow;
  };
}

export interface ClockFmax {
  clock: string;
  /** Constrained frequency in MHz. */
  constraintMhz: number;
  /** Achieved frequency in MHz as reported by the timing engine. */
  actualMhz: number;
  logicLevel?: number;
  entity?: string;
  /** True when actualMhz < constraintMhz. */
  failing: boolean;
  /** Achieved minus constrained, in MHz. Negative means failing. */
  marginMhz: number;
}

export interface TnsRow {
  clock: string;
  analysis: 'Setup' | 'Hold' | string;
  /** Total negative slack in ns. 0 means clean. */
  tns: number;
  endpoints: number;
}

export type ClockEdge = 'R' | 'F';

export interface TimingPath {
  index: number;
  slack: number;
  from: string;
  to: string;
  fromClock: string;
  toClock: string;
  /** Launch / capture edge, from the `clk:[R]` / `clk:[F]` suffix of the clock cells. */
  fromEdge?: ClockEdge;
  toEdge?: ClockEdge;
  relation?: number;
  clockSkew?: number;
  dataDelay?: number;
}

export interface TimingReport {
  fmax: ClockFmax[];
  /** Clocks the engine found no paths for — usually unconstrained or unused. */
  clocksWithoutPaths: string[];
  tns: TnsRow[];
  /** Worst slack first (the tables are re-sorted; `index` keeps the tool's own numbering). */
  setupPaths: TimingPath[];
  holdPaths: TimingPath[];
  /** Asynchronous set/reset release checks (report_timing -recovery). */
  recoveryPaths: TimingPath[];
  /** Asynchronous set/reset hold-side checks (report_timing -removal). */
  removalPaths: TimingPath[];
  /** The worst setup / hold path, kept even when the tables are trimmed for output. */
  worstSetup?: TimingPath;
  worstHold?: TimingPath;
  /**
   * False when the file was there but neither the fMax nor the TNS summary
   * table was found — a format this parser does not understand. Nothing can
   * be concluded about timing in that case.
   */
  recognized: boolean;
  /** html = `_tr_content.html`; text = the `<name>.tr` plain-text report (fallback). */
  format?: 'html' | 'text';
}

export interface Violation {
  kind: 'setup' | 'hold' | 'fmax';
  /** The clock, or "from -> to" for a path between two clock domains. */
  clock: string;
  /** Slack in ns for setup/hold; MHz shortfall for fmax. */
  amount: number;
  unit: 'ns' | 'MHz';
  detail: string;
  /**
   * tns:   a negative row of the Total Negative Slack summary.
   * paths: negative slack in the setup/hold path tables that no negative TNS
   *        row accounts for. Gowin leaves paths between clock domains out of
   *        the TNS, so the summary looks clean while the path tables do not.
   * fmax:  the Max Frequency summary, for a clock with no setup violation.
   */
  source: 'tns' | 'paths' | 'fmax';
  /** Launch and capture clocks (source = paths). */
  fromClock?: string;
  toClock?: string;
  /** True when fromClock differs from toClock (source = paths). */
  crossDomain?: boolean;
  /**
   * Negative paths seen for this clock pair. A lower bound: the path tables
   * are capped by -max_paths at report time.
   */
  pathCount?: number;
}

/**
 * pass: a timing report was read and shows no violation.
 * fail: at least one violation (or, in gowin_check, a threshold breach).
 * unknown: timing could not be verified — missing report, unrecognised
 *          layout, or no clocks analysed. Never equivalent to pass.
 */
export type CheckStatus = 'pass' | 'fail' | 'unknown';

export interface TimingVerdict {
  status: CheckStatus;
  reason: string;
  violations: Violation[];
}

/** Header of `impl/pnr/<name>.fs` plus a hash of the configuration data. */
export interface BitstreamInfo {
  path: string;
  toolVersion?: string;
  device?: string;
  deviceVersion?: string;
  partNumber?: string;
  devicePackage?: string;
  /** Tool-reported 16-bit checksum, e.g. "0xDE97". */
  checksum?: string;
  userCode?: string;
  createdTime?: string;
  /** File size in bytes. */
  size: number;
  /**
   * SHA-256 over every line that is not a `//` header comment, line endings
   * stripped. Two .fs files with the same body program the device
   * identically, whatever their Created Time says.
   */
  bodySha256: string;
  bodyLines: number;
}

/** What the build's .sdc says, as far as the fMax check needs it. */
export interface ConstraintsInfo {
  /** The .sdc path the report names. */
  reported?: string;
  /** The file that was actually read (the reported path, or a copy found under the project). */
  path?: string;
  readable: boolean;
  /** Clock names from create_clock / create_generated_clock -name. */
  clocks: string[];
  multicyclePaths: number;
  falsePaths: number;
  clockGroups: number;
}

/** Set when the caller did not name a build and impl/pnr/ holds several. */
export interface SiblingNote {
  /** Names of the other builds in the same impl/pnr/. */
  siblings?: string[];
  /** Which build was chosen and how to pick another. */
  note?: string;
}

export interface BuildSummary extends SiblingNote {
  build: BuildInfo;
  resources: ResourceReport['headline'];
  timing: {
    status: CheckStatus;
    reason: string;
    fmax: ClockFmax[];
    violations: Violation[];
  };
  status: CheckStatus;
  /** True only when status is pass. Kept for callers of the 0.1 shape. */
  clean: boolean;
  bitstream?: BitstreamInfo;
  constraints?: ConstraintsInfo;
}

export interface CheckThresholds {
  /** Fail when CLS, Logic or BSRAM utilization exceeds this percentage. */
  maxUtilization?: number;
  /** Fail when any clock's achieved-minus-constraint margin is below this many MHz. */
  minFmaxMarginMhz?: number;
  /** Default true: an unknown timing status fails the gate. */
  failOnMissingTiming?: boolean;
  /**
   * Default false. When true, negative paths between two clock domains that
   * the TNS summary does not count are reported but do not fail the gate —
   * for designs where those crossings are declared false paths in the .sdc.
   */
  ignoreCrossDomain?: boolean;
  /**
   * Clocks (names, or globs with * and ?) whose fMax-only violation — an fMax
   * below the constraint while the clock's setup TNS is 0 — is waived. Gowin
   * derives fMax from the worst path's relation minus slack as if that were
   * one period, so a clock whose paths are covered by set_multicycle_path or
   * half-cycle relations reads as failing although every endpoint meets its
   * constraint. A TNS violation on the same clock is never waived.
   */
  fmaxWaivers?: string[];
}

export interface ThresholdFailure {
  kind: 'utilization' | 'fmaxMargin';
  name: string;
  /** For utilization: the recomputed percentage (two decimals). */
  value: number;
  limit: number;
  /** For utilization: the percentage as the tool rounds it, e.g. "98%". */
  reported?: string;
  detail: string;
}

export interface CheckResult extends SiblingNote {
  status: CheckStatus;
  /** The CI decision: accept the build or not. */
  ok: boolean;
  reasons: string[];
  violations: Violation[];
  timing: { status: CheckStatus; reason: string };
  thresholds: Required<Pick<CheckThresholds, 'failOnMissingTiming' | 'ignoreCrossDomain' | 'fmaxWaivers'>> &
    Pick<CheckThresholds, 'maxUtilization' | 'minFmaxMarginMhz'>;
  thresholdFailures: ThresholdFailure[];
  /** Violations left out of the decision: cross-domain paths (ignoreCrossDomain) and waived fMax (fmaxWaivers). */
  ignoredViolations: Violation[];
  /** Context the reader needs to interpret the decision, e.g. why the TNS looks clean. */
  notes: string[];
}

/** One row of "Global Clock Signals": how a clock net was routed. */
export interface ClockSignal {
  signal: string;
  /** PRIMARY (global buffer), HCLK (regional), LW (long wire). */
  type: string;
  /** Quadrants or bank pair, e.g. "TR TL BR BL" or "BANK2_BANK3_HCLK0". */
  location?: string;
}

/** I/O attributes shared by the port and package-pin tables. Absent = "-" in the report. */
export interface IoAttributes {
  /** in / out / io. */
  dir?: string;
  /** Physical I/O site, e.g. IOL7[A]. */
  site?: string;
  /** Dual-function role of the pin (MSPI, GCLK, PLL feedback...). Absent on V1.9.9 reports. */
  cfg?: string;
  ioType?: string;
  drive?: string;
  pull?: string;
  pciClamp?: string;
  hysteresis?: string;
  openDrain?: string;
  vref?: string;
  singleResistor?: string;
  diffResistor?: string;
  bankVccio?: string;
}

/** One top-level port and the pin it ended up on ("Pinout by Port Name"). */
export interface PortPin extends IoAttributes {
  port: string;
  /** Package pin, e.g. "4" or "p73" (the embedded-SDRAM pins of a GW2AR). */
  pin: string;
  bank?: string;
  diffPair?: string;
  /** True when the location came from the .cst rather than the placer. */
  constrained: boolean;
}

/** One physical pin of the package ("All Package Pins"); `signal` is absent when unused. */
export interface PackagePin extends IoAttributes {
  pin: string;
  bank?: string;
  signal?: string;
}

export interface PinReport {
  clocks: ClockSignal[];
  ports: PortPin[];
  packagePins: PackagePin[];
  /** Free pins in the whole package, before any filter. */
  unusedPins: number;
}

export type LogStage = 'synthesis' | 'pnr';

export interface LogMessage {
  level: 'WARN' | 'ERROR' | 'INFO';
  /** Gowin diagnostic code, e.g. TA1132, EX2478. */
  code: string;
  message: string;
  file?: string;
  line?: number;
  stage: LogStage;
}

/** Every occurrence of one code in one log, collapsed. */
export interface WarningGroup {
  code: string;
  level: LogMessage['level'];
  stage: LogStage;
  count: number;
  /** The message with quoted names and numbers replaced, shared by the group. */
  pattern: string;
  /** What the code means and how to act on it, when known. */
  hint?: string;
  /** Up to three verbatim messages. */
  examples: string[];
  /** Up to twenty distinct "dir/file.sv:line" locations. */
  locations: string[];
}

export interface WarningsReport {
  logs: { pnr?: string; synthesis?: string };
  totals: { errors: number; warnings: number; pnr: number; synthesis: number };
  groups: WarningGroup[];
  /**
   * Nets the timing engine treated as clocks without a constraint (TA1132),
   * flagged when the timing report also lists them under "no timing paths".
   */
  unconstrainedClocks: { clock: string; noTimingPaths: boolean }[];
  notes: string[];
}
