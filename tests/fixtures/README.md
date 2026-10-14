# Test fixtures

Trimmed and anonymised slices of real Gowin EDA output. Paths, project and
module names were rewritten; the numbers and table layouts are verbatim.

| Fixture | Source | Exercises |
|---|---|---|
| `demo/impl/pnr/demo.rpt.txt` | V1.9.12.03, GW2AR-18 | `Tool Version` header, CFG column in sections 7/8 |
| `demo/impl/pnr/demo_tr_content.html` | same build | fMax, TNS, setup/hold/recovery/removal tables (3 rows each), "no timing paths" |
| `demo/impl/pnr/stale.rpt.txt` | copy of the above, no timing HTML | second build in the same `pnr/`; mtime is set by the tests |
| `demo/impl/pnr/demo.log`, `demo/impl/gwsynthesis/demo.log` | same build | TA1132 / TA1117 / PR1014 and synthesis warnings, plus one injected CT1135 error |
| `failing/impl/pnr/fail_tr_content.html` | `demo` HTML with one setup TNS row driven negative, the matching path given negative slack and its fMax lowered | violations, fMax failing |
| `legacy/impl/pnr/legacy.rpt.txt` | V1.9.9 Beta-4 Education, GW2AR-18 | `PnR Version` header, no CFG column, no timing HTML |

Regenerate with the script kept outside the repo (`mkfixtures.py`); it needs the
original builds, which are not published.
