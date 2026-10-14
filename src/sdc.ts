import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConstraintsInfo } from './types.js';

/**
 * Reads the timing constraints (.sdc) a build was placed with — only as far
 * as explaining the timing report needs it. Nothing is evaluated: the file is
 * scanned for the commands that change what the report means.
 *
 * Why it matters: Gowin's Max Frequency summary derives the fMax of a clock
 * from the worst path's (relation - slack) as if that were one period. A
 * path under a `set_multicycle_path -end 2` has a relation of two periods,
 * so a design that meets every constraint (TNS 0.000 on that clock) can still
 * show an fMax of 32 MHz against a 54 MHz constraint. Knowing the .sdc names
 * that clock in a multicycle or false-path command turns "check the
 * constraint" into "this is how Gowin reports multicycle paths".
 */

export interface SdcCommands {
  clocks: string[];
  multicyclePaths: string[];
  falsePaths: string[];
  clockGroups: string[];
}

export interface SdcInfo extends SdcCommands {
  /** The .sdc path the report names. */
  reported?: string;
  /** The file actually read, when found. */
  path?: string;
  readable: boolean;
}

/**
 * Command lines with comments removed. Gowin's parser accepts both `#` and
 * `//` comments and has no line continuation, so one line is one command.
 */
function commands(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const cut = line.search(/\s(#|\/\/)/);
    const cmd = (cut >= 0 ? line.slice(0, cut) : line).trim();
    if (cmd) out.push(cmd);
  }
  return out;
}

export function parseSdc(text: string): SdcCommands {
  const info: SdcCommands = { clocks: [], multicyclePaths: [], falsePaths: [], clockGroups: [] };
  for (const cmd of commands(text)) {
    const word = cmd.split(/\s+/)[0];
    if (word === 'create_clock' || word === 'create_generated_clock') {
      const m = cmd.match(/-name\s+(\S+)/);
      if (m && m[1] !== '-source' && !m[1].startsWith('-')) info.clocks.push(m[1]);
    } else if (word === 'set_multicycle_path') info.multicyclePaths.push(cmd);
    else if (word === 'set_false_path') info.falsePaths.push(cmd);
    else if (word === 'set_clock_groups') info.clockGroups.push(cmd);
  }
  return info;
}

function walkFor(dir: string, base: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (e.toLowerCase() === base.toLowerCase()) {
      const p = join(dir, e);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        /* unreadable entry */
      }
    }
  }
  for (const e of entries) {
    if (e.startsWith('.') || e === 'impl' || e === 'node_modules') continue;
    const p = join(dir, e);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    const hit = walkFor(p, base, depth - 1);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Locates the .sdc the report names: at that path, or — because builds get
 * copied to other machines and directories — by file name under the project
 * directory (constraints/ and src/ first, then a shallow search).
 */
export function findSdc(reported: string | undefined, projectDir: string): string | undefined {
  if (!reported) return undefined;
  if (existsSync(reported)) return reported;
  const base = reported.split(/[\\/]/).pop() ?? reported;
  for (const c of [join(projectDir, base), join(projectDir, 'constraints', base), join(projectDir, 'src', base)]) {
    if (existsSync(c)) return c;
  }
  return walkFor(projectDir, base, 3);
}

export function readSdc(reported: string | undefined, projectDir: string): SdcInfo {
  const empty: SdcInfo = { reported, readable: false, clocks: [], multicyclePaths: [], falsePaths: [], clockGroups: [] };
  const path = findSdc(reported, projectDir);
  if (!path) return empty;
  try {
    return { ...empty, path, readable: true, ...parseSdc(readFileSync(path, 'utf8')) };
  } catch {
    return { ...empty, path };
  }
}

/** Whole-token mention of a clock name in a command. Names may contain / . [ ]. */
function mentions(cmd: string, clock: string): boolean {
  const esc = clock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s{\\[])${esc}(?=$|[\\s}\\]])`).test(cmd);
}

export interface ClockExceptions {
  multicycle: number;
  falsePath: number;
  clockGroups: number;
}

/** How many commands of each kind name this clock. */
export function clockExceptions(sdc: SdcInfo | undefined, clock: string): ClockExceptions {
  if (!sdc?.readable) return { multicycle: 0, falsePath: 0, clockGroups: 0 };
  return {
    multicycle: sdc.multicyclePaths.filter((c) => mentions(c, clock)).length,
    falsePath: sdc.falsePaths.filter((c) => mentions(c, clock)).length,
    clockGroups: sdc.clockGroups.filter((c) => mentions(c, clock)).length,
  };
}

/** The shape published in gowin_summary. */
export function constraintsInfo(sdc: SdcInfo | undefined): ConstraintsInfo | undefined {
  if (!sdc) return undefined;
  return {
    reported: sdc.reported,
    path: sdc.path,
    readable: sdc.readable,
    clocks: sdc.clocks,
    multicyclePaths: sdc.multicyclePaths.length,
    falsePaths: sdc.falsePaths.length,
    clockGroups: sdc.clockGroups.length,
  };
}
