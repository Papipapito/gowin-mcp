# gowin-mcp

An MCP server that turns Gowin EDA build reports into structured data.

Gowin EDA writes everything you need after a place & route — resource usage, achieved
frequency per clock, the exact register-to-register path that failed setup, the pin
every port landed on, the warnings that explain why a clock was never constrained —
and then buries it in a multi-megabyte HTML file nobody opens. This server reads those
artifacts and hands back the numbers.

Built for Sipeed Tang boards (GW1N / GW2A / GW5A) but it only cares about the report
format, so any Gowin EDA project works.

## What it answers

- Did this build close timing, and if not, which path failed and by how much?
- Could timing even be verified? (`unknown` is a first-class answer — see below.)
- What is the achieved fMax on each clock domain versus its constraint, and is a
  shortfall real or just how Gowin reports multicycle paths?
- How much of the device am I using — CLS, LUT, ALU, registers, BSRAM, DSP, I/O?
- Which package pin is each port on, with what I/O standard, drive and pull?
- Which warnings fired, how often, and which clocks are missing a constraint?
- **What did my last change cost me?** (`gowin_compare` diffs two builds, bitstream
  included.)
- Is this build good enough to merge? (`gowin_check` with CI thresholds.)

## Install

Run it from npm, with no install step:

```bash
npx -y gowin-mcp
```

Or build it from the repository:

```bash
git clone https://github.com/Papipapito/gowin-mcp.git
cd gowin-mcp
npm install
npm run build
```

Register it. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gowin": {
      "command": "node",
      "args": ["C:\\path\\to\\gowin-mcp\\dist\\index.js"]
    }
  }
}
```

For Claude Code:

```bash
claude mcp add gowin -- node /path/to/gowin-mcp/dist/index.js
```

## Tools

| Tool | Purpose |
|---|---|
| `gowin_summary` | Device, resources, fMax, timing status and violations, bitstream header, what the `.sdc` declares — in one call. Start here. |
| `gowin_check` | CI gate: `pass` / `fail` / `unknown` with the reason, optional thresholds, per-clock fMax waivers. |
| `gowin_timing` | fMax per clock, total negative slack, worst setup/hold paths, recovery/removal summary. |
| `gowin_resources` | Full resource tables, including I/O banks and clock resources. |
| `gowin_pins` | Port → package pin, bank, I/O type, drive, pull, dual-function role; global clock routing. |
| `gowin_warnings` | Synthesis and PnR log diagnostics grouped by code, with hints; clocks missing a constraint. |
| `gowin_compare` | Diff two builds: resource deltas, fMax deltas, violations introduced/fixed, same bitstream or not. |
| `gowin_list_builds` | Find every Gowin build under a directory tree (reads only report headers, so it is fast). |

Every tool returns a compact text rendering by default. Pass `format: "json"` for the
full data: the JSON comes back as the text and as `structuredContent`. (No tool
declares an MCP `outputSchema`: declaring one obliges the server to return
`structuredContent` on every call, and clients that understand it then show the JSON
instead of the text.) The shapes are documented in `src/schemas.ts` and the tests hold
the JSON to them. All tools are annotated read-only, idempotent and non-destructive.

Paths are forgiving: pass the project directory, its `impl/` directory, `impl/pnr/`
itself, or the `.rpt.txt`, with either kind of slash. When one `impl/pnr/` holds
several builds (one per Gowin project file) the most recently written report is used
and the others are named in the text and in the JSON (`siblings`, `note`); pass `name`
to pick one explicitly. A `name` that does not match the `.rpt.txt` you pointed at is
an error, not a silent substitution.

### `gowin_check` and the `unknown` status

Timing has three outcomes, not two:

| status | meaning |
|---|---|
| `pass` | A timing report was read and shows no violation. |
| `fail` | At least one violation, or a threshold breached. |
| `unknown` | Timing could not be verified: neither `_tr_content.html` nor `<name>.tr` exists (the timing engine did not run), the report layout was not recognised, or it lists no clocks at all (nothing constrained). |

`unknown` is never reported as clean. The JSON carries `status` and `reason`; the
text starts with `UNKNOWN — timing not verified: …`.

For CI, `gowin_check` also takes:

- `maxUtilization` — fail when CLS, Logic or BSRAM utilization exceeds this percentage.
  The percentage is recomputed from `used/available` (the tool's own column is rounded:
  29142/29952 is 97.30 %, reported as 98 %); when the two differ the rounded figure is
  quoted next to it;
- `minFmaxMarginMhz` — fail when any clock achieves less than constraint + this margin;
- `failOnMissingTiming` — default `true`; set `false` to accept an `unknown` build on
  resources alone;
- `ignoreCrossDomain` — default `false`; set `true` when the paths between clock domains
  are declared false paths in the `.sdc` (see [TNS versus paths](#tns-versus-paths));
- `fmaxWaivers` — clock names (or globs with `*` and `?`) whose fMax-only violation is
  waived (see [fMax versus multicycle paths](#fmax-versus-multicycle-paths)).

The result's `ok` field is the decision to act on (`status` says what is known,
`ok` says whether to accept the build); `reasons` lists why; `ignoredViolations`
lists what the options set aside, with a note each.

## Example

```
Build: project  (GW5AT-60, GW5AT-LV60PG484AC1/I0)
Tool:  V1.9.11.03 Education
Built: Thu Jul 16 20:58:03 2026   PnR 0h 3m 29s   peak 1848MB
Bitstream: 0xDE97 checksum, body sha256 baffbcb9fa04… (Thu Jul 16 20:57:51 2026)

Resources
  Logic: 28034/59904 (47%)
    LUT 21883, ALU 3325, ROM16 0
  CLS: 19618/29952 (66%)
  Register: 15014/60780 (25%)
  BSRAM: 73/118 (62%)
  DSP: 10.5/118 (9%)
  I/O Port: 141/297 (48%)

Timing: 3 VIOLATIONS
  setup clk_54m    -1.826 ns  1 endpoint failing setup — worst path -1.826 ns:
                              cpu1/u0/ISet_1_s87/Q -> mem1/ram_busy_s0/CE
  setup clk_hdmi   -0.378 ns  ...
  hold  clk_27m    -0.028 ns  ...

fMax per clock
  clk_54m: 33.548 MHz vs 53.996 MHz constraint (-20.448) [FAIL]
  clk_hdmi: 72.221 MHz vs 74.25 MHz constraint (-2.029) [FAIL]
  clk_108m: 159.744 MHz vs 107.991 MHz constraint (+51.753) [ok]
  ...
```

A gate with thresholds:

```
FAIL — CLS at 76.34% (77% as the tool rounds it) exceeds maxUtilization 50%
  threshold utilization CLS at 76.34% (77% as the tool rounds it) exceeds maxUtilization 50%
  threshold fmaxMargin  clk_eng margin 13.974 MHz is below minFmaxMarginMhz 20 (53.974 vs 40 MHz)
```

An fMax shortfall with a clean TNS, before and after the waiver:

```
FAIL — 1 timing violation

Timing: 1 VIOLATION
  fmax  clk_54m   -21.541 MHz  32.455 MHz achieved against a 53.996 MHz constraint, with no
        setup violation reported (setup TNS 0.000). 18 set_multicycle_path commands in the
        .sdc name this clock; 2 of its reported setup paths are half-cycle relations (launch
        and capture on opposite edges). Gowin derives fMax from the worst path's relation
        minus its slack as if that were a single period, so paths under a multicycle or
        half-cycle relation pull the figure below the constraint although they meet it. If
        that is the case here, waive it with fmaxWaivers; otherwise check that the constraint
        covers the domain.
```

```
PASS — no timing violations
  ignored fmax clk_54m -21.541 MHz
  note: 1 fMax-only violation waived (fmaxWaivers=["clk_54m"]): clk_54m (-21.541 MHz). Only safe
        when the clock's setup TNS is 0 and the shortfall is how Gowin reports its multicycle or
        half-cycle paths; a TNS violation is never waived.
```

Warnings, grouped:

```
demo: 0 errors, 192 warnings (synthesis 186, pnr 6)
  WARN  EX3791 x70   [synthesis] Expression size 8 truncated to fit in target size 7  @ opl3/afifo.v:144, ... +17 more
        -> Right-hand side wider than the target: upper bits are silently dropped.
  WARN  TA1132 x3    [pnr] 'u_top/u_div5m4/CLKOUT.default_gen_clk' was determined to be a clock but was not created.
        -> A net drives clock pins but has no create_clock / create_generated_clock in the .sdc, ...

Clocks without a constraint (TA1132)
  u_top/u_div5m4/CLKOUT.default_gen_clk   <- also "no timing paths" in the timing report
```

Pins, filtered with a glob:

```
8 of 102 ports; 121 package pins, 19 unused
  tmds_clk_p             pin 33/5    out  LVCMOS33D  pull NONE  drive 8  IOB24[A]  pair tmds_clk_n
  tmds_data_p[0]         pin 35/4    out  LVCMOS33D  pull NONE  drive 8  IOB30[A]  cfg GCLKT_4  pair tmds_data_n[0]
```

## What it reads

| File | Used for |
|---|---|
| `impl/pnr/<name>.rpt.txt` | Device, tool version, resource tables, PnR runtime, pinout (sections 6-8) |
| `impl/pnr/<name>_tr_content.html` | fMax, total negative slack, setup/hold/recovery/removal path tables |
| `impl/pnr/<name>.tr` | The same timing report as plain text; read when the HTML is missing (V1.9.12.04 writes it on every run) |
| `impl/pnr/<name>.fs` | Bitstream header (tool version, device, CheckSum, UserCode, Created Time) and a SHA-256 of the body without the `//` header |
| `impl/pnr/<name>.log` | PnR warnings and errors (TA*, PR*, CT* codes) |
| `impl/gwsynthesis/<name>.log` | Synthesis warnings and errors (EX*, NL*, DI*, CV* codes) |
| the `.sdc` named in the report | Clocks, `set_multicycle_path`, `set_false_path`, `set_clock_groups` — only to explain an fMax shortfall; found at the reported path or by file name under the project. A header of `---` means the build has none. |

`<name>.tr.html` is only a ~350-byte frameset wrapper — the data is in the
`_tr_content` sibling.

Tables are parsed structurally (`tr`/`td` in HTML, column names in the text tables,
the `====` rule's column spans in the `.tr`), not by position, so a column added
between tool versions — the `CFG` column that appeared in the pinout around V1.9.10 —
surfaces as a missing field rather than a silently misaligned number.

## Scope

This server reads results. It does not run builds.

A GW5A place & route takes minutes, which does not fit an MCP request, and driving
long builds through a tool call hides their output. Keep building with `gw_sh`,
`make`, or the Gowin GUI as you already do — then point this at the results.

## Verified against

The parsers were run over 167 real builds (October 2026) with no parse failures, and
0.2.2 gives the same verdicts and violations as 0.2.1 on every one of them:

| | Verified |
|---|---|
| Tool versions | V1.9.8.10, V1.9.8.11, V1.9.9, V1.9.9 Beta-4, V1.9.9.03, V1.9.10.03, V1.9.11, V1.9.11.01, V1.9.11.02, V1.9.11.03, V1.9.12.02_SP2, V1.9.12.03, V1.9.12.04 (Education and 64-bit editions) |
| Devices | GW1NR-9 (Tang Nano 9K), GW2A-18 (Tang Primer 20K), GW2AR-18 (Tang Nano 20K), GW5A-25 (Tang Primer 25K), GW5AT-60 (Tang Console 60K) |
| Host | Windows 11 |

Known gaps:

- **Only the proprietary Gowin EDA flow.** Output from the open-source chain
  (yosys / nextpnr-himbaechel / apicula) is a different format and is not parsed.
- Only English-language reports.
- Power reports (`*.power.html`) are written by the tool but not read yet.
- The `.tr` and the HTML of the same build agree on everything except the third
  decimal of some fMax figures (Gowin rounds the two files differently by 0.001 MHz).
- The unit tests run on trimmed fixtures from five of those builds (V1.9.12.04,
  V1.9.12.03 on GW2AR-18 and GW5AT-60, V1.9.11.03 and V1.9.9); the full matrix above
  was exercised manually.

Failures should be visible rather than silent: fields that do not parse come back
absent, timing that cannot be verified comes back `unknown`. If you get a missing or
implausible number, please open an issue with the offending `.rpt.txt` or
`_tr_content.html` attached.

## Notes

### TNS versus paths

Gowin's Total Negative Slack summary is per clock, and it leaves out paths whose
launch and capture clocks differ. A design can therefore show every TNS row at
`0.000` and every fMax above its constraint while the setup table opens with a
`-2.09 ns` path from `clock_54m` to `clock_27m`. The GUI's summary page says clean;
the design is not.

Violations are collected from both places:

- **TNS summary** (`source: "tns"`): complete for what it counts, since the path
  tables are capped by `-max_paths` at report time and would under-report a design
  with many failures.
- **Path tables** (`source: "paths"`): every setup or hold path with negative slack
  whose clock pair no negative TNS row of the same kind accounts for. One violation
  per `(from clock, to clock)` pair, with `clock` rendered as `from -> to`,
  `amount` the worst slack, and `pathCount` the number of such paths — a lower
  bound, because of the cap. `crossDomain` is `true` when the clocks differ.

Cross-domain violations fail `gowin_check` by default. Whether they are real depends
on the constraints: a crossing that goes through a synchroniser or an asynchronous
FIFO should be declared with `set_false_path` or `set_clock_groups -asynchronous` in
the `.sdc`, after which the timing engine stops reporting it. If the `.sdc` already
declares them and the paths still show, or the crossing is known to be safe, pass
`ignoreCrossDomain: true`: the violations are then listed under `ignoredViolations`
with a note, and do not affect `status`. A violation the TNS does count is never
ignored.

Of 159 local builds checked when this was added, 45 had negative paths the TNS left
out; 30 of them had been reported as clean before.

### fMax versus multicycle paths

Gowin's Max Frequency summary derives each clock's fMax from its worst path's
relation minus slack, as if that were one clock period. A path under
`set_multicycle_path -end 2` has a relation of two periods; a path launched on one
edge and captured on the other has half a period. Either way the figure lands below
the constraint although every endpoint meets it — which is exactly what the clock's
`0.000` setup TNS says. A GW5AT-60 build with a Z80 on `clk_54m` and multicycle
constraints on its register file reads 32.455 MHz against 53.996 with a clean TNS.

Such a clock is reported as an fMax-only violation (`source: "fmax"`), which is only
raised when no setup violation already covers the clock. Its detail quotes the setup
TNS, how many `set_multicycle_path` / `set_false_path` commands in the `.sdc` name the
clock, and how many of its reported setup paths are half-cycle relations
(`fromEdge` ≠ `toEdge`). When that evidence is there, waive the clock with
`fmaxWaivers: ["clk_54m"]`: the violation moves to `ignoredViolations` with a note,
and `minFmaxMarginMhz` does not re-flag it. When it is not, the constraint probably
does not cover the domain. A TNS violation on the same clock is never waived.

### Other

- Recovery and removal paths (asynchronous set/reset checks) are parsed into their own
  arrays and never mixed into the hold table.
- `gowin_compare` across different devices reports the numbers but does not classify
  violations (`comparable: false`, `safe: null`): a violation only one side has
  belongs to another design, not to the change.
- The bitstream body hash ignores the `//` header, so a rebuild that changed nothing
  but `Created Time` shows `sameBitstream: true`.

## Development

```bash
npm run build      # tsc -> dist/
npm test           # node:test over tests/fixtures (62 tests)
node tests/stdio.mjs <path-to-a-real-build>   # drive the server over stdio
node tests/smoke.mjs <path-to-a-real-build>   # parse one build and print what was read
```

See [CHANGELOG.md](CHANGELOG.md) for what each release changed.

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE).

You can use it freely, including at work. If you distribute a modified version, or offer
it to others as a service, you must publish your changes under the same license.

Releases up to and including 0.2.0 were published under the MIT License and remain
available under those terms.
