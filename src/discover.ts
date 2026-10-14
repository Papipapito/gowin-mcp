import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

/**
 * Locates Gowin builds on disk. A build is any directory containing
 * `impl/pnr/<name>.rpt.txt` — the artifact Gowin EDA always writes on a
 * successful place & route.
 */

export interface FoundBuild {
  /** Directory holding the Gowin project (the parent of impl/). */
  projectDir: string;
  implDir: string;
  name: string;
  rptTxt: string;
  /** Present only when the timing engine ran. */
  trContent?: string;
  /** The plain-text timing report (`<name>.tr`), read when `trContent` is missing. */
  tr?: string;
  /** The bitstream (`<name>.fs`), when it was generated. */
  fs?: string;
  /** ISO mtime of the .rpt.txt — the report is rewritten on every PnR run. */
  mtime: string;
  /**
   * Names of the other builds sharing this impl/pnr/ when the caller did not
   * pick one explicitly. Set by resolveBuild only.
   */
  siblings?: string[];
}

const SKIP = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
]);

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The artifacts of one report file, by its siblings in the same directory. */
function describe(pnrDir: string, implDir: string, entry: string): FoundBuild | undefined {
  const rptTxt = join(pnrDir, entry);
  const name = entry.replace(/\.rpt\.txt$/i, '');
  let mtime = '';
  try {
    mtime = statSync(rptTxt).mtime.toISOString();
  } catch {
    return undefined;
  }
  const optional = (file: string): string | undefined => {
    const p = join(pnrDir, file);
    return existsSync(p) ? p : undefined;
  };
  return {
    projectDir: implDir.replace(/[\\/]impl$/i, ''),
    implDir,
    name,
    rptTxt,
    trContent: optional(`${name}_tr_content.html`),
    tr: optional(`${name}.tr`),
    fs: optional(`${name}.fs`),
    mtime,
  };
}

/** Reads the pnr/ directory of a candidate build and returns its artifacts. */
function inspectImplDir(implDir: string): FoundBuild[] {
  const pnr = join(implDir, 'pnr');
  if (!existsSync(pnr)) return [];

  const out: FoundBuild[] = [];
  for (const entry of safeReaddir(pnr)) {
    if (!entry.toLowerCase().endsWith('.rpt.txt')) continue;
    const b = describe(pnr, implDir, entry);
    if (b) out.push(b);
  }
  // Newest first, so callers that take the first entry get the latest run.
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

export function discoverBuilds(root: string, maxDepth = 8): FoundBuild[] {
  const found: FoundBuild[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;

    for (const entry of safeReaddir(dir)) {
      if (SKIP.has(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);

      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      if (entry.toLowerCase() === 'impl') {
        found.push(...inspectImplDir(full));
        // impl/ holds only tool output — nothing below it is a nested build.
        continue;
      }
      walk(full, depth + 1);
    }
  };

  if (!existsSync(root)) return found;
  walk(root, 0);
  found.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return found;
}

function sameName(asked: string, name: string): boolean {
  return asked.toLowerCase().replace(/\.rpt\.txt$/i, '') === name.toLowerCase();
}

/**
 * Resolves a user-supplied path to a build. Accepts the project directory,
 * the impl/ directory, impl/pnr/ itself, or the .rpt.txt, so callers can
 * paste whatever path they happen to have, with either kind of slash.
 *
 * A single impl/pnr/ can hold several builds (one per project file in the
 * Gowin GUI). With no `name`, the most recently written report wins and the
 * others are listed in `siblings` so the choice is visible. With a `name`,
 * that build is returned or an error is thrown — silently falling back to
 * another build would defeat the point of asking. A `name` that does not
 * match an explicit .rpt.txt is an error too.
 */
export function resolveBuild(path: string, name?: string): FoundBuild | undefined {
  const abs = resolve(path);

  if (abs.toLowerCase().endsWith('.rpt.txt')) {
    if (!existsSync(abs)) return undefined;
    const pnrDir = dirname(abs);
    // A report inside impl/pnr/ belongs to that impl/; a report copied
    // somewhere on its own is described from its own directory.
    const implDir = basename(pnrDir).toLowerCase() === 'pnr' ? dirname(pnrDir) : pnrDir;
    // The directory entry, not the spelling the caller used: path.relative
    // compares case-insensitively on Windows, so "STALE.RPT.TXT" finds
    // stale.rpt.txt and the build keeps its real name.
    const entry = safeReaddir(pnrDir).find((e) => relative(join(pnrDir, e), abs) === '') ?? basename(abs);
    const hit = describe(pnrDir, implDir, entry);
    if (!hit) return undefined;
    if (name && !sameName(name, hit.name)) {
      throw new Error(`The report at ${path} is build "${hit.name}", not "${name}".`);
    }
    return hit;
  }

  const candidates = [abs, join(abs, 'impl'), join(abs, 'fpga', 'impl')];
  // impl/pnr/ itself: its parent is the impl/ directory.
  if (basename(abs).toLowerCase() === 'pnr') candidates.unshift(dirname(abs));
  let builds: FoundBuild[] = [];
  for (const c of candidates) {
    builds = inspectImplDir(c);
    if (builds.length) break;
  }
  // Fall back to a shallow search so a repo root still resolves.
  if (!builds.length) builds = discoverBuilds(abs, 3);
  if (!builds.length) return undefined;

  if (name) {
    const hit = builds.find((b) => sameName(name, b.name));
    if (!hit) {
      throw new Error(
        `No build named "${name}" under ${path}. Available: ${builds.map((b) => b.name).join(', ')}.`,
      );
    }
    return hit;
  }

  const [chosen, ...rest] = builds;
  const siblings = rest.filter((b) => b.implDir === chosen.implDir).map((b) => b.name);
  return siblings.length ? { ...chosen, siblings } : chosen;
}
