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
- What is the achieved fMax on each clock domain versus its constraint?
- How much of the device am I using — CLS, LUT, ALU, registers, BSRAM, DSP, I/O?
- Which package pin is each port on, with what I/O standard, drive and pull?
- Which warnings fired, how often, and which clocks are missing a constraint?
- **What did my last change cost me?** (`gowin_compare` diffs two builds.)
- Is this build good enough to merge? (`gowin_check` with CI thresholds.)

## Install

Run it straight from the repository (not published on npm yet):

```bash
git clone https://github.com/Papipapito/gowin-mcp.git
cd gowin-mcp
npm install
npm run build
```

Once it is published the same thing will be `npx -y gowin-mcp`; the `bin` entry and
`prepublishOnly` (build + tests) are already in place for that.

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
| `gowin_summary` | Device, resources, fMax, timing status and violations in one call. Start here. |
| `gowin_check` | CI gate: `pass` / `fail` / `unknown` with the reason, optional thresholds. |
| `gowin_timing` | fMax per clock, total negative slack, worst setup/hold paths, recovery/removal summary. |
| `gowin_resources` | Full resource tables, including I/O banks and clock resources. |
| `gowin_pins` | Port → package pin, bank, I/O type, drive, pull, dual-function role; global clock routing. |
| `gowin_warnings` | Synthesis and PnR log diagnostics grouped by code, with hints; clocks missing a constraint. |
| `gowin_compare` | Diff two builds: resource deltas, fMax deltas, violations introduced/fixed. |
| `gowin_list_builds` | Find every Gowin build under a directory tree (reads only report headers, so it is fast). |

Every tool publishes an `outputSchema` and returns `structuredContent` alongside a
compact text rendering; pass `format: "json"` to get the JSON as text instead. All
tools are annotated read-only, idempotent and non-destructive.

Paths are forgiving: pass the project directory, its `impl/` directory, or the
`.rpt.txt` itself. When one `impl/pnr/` holds several builds (one per Gowin project
file) the most recently written report is used and the others are named in the
output; pass `name` to pick one explicitly.

### `gowin_check` and the `unknown` status

Timing has three outcomes, not two:

| status | meaning |
|---|---|
| `pass` | A timing report was read and shows no violation. |
| `fail` | At least one violation, or a threshold breached. |
| `unknown` | Timing could not be verified: `_tr_content.html` is missing (the timing engine did not run), the report layout was not recognised, or it lists no clocks at all (nothing constrained). |

`unknown` is never reported as clean. The JSON carries `status` and `reason`; the
text starts with `UNKNOWN — timing not verified: …`.

For CI, `gowin_check` also takes:

- `maxUtilization` — fail when CLS, Logic or BSRAM utilization exceeds this percentage;
- `minFmaxMarginMhz` — fail when any clock achieves less than constraint + this margin;
- `failOnMissingTiming` — default `true`; set `false` to accept an `unknown` build on
  resources alone.

The result's `ok` field is the decision to act on (`status` says what is known,
`ok` says whether to accept the build); `reasons` lists why.

## Example

```
Build: project  (GW5AT-60, GW5AT-LV60PG484AC1/I0)
Tool:  V1.9.11.03 Education
Built: Thu Jul 16 20:58:03 2026   PnR 0h 3m 29s   peak 1848MB

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
FAIL — CLS at 77% exceeds maxUtilization 50%
  threshold utilization CLS at 77% exceeds maxUtilization 50%
  threshold fmaxMargin  clk_eng margin 13.974 MHz is below minFmaxMarginMhz 20 (53.974 vs 40 MHz)
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
| `impl/pnr/<name>.log` | PnR warnings and errors (TA*, PR*, CT* codes) |
| `impl/gwsynthesis/<name>.log` | Synthesis warnings and errors (EX*, NL*, DI*, CV* codes) |

`<name>.tr.html` is only a ~350-byte frameset wrapper — the data is in the
`_tr_content` sibling.

Tables are parsed structurally (`tr`/`td` in HTML, column names in the text tables),
not by position, so a column added between tool versions — the `CFG` column that
appeared in the pinout around V1.9.10 — surfaces as a missing field rather than a
silently misaligned number.

## Scope

This server reads results. It does not run builds.

A GW5A place & route takes minutes, which does not fit an MCP request, and driving
long builds through a tool call hides their output. Keep building with `gw_sh`,
`make`, or the Gowin GUI as you already do — then point this at the results.

## Verified against

The parsers were run over 154 real builds (October 2026) with no parse failures:

| | Verified |
|---|---|
| Tool versions | V1.9.8.10, V1.9.8.11, V1.9.9, V1.9.9 Beta-4, V1.9.9.03, V1.9.10.03, V1.9.11, V1.9.11.01, V1.9.11.02, V1.9.11.03, V1.9.12.02_SP2, V1.9.12.03 (Education and 64-bit editions) |
| Devices | GW1NR-9 (Tang Nano 9K), GW2A-18 (Tang Primer 20K), GW2AR-18 (Tang Nano 20K), GW5A-25 (Tang Primer 25K), GW5AT-60 (Tang Console 60K) |
| Host | Windows 11 |

Known gaps:

- **Only the proprietary Gowin EDA flow.** Output from the open-source chain
  (yosys / nextpnr-himbaechel / apicula) is a different format and is not parsed.
- Only English-language reports.
- Power reports (`*.power.html`) are written by the tool but not read yet.
- The unit tests run on trimmed fixtures from two of those builds (V1.9.12.03 and
  V1.9.9); the full matrix above was exercised manually.

Failures should be visible rather than silent: fields that do not parse come back
absent, timing that cannot be verified comes back `unknown`. If you get a missing or
implausible number, please open an issue with the offending `.rpt.txt` or
`_tr_content.html` attached.

## Notes

- Setup and hold violations are taken from the Total Negative Slack summary rather
  than the path tables, because the path tables are capped by `-max_paths` at report
  time and would under-report a design with many failures.
- An fMax failure is only reported separately when no setup violation already covers
  that clock — otherwise it is the same defect counted twice.
- Recovery and removal paths (asynchronous set/reset checks) are parsed into their own
  arrays and never mixed into the hold table.

## Development

```bash
npm run build      # tsc -> dist/
npm test           # node:test over tests/fixtures (33 tests)
node tests/stdio.mjs <path-to-a-real-build>   # drive the server over stdio
```

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE).

You can use it freely, including at work. If you distribute a modified version, or offer
it to others as a service, you must publish your changes under the same license.

Releases up to and including 0.2.0 were published under the MIT License and remain
available under those terms.
