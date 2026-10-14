import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FoundBuild } from './discover.js';
import type { LogMessage, LogStage, WarningGroup, WarningsReport } from './types.js';

/**
 * Reads the tool logs Gowin EDA leaves next to the reports:
 *
 *   impl/gwsynthesis/<name>.log   — GowinSynthesis (EX*, NL*, DI*, CV* codes)
 *   impl/pnr/<name>.log           — place & route (TA*, PR*, CT*, PA* codes)
 *
 * Every diagnostic is one line of the form
 *   WARN  (TA1132) :  'u_div/CLKOUT.default_gen_clk' was determined to be a clock but was not created.
 *   ERROR  (CT1135) : "C:\...\top.cst":389 | Can't find object named 'u_pll'
 * optionally ending in ("C:\...\file.sv":123) for a source location.
 */

const LINE = /^\s*(WARN|ERROR|INFO)\s*\((\w+)\)\s*:\s*(.*?)\s*$/;
const TRAILING_LOC = /\("([^"]+)":(\d+)\)\s*$/;
const LEADING_LOC = /^"([^"]+)":(\d+)\s*\|\s*/;

/**
 * What the common codes mean and what to do about them. Only codes seen in
 * real logs are listed; anything else is reported with its message alone.
 */
export const CODE_HINTS: Record<string, string> = {
  TA1132:
    'A net drives clock pins but has no create_clock / create_generated_clock in the .sdc, so its paths are unconstrained and absent from the timing report.',
  TA1117:
    'The timing engine cannot relate these two clocks (one is usually the unconstrained generated clock above). Constrain both or declare them asynchronous with set_clock_groups.',
  TA1123: 'Clock definition issue reported by the timing engine; read the message.',
  PR1014:
    'This clock is routed on ordinary fabric wires instead of a global buffer, so skew and delay are unbounded. Move the pin to a GCLK-capable site or add a BUFG/CLKDIV.',
  CT1135: 'A .cst/.sdc constraint names an object that does not exist in the netlist; the constraint was dropped.',
  PA1019: 'PLL VCO frequency out of range; the PLL will not lock as configured.',
  ST0001: 'Static timing analysis was skipped because circuit checks failed — the timing report is meaningless.',
  EX2478: 'SystemVerilog forbids initialising a non-net output port at its declaration; the initial value is ignored.',
  EX2987: 'Variable declared inside a function/task without automatic or static; synthesis assumes static.',
  EX3005: 'unique/priority case or if does not cover every value; synthesis adds a default, simulation may differ.',
  EX3780: 'Signal is never assigned; its declared initial value is used as a constant.',
  EX3791: 'Right-hand side wider than the target: upper bits are silently dropped.',
  EX3792: 'Literal wider than its target width: upper bits are silently dropped.',
  EX1998: 'Net has no driver; it is tied off.',
  EX2565: 'Instance input is undriven and tied to 0 — simulation and hardware may disagree.',
  EX3073: 'Port left unconnected on an instance.',
  EX3670: 'Port width mismatch between instance and module.',
  EX0200: 'Unknown or invalid attribute on an object; ignored.',
  EX3628: 'ANSI port re-declared in the body; the second declaration is ignored.',
  NL0001: 'Dangling instance with no load was removed.',
  NL0002: 'Instance swept away during optimisation because nothing uses its outputs.',
  DI0002: 'Initial value on a register that cannot be initialised in hardware; ignored.',
  DI0003: 'Latch inferred — usually a missing else/default in combinational logic.',
  DI0004: 'Register with both asynchronous set and reset; not supported cleanly by the fabric.',
  DI0018: 'Fan-out optimisation disabled for this net; may hit resource limits.',
  CV0016: 'Input port unused by the design.',
  CV0017: 'Inout port unused by the design.',
  CV0018: 'Input port bit unused by the design.',
  CV0020: 'Input bus bits unused by the design.',
  AG0100: 'Combinational loop detected; timing on it cannot be analysed.',
  AG0101: 'Netlist is not acyclic (combinational loop).',
};

/** Paths to the two logs of a build, when they exist. */
export function logPaths(found: FoundBuild): { pnr?: string; synthesis?: string } {
  const pnr = join(found.implDir, 'pnr', `${found.name}.log`);
  const synthesis = join(found.implDir, 'gwsynthesis', `${found.name}.log`);
  return {
    pnr: existsSync(pnr) ? pnr : undefined,
    synthesis: existsSync(synthesis) ? synthesis : undefined,
  };
}

export function parseLogText(text: string, stage: LogStage): LogMessage[] {
  const out: LogMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LINE);
    if (!m) continue;
    let message = m[3];
    let file: string | undefined;
    let lineNo: number | undefined;

    const trailing = message.match(TRAILING_LOC);
    if (trailing) {
      file = trailing[1];
      lineNo = Number(trailing[2]);
      message = message.slice(0, trailing.index).trim();
    } else {
      const leading = message.match(LEADING_LOC);
      if (leading) {
        file = leading[1];
        lineNo = Number(leading[2]);
        message = message.slice(leading[0].length).trim();
      }
    }

    out.push({ level: m[1] as LogMessage['level'], code: m[2], message, file, line: lineNo, stage });
  }
  return out;
}

/**
 * Quoted names in a message. A single quote only opens a string at the start
 * or after whitespace/punctuation: the apostrophes of "Can't calculate
 * clocks' relationship" (TA1117, CK3000) are not quotes, and a 32'b0 literal
 * inside a double-quoted name (EX0200) must not end it.
 */
const QUOTED = /"([^"]*)"|(^|[\s(:,=])'([^']*)'/g;

/** `'u_div/CLKOUT.default_gen_clk' was determined to be a clock but was not created.` -> the quoted net. */
export function quoted(message: string): string[] {
  return [...message.matchAll(QUOTED)].map((m) => m[1] ?? m[3]).filter((s) => s);
}

/** Collapses the message into a shape shared by every occurrence of the code. */
export function pattern(message: string): string {
  return message
    .replace(QUOTED, (_m: string, _dq: string | undefined, before: string | undefined) => `${before ?? ''}X`)
    .replace(/\b\d+\b/g, 'N');
}

function shortFile(file: string | undefined, line: number | undefined): string | undefined {
  if (!file) return undefined;
  const base = file.split(/[\\/]/).slice(-2).join('/');
  return line != null ? `${base}:${line}` : base;
}

export function groupMessages(messages: LogMessage[]): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  for (const m of messages) {
    const k = `${m.stage}:${m.level}:${m.code}`;
    let g = groups.get(k);
    if (!g) {
      g = {
        code: m.code,
        level: m.level,
        stage: m.stage,
        count: 0,
        pattern: pattern(m.message),
        hint: CODE_HINTS[m.code],
        examples: [],
        locations: [],
      };
      groups.set(k, g);
    }
    g.count++;
    if (g.examples.length < 3) g.examples.push(m.message);
    const loc = shortFile(m.file, m.line);
    if (loc && g.locations.length < 20 && !g.locations.includes(loc)) g.locations.push(loc);
  }
  // Errors first, then by how often each code fires.
  const rank = (l: LogMessage['level']) => (l === 'ERROR' ? 0 : l === 'WARN' ? 1 : 2);
  return [...groups.values()].sort(
    (a, b) => rank(a.level) - rank(b.level) || b.count - a.count || a.code.localeCompare(b.code),
  );
}

export function readWarnings(
  found: FoundBuild,
  clocksWithoutPaths: string[] | undefined,
): WarningsReport {
  const paths = logPaths(found);
  const messages: LogMessage[] = [];
  if (paths.synthesis) messages.push(...parseLogText(readFileSync(paths.synthesis, 'utf8'), 'synthesis'));
  if (paths.pnr) messages.push(...parseLogText(readFileSync(paths.pnr, 'utf8'), 'pnr'));

  // TA1132 names every net the engine treats as a clock without a
  // constraint. Cross-checking against the timing report's "no timing paths"
  // list separates the ones that really left paths unanalysed from the ones
  // the report still covered through another clock.
  const unconstrainedClocks = messages
    .filter((m) => m.code === 'TA1132')
    .flatMap((m) => quoted(m.message).slice(0, 1))
    .filter((c, i, arr) => arr.indexOf(c) === i)
    .map((clock) => ({
      clock,
      noTimingPaths: clocksWithoutPaths?.includes(clock) ?? false,
    }));

  const notes: string[] = [];
  if (!paths.pnr) notes.push(`no PnR log at impl/pnr/${found.name}.log`);
  if (!paths.synthesis) notes.push(`no synthesis log at impl/gwsynthesis/${found.name}.log`);
  if (clocksWithoutPaths == null && unconstrainedClocks.length) {
    notes.push('no timing report to cross-check the unconstrained clocks against');
  }

  return {
    logs: paths,
    totals: {
      errors: messages.filter((m) => m.level === 'ERROR').length,
      warnings: messages.filter((m) => m.level === 'WARN').length,
      pnr: messages.filter((m) => m.stage === 'pnr').length,
      synthesis: messages.filter((m) => m.stage === 'synthesis').length,
    },
    groups: groupMessages(messages),
    unconstrainedClocks,
    notes,
  };
}
