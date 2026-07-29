import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
  mtime: string;
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

/** Reads the pnr/ directory of a candidate build and returns its artifacts. */
function inspectImplDir(implDir: string): FoundBuild[] {
  const pnr = join(implDir, 'pnr');
  if (!existsSync(pnr)) return [];

  const out: FoundBuild[] = [];
  for (const entry of safeReaddir(pnr)) {
    if (!entry.toLowerCase().endsWith('.rpt.txt')) continue;
    const rptTxt = join(pnr, entry);
    const name = entry.replace(/\.rpt\.txt$/i, '');
    const trContent = join(pnr, `${name}_tr_content.html`);

    let mtime = '';
    try {
      mtime = statSync(rptTxt).mtime.toISOString();
    } catch {
      continue;
    }

    out.push({
      projectDir: implDir.replace(/[\\/]impl$/i, ''),
      implDir,
      name,
      rptTxt,
      trContent: existsSync(trContent) ? trContent : undefined,
      mtime,
    });
  }
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

/**
 * Resolves a user-supplied path to a build. Accepts the project directory,
 * the impl/ directory, or the .rpt.txt itself, so callers can paste whatever
 * path they happen to have.
 */
export function resolveBuild(path: string): FoundBuild | undefined {
  if (path.toLowerCase().endsWith('.rpt.txt') && existsSync(path)) {
    const implDir = path.replace(/[\\/]pnr[\\/][^\\/]+$/i, '');
    return inspectImplDir(implDir).find((b) => b.rptTxt === path);
  }

  const candidates = [path, join(path, 'impl'), join(path, 'fpga', 'impl')];
  for (const c of candidates) {
    const builds = inspectImplDir(c);
    if (builds.length) return builds[0];
  }

  // Fall back to a shallow search so a repo root still resolves.
  return discoverBuilds(path, 3)[0];
}
