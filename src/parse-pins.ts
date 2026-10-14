import { readFileSync } from 'node:fs';
import type { ClockSignal, PackagePin, PinReport, PortPin } from './types.js';

/**
 * Parses the pin sections of `impl/pnr/<name>.rpt.txt`:
 *
 *   6. Global Clock Signals   — which nets got a global/HCLK/LW clock route
 *   7. Pinout by Port Name    — one row per top-level port, with its I/O
 *                               attributes as actually placed
 *   8. All Package Pins       — every pin of the package, used or not
 *
 * Columns are mapped by header name, not position: V1.9.9 reports lack the
 * "CFG" column that newer releases insert between Site and IO Type.
 */

interface PipeTable {
  header: string[];
  rows: string[][];
}

/** "Loc./Bank" -> "locbank", "Pull Mode" -> "pullmode". */
function key(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Reads the `|`-delimited table that follows `heading`, up to the `====` rule
 * that closes every section. The first row with pipes is the header.
 */
function pipeTable(text: string, heading: RegExp): PipeTable | undefined {
  const start = text.search(heading);
  if (start < 0) return undefined;
  const rest = text.slice(start);
  const end = rest.search(/^\s*={3,}\s*$/m);
  const body = end > 0 ? rest.slice(0, end) : rest;

  let header: string[] | undefined;
  const rows: string[][] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes('|')) continue;
    if (/^\s*-{3,}/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (!header) {
      header = cells.map(key);
      continue;
    }
    if (cells.every((c) => !c)) continue;
    rows.push(cells);
  }
  return header ? { header, rows } : undefined;
}

/** `-` is Gowin's "nothing here"; `NA` is kept because it means "not applicable to this direction". */
function cell(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  const t = v.trim();
  return t === '' || t === '-' ? undefined : t;
}

/** "4/7" -> {pin: "4", bank: "7"};  "p73/2" -> {pin: "p73", bank: "2"}. */
function splitLoc(loc: string | undefined): { pin: string; bank?: string } {
  if (!loc) return { pin: '' };
  const m = loc.match(/^([^/]+)\/(.+)$/);
  return m ? { pin: m[1].trim(), bank: m[2].trim() } : { pin: loc.trim() };
}

function column(t: PipeTable, name: string): number {
  return t.header.indexOf(key(name));
}

function get(t: PipeTable, row: string[], name: string): string | undefined {
  const i = column(t, name);
  return i >= 0 ? cell(row[i]) : undefined;
}

function parseClocks(text: string): ClockSignal[] {
  const t = pipeTable(text, /^\s*\d*\.?\s*Global Clock Signals/m);
  if (!t) return [];
  const out: ClockSignal[] = [];
  for (const r of t.rows) {
    const signal = get(t, r, 'Signal');
    const type = get(t, r, 'Global Clock');
    if (!signal || !type) continue;
    out.push({ signal, type, location: get(t, r, 'Location') });
  }
  return out;
}

function ioAttributes(t: PipeTable, r: string[]) {
  return {
    dir: get(t, r, 'Dir.'),
    site: get(t, r, 'Site'),
    cfg: get(t, r, 'CFG'),
    ioType: get(t, r, 'IO Type'),
    drive: get(t, r, 'Drive'),
    pull: get(t, r, 'Pull Mode'),
    pciClamp: get(t, r, 'PCI Clamp'),
    hysteresis: get(t, r, 'Hysteresis'),
    openDrain: get(t, r, 'Open Drain'),
    vref: get(t, r, 'Vref'),
    singleResistor: get(t, r, 'Single Resistor'),
    diffResistor: get(t, r, 'Diff Resistor'),
    bankVccio: get(t, r, 'BankVccio') ?? get(t, r, 'Bank Vccio'),
  };
}

function parsePorts(text: string): PortPin[] {
  const t = pipeTable(text, /^\s*\d*\.?\s*Pinout by Port Name/m);
  if (!t) return [];
  const out: PortPin[] = [];
  for (const r of t.rows) {
    const port = get(t, r, 'Port Name');
    if (!port) continue;
    const { pin, bank } = splitLoc(get(t, r, 'Loc./Bank'));
    out.push({
      port,
      pin,
      bank,
      diffPair: get(t, r, 'Diff Pair'),
      constrained: get(t, r, 'Constraint') === 'Y',
      ...ioAttributes(t, r),
    });
  }
  return out;
}

function parsePackagePins(text: string): PackagePin[] {
  const t = pipeTable(text, /^\s*\d*\.?\s*All Package Pins/m);
  if (!t) return [];
  const out: PackagePin[] = [];
  for (const r of t.rows) {
    const loc = get(t, r, 'Loc./Bank');
    if (!loc) continue;
    const { pin, bank } = splitLoc(loc);
    out.push({ pin, bank, signal: get(t, r, 'Signal'), ...ioAttributes(t, r) });
  }
  return out;
}

export function parsePinText(text: string): PinReport {
  const ports = parsePorts(text);
  const packagePins = parsePackagePins(text);
  return {
    clocks: parseClocks(text),
    ports,
    packagePins,
    unusedPins: packagePins.filter((p) => !p.signal).length,
  };
}

export function parsePinReport(rptTxtPath: string): PinReport {
  return parsePinText(readFileSync(rptTxtPath, 'utf8'));
}

/**
 * Case-insensitive port filter. `*` and `?` work as globs; anything else is a
 * substring match, so "sdram" finds every O_sdram_* / IO_sdram_* port and
 * "tmds_*_p[0]" finds exactly one.
 */
export function portMatcher(pattern: string | undefined): (name: string) => boolean {
  if (!pattern) return () => true;
  if (/[*?]/.test(pattern)) {
    const re = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
      'i',
    );
    return (name) => re.test(name);
  }
  const needle = pattern.toLowerCase();
  return (name) => name.toLowerCase().includes(needle);
}
