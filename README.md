# gowin-mcp

An MCP server that turns Gowin EDA build reports into structured data.

Gowin EDA writes everything you need after a place & route — resource usage, achieved
frequency per clock, the exact register-to-register path that failed setup — and then
buries it in a multi-megabyte HTML file nobody opens. This server reads those artifacts
and hands back the numbers.

Built for Sipeed Tang boards (GW1N / GW2A / GW5A) but it only cares about the report
format, so any Gowin EDA project works.

## What it answers

- Did this build close timing, and if not, which path failed and by how much?
- What is the achieved fMax on each clock domain versus its constraint?
- How much of the device am I using — CLS, LUT, ALU, registers, BSRAM, DSP, I/O?
- **What did my last change cost me?** (`gowin_compare` diffs two builds.)

## Install

```bash
git clone https://github.com/Papipapito/gowin-mcp.git
cd gowin-mcp
npm install
npm run build
```

Then register it. For Claude Desktop, in `claude_desktop_config.json`:

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
| `gowin_summary` | Device, resources, fMax and violations in one call. Start here. |
| `gowin_resources` | Full resource tables, including I/O banks and clock resources. |
| `gowin_timing` | fMax per clock, total negative slack, worst setup/hold paths. |
| `gowin_check` | Pass/fail gate — violations only. |
| `gowin_compare` | Diff two builds: resource deltas, fMax deltas, violations introduced/fixed. |
| `gowin_list_builds` | Find every Gowin build under a directory tree. |

Every tool takes `format: "json"` if you want the raw structures instead of text.

Paths are forgiving: pass the project directory, its `impl/` directory, or the
`.rpt.txt` itself.

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

And a comparison between two builds of the same design:

```
Resource changes
  LUT,ALU,ROM16                13361 ->   13450  +89 (+0.67%)
  BSRAM                           33 ->      44  +11 (+33.33%)
  CLS                           8912 ->    8901  -11 (-0.12%)

fMax changes
  clock_54m          50.404 ->    45.284 MHz  -5.12
  clock_audio       411.534 ->     437.8 MHz  +26.266

Violations: 0 introduced, 0 fixed, 1 persisting
  still  setup clock_54m -1.615ns

VERDICT: no regression.
```

## What it reads

| File | Used for |
|---|---|
| `impl/pnr/<name>.rpt.txt` | Device, tool version, resource tables, PnR runtime |
| `impl/pnr/<name>_tr_content.html` | fMax, total negative slack, setup/hold path tables |

`<name>.tr.html` is only a ~350-byte frameset wrapper — the data is in the
`_tr_content` sibling.

Tables are parsed structurally (`tr`/`td`), not by flattening the HTML, so a column
layout change between tool versions surfaces as a missing field rather than a silently
misaligned number.

## Scope

This server reads results. It does not run builds.

A GW5A place & route takes minutes, which does not fit an MCP request, and driving
long builds through a tool call hides their output. Keep building with `gw_sh`,
`make`, or the Gowin GUI as you already do — then point this at the results.

## Notes

- Verified against Gowin EDA V1.9.11.03 Education output for GW5AT-60 and GW2AR-18C.
- Setup and hold violations are taken from the Total Negative Slack summary rather
  than the path tables, because the path tables are capped by `-max_paths` at report
  time and would under-report a design with many failures.
- An fMax failure is only reported separately when no setup violation already covers
  that clock — otherwise it is the same defect counted twice.

## License

MIT
