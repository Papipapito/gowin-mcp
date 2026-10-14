# Test fixtures

Trimmed and anonymised slices of real Gowin EDA output. Paths, project and
module names were rewritten; the numbers and table layouts are verbatim.

| Fixture | Source | Exercises |
|---|---|---|
| `demo/impl/pnr/demo.rpt.txt` | V1.9.12.03, GW2AR-18 | `Tool Version` header, CFG column in sections 7/8 |
| `demo/impl/pnr/demo_tr_content.html` | same build | fMax, TNS, setup/hold/recovery/removal tables (3 rows each), "no timing paths" |
| `demo/impl/pnr/demo.fs`, `stale.fs` | header of the same build's `.fs`, synthetic 6-line body | bitstream header fields; the two bodies are identical and only `Created Time` differs |
| `demo/impl/pnr/stale.rpt.txt` | copy of the above, no timing HTML | second build in the same `pnr/`; mtime is set by the tests |
| `demo/impl/pnr/demo.log`, `demo/impl/gwsynthesis/demo.log` | same build | TA1132 / TA1117 / PR1014 and synthesis warnings, plus one injected CT1135 error |
| `failing/impl/pnr/fail_tr_content.html` | `demo` HTML with one setup TNS row driven negative, the matching path given negative slack and its fMax lowered | violations, fMax failing |
| `legacy/impl/pnr/legacy.rpt.txt` | V1.9.9 Beta-4 Education, GW2AR-18 | `PnR Version` header, no CFG column, no timing HTML, utilization inside the usage cell |
| `xdomain/impl/pnr/xdomain_tr_content.html` | V1.9.11.03 Education, GW2AR-18 (CRLF, as written) | every TNS row 0.000 and no failing fMax, yet 14 negative setup paths `clock_54m -> clock_27m` and 6 negative hold paths between the video and 108 MHz clocks: slack Gowin's TNS does not count |
| `xdomain/impl/pnr/xdomain.rpt.txt` | copy of `demo.rpt.txt` with the name and paths changed | pairs the HTML above with a resource report so the build resolves |
| `fmaxonly/impl/pnr/fmaxonly.rpt.txt` | V1.9.12.03, GW5AT-60 (Tang Console 60K) | CLS 29142/29952 = 97.30 % reported as 98 %, BSRAM 118/118, GW5A-only pinout columns |
| `fmaxonly/impl/pnr/fmaxonly_tr_content.html` | same build | `clk_54m` at 32.455 MHz against 53.996 with a setup TNS of 0.000; the two half-cycle (`:[F]` → `:[R]`) setup rows of that clock are kept beside the three worst; the failing fMax cell carries the tool's `class="error"` styling |
| `fmaxonly/constraints/fmaxonly.sdc` | the build's combined .sdc, cut to the clocks, clock groups, six `set_multicycle_path` on `clk_54m`, two `set_false_path`, comments in `#` and `//` style (one containing a `set_false_path`) | found by file name under the project when the reported path is gone |
| `fmaxonly/impl/pnr/fmaxonly.fs` | header of the real `.fs` (GW5AT-60, CheckSum 0xDE97), synthetic body | a bitstream of another device, body differing from `demo.fs` |
| `trtext/impl/pnr/trtext.rpt.txt` | V1.9.12.04, GW2AR-18 | the first release that writes `<name>.tr` on every run |
| `trtext/impl/pnr/trtext.tr` | same build, cut after the four path tables (3 rows each), columns re-aligned after renaming | the plain-text timing report as the only timing source (no `_tr_content.html`); empty Source/Master cells in the Clock Summary |
| `trtext/impl/pnr/trtext.fs` | header of the real `.fs` (V1.9.12.04), synthetic body | — |

Regenerate with the scripts kept outside the repo (`mkfixtures.py` for demo /
failing / legacy, `mkfixtures2.py` for fmaxonly / trtext / the `.fs` stubs);
they need the original builds, which are not published.
