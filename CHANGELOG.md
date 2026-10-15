# Changelog

## 0.2.2 — 15 October 2026

Fixes found on 14 October 2026 running 0.2.1 over real builds (Gowin
V1.9.12.03 and V1.9.12.04 on a GW2AR-18, and a GW5AT-60 build with multicycle
constraints).

### Fixed

- **fMax-only violations can be waived and explain themselves.** A clock whose
  fMax misses its constraint while its setup TNS is 0 (how Gowin reports a
  clock covered by `set_multicycle_path` or half-cycle paths) failed
  `gowin_check` with no way out and a detail that only said "check the
  constraint covers this domain". `gowin_check` now takes `fmaxWaivers`
  (clock names or globs); the waived violation is listed under
  `ignoredViolations` with a note, a TNS violation on the same clock is never
  waived, and a waiver that names no clock of the report is pointed out. The
  detail now quotes the clock's setup TNS, how many `set_multicycle_path` /
  `set_false_path` commands in the `.sdc` name the clock, and how many of its
  reported setup paths are half-cycle (`:[F]` → `:[R]`) relations. The `.sdc`
  is the one the report names, or a copy found by file name under the project.
- **`gowin_timing` trims the JSON too.** `maxPaths` only cut the text; the
  JSON always carried every parsed path (about 27 KB). It now applies to both,
  with `paths: "worst" | "all" | "none"` to choose, a `paths` object saying what
  was parsed and kept, and `worstSetup` / `worstHold` kept whatever the trim.
  The path tables come out of the parser sorted worst slack first.
- **`format: "text"` returns the text.** Every tool declared an
  `outputSchema`, which obliges the server to return `structuredContent`
  (SDK 1.30 enforces it), and clients that understand structured content
  showed that JSON instead of the compact rendering. The output schemas are
  no longer published; `structuredContent` is attached only with
  `format: "json"`, where the text is the same JSON. The zod output schemas
  stay in `schemas.ts` as the documented contract the tests hold the JSON to.
- **`siblings` and `note` in the JSON.** When one `impl/pnr/` holds several
  builds and none was named, only the text said which one was chosen. Every
  per-build tool's JSON now carries `siblings` and `note`; `gowin_compare`
  carries them per side.
- **Paths to the report.** A `.rpt.txt` path with forward slashes (or
  different case on Windows) was not found; `name` was ignored when a
  `.rpt.txt` was given instead of raising the promised error; `impl/pnr/`
  itself was not accepted. All three fixed.
- **`gowin_compare` across devices.** Comparing builds on different devices
  returned `safe: true` and classified violations of one design as "fixed" in
  the other. Now `comparable: false`, `safe: null`, violations unclassified
  and counted per side in the notes. The doc of `safe` matches the code: no
  new violation and no clock going from meeting to missing its constraint (a
  slower clock that still passes is not a regression).
- **Apostrophes in warning patterns.** `Can't calculate clocks' relationship`
  (TA1117, CK3000) was collapsed to `CanX relationship between: X and X`, and
  EX0200's `32'b…` literal inside a quoted name cut the pattern short. A
  single quote now only opens a string at the start or after whitespace or
  punctuation.
- **`gowin_pins` with `port` and `includeUnused`.** The package-pin list
  ignored the port filter when `includeUnused` was set. Used pins are now
  filtered by their signal and free pins kept, in both renderings.
- **Log fixtures were never committed.** `.gitignore` excluded `*.log`, so
  `tests/fixtures/demo/impl/pnr/demo.log` and
  `tests/fixtures/demo/impl/gwsynthesis/demo.log` only existed on the
  machine that made them and a clean clone failed the two warnings tests.
  Fixture logs are now exempt from the rule and tracked.

### Added

- **Bitstream header.** `gowin_summary` reads `impl/pnr/<name>.fs`: tool
  version, device, part, package, CheckSum, UserCode, Created Time, and a
  SHA-256 of the body with the `//` header left out, so two builds compare
  equal when they program the device identically. `gowin_compare` reports it
  per side and as `sameBitstream`.
- **Plain-text timing report.** When `_tr_content.html` is missing,
  `<name>.tr` (written on every run by V1.9.12.04) is parsed instead:
  same tables, cells sliced by the `====` rule so empty cells keep their
  column. `timing.format` says which file was read. Checked against three
  real builds: identical to the HTML except that Gowin rounds fMax to the
  third decimal differently in the two files (0.001 MHz).
- **Exact utilization.** `ResourceRow.utilizationPct` is `used/available`
  with two decimals next to the tool's rounded `utilization` ("98%" for
  97.30). `maxUtilization` gates on the exact value and quotes the rounded one
  when they differ; it also works on V1.9.9 reports, whose percentage sits
  inside the usage cell.
- `TimingPath.fromEdge` / `toEdge` from the `clk:[R]` / `clk:[F]` suffixes.
- `gowin_summary` carries `constraints`: the `.sdc` that was read and how
  many clocks, multicycle, false-path and clock-group commands it declares.
  A report header of `---` (a build placed without a `.cst` or `.sdc`, 119
  of 167 local builds) means "none", not a file called `---`: `sdcFile` and
  `constraintsFile` come back absent and the fMax detail says so.
- `.fs` files written by releases up to V1.9.9 carry the version under
  `//GOWIN Version:`; it lands in `bitstream.toolVersion` too.

### Verified

The 0.2.2 parsers were run over every local build (167: the 154 of the
earlier matrix plus 13 campaign builds, V1.9.8.10 to V1.9.12.03, five
devices): no exception, and the same 82 pass / 81 fail / 4 unknown and the
same violations as 0.2.1. The 11 fMax-only violations all have `.sdc`
evidence. Reading a 20.8 MB `.fs` costs about 24 ms. No local build pairs a
`.tr` with the HTML of the same run, so the `.tr` fallback is covered by the
three MoonTANG builds compared by hand and by the `trtext` fixture.

### Fixtures and tests

- `tests/fixtures/fmaxonly`: a trimmed V1.9.12.03 GW5AT-60 build (report,
  timing HTML with the two half-cycle rows, `.sdc`, `.fs`).
- `tests/fixtures/trtext`: a trimmed V1.9.12.04 build whose timing exists
  only as `<name>.tr`.
- `demo.fs` / `stale.fs` with the same body and different Created Time.
- 62 tests (was 38), including a check of every tool's JSON against the zod
  schemas with no undeclared field.

## 0.2.1 — 14 October 2026

- Negative paths between clock domains, which Gowin leaves out of the TNS
  summary, are now violations (`source: "paths"`), with `ignoreCrossDomain`
  for designs that declare those crossings as false paths. Fixture `xdomain`.

## 0.2.0 — 14 October 2026

- README, package metadata, version read from `package.json`; fixtures marked
  `-text`. Relicensed to AGPL-3.0-or-later (0.2.0 and earlier remain MIT).

## 0.1.x

- Initial tools: summary, resources, timing, check, compare, pins, warnings,
  list_builds, over node:test suites on anonymised fixtures.
