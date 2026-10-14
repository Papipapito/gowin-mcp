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
  /** Percentage as reported by the tool (not recomputed). */
  utilization?: string;
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

export interface TimingPath {
  index: number;
  slack: number;
  from: string;
  to: string;
  fromClock: string;
  toClock: string;
  relation?: number;
  clockSkew?: number;
  dataDelay?: number;
}

export interface TimingReport {
  fmax: ClockFmax[];
  /** Clocks the engine found no paths for — usually unconstrained or unused. */
  clocksWithoutPaths: string[];
  tns: TnsRow[];
  setupPaths: TimingPath[];
  holdPaths: TimingPath[];
  /** Asynchronous set/reset release checks (report_timing -recovery). */
  recoveryPaths: TimingPath[];
  /** Asynchronous set/reset hold-side checks (report_timing -removal). */
  removalPaths: TimingPath[];
  /**
   * False when the file was there but neither the fMax nor the TNS summary
   * table was found — a format this parser does not understand. Nothing can
   * be concluded about timing in that case.
   */
  recognized: boolean;
}

export interface Violation {
  kind: 'setup' | 'hold' | 'fmax';
  clock: string;
  /** Slack in ns for setup/hold; MHz shortfall for fmax. */
  amount: number;
  unit: 'ns' | 'MHz';
  detail: string;
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

export interface BuildSummary {
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
}

export interface CheckThresholds {
  /** Fail when CLS, Logic or BSRAM utilization exceeds this percentage. */
  maxUtilization?: number;
  /** Fail when any clock's achieved-minus-constraint margin is below this many MHz. */
  minFmaxMarginMhz?: number;
  /** Default true: an unknown timing status fails the gate. */
  failOnMissingTiming?: boolean;
}

export interface ThresholdFailure {
  kind: 'utilization' | 'fmaxMargin';
  name: string;
  value: number;
  limit: number;
  detail: string;
}

export interface CheckResult {
  status: CheckStatus;
  /** The CI decision: accept the build or not. */
  ok: boolean;
  reasons: string[];
  violations: Violation[];
  timing: { status: CheckStatus; reason: string };
  thresholds: Required<Pick<CheckThresholds, 'failOnMissingTiming'>> &
    Pick<CheckThresholds, 'maxUtilization' | 'minFmaxMarginMhz'>;
  thresholdFailures: ThresholdFailure[];
}
