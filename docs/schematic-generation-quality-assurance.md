# Agent Note: Schematic-generation quality gates and the verify-repair loop

Status: proposed

English | [中文](2026-10-10-schematic-generation-quality-assurance.zh.md)

## Problem

Model-generated EasyEDA schematics fail in ways no caller can see until import: a document can be structurally valid yet electrically wrong — a floating INPUT pin, a net split by a one-character net-name difference, a symbol whose pin numbers have no footprint pads. The V3 source format adds silent failure modes of its own: a `WIRE` without its `NET` attribute, a `PIN` missing `NAME` or `NUMBER`, an `ATTR` whose `parentId` resolves to nothing, and connectivity decided by exact endpoint coincidence that prose generation routinely misses. Without a validation layer between generation and delivery, every one of these reaches the user as a broken import or a wrong circuit, and the model receives nothing it can act on. The capability seam proposed for schematic generation (Service Definition registry, engine provider, model tool) needs a quality story at the same time, not bolted on after.

## Proposal

Validation runs against a typed intermediate representation (IR) — components, pins, nets, wires, placements — never against emitted text. The generator builds IR; a serializer projects IR to SCH_PAGE document source; the validator consumes IR before serialization. This puts checks at the level where the model thinks (nets and pins) and keeps the serializer a pure projection.

Three layers, each with a distinct authority:

1. **Static validator (authoritative gate).** Deterministic rules over the IR, in-process, keyless. Errors block delivery; warnings are reported. Owned by the Service Definition package so every provider engine inherits the same contract.
2. **Verify-repair loop (model-visible).** Findings return as structured tool results — code, severity, message, locator (designator, pin, net), suggested fix — so the model can patch the IR and re-validate. A guard bounds repair iterations; every validation round trip is a session event, per the model-visible ⟺ logged rule in the [testing policy](../../../../docs/testing.md).
3. **Client oracle (advisory only).** Where an EasyEDA bridge is available, import the generated source into a scratch document, run `eda.sch_Drc.check(strict, false, true)` for the client's own ERC detail, and diff `eda.sch_ManufactureData.getNetlistFile()` output against the IR netlist. `SCH_Drc` is documented BETA and explicitly not for production use, so it informs findings and e2e evidence but never gates delivery.

## Generated-artifact validation rules

Four rule families over the IR, each finding carrying a stable code and a locator the model can route back to.

### Pin connectivity

- Build the net graph with union-find over pin endpoints, wire segments sharing an endpoint, explicit junctions, NetFlag symbols (global merge by name), NetPort symbols (cross-page merge by name), and Short symbols (electrical merge of their two pins' nets). Pin endpoint positions derive from the symbol template pin position under the component transform: rotate about origin, mirror across Y if set, translate to placement.
- `FLOATING_INPUT_PIN` (error): an `electric = INPUT` pin on no net.
- `FLOATING_PIN` (warning): an unconnected OUTPUT, BI, or UNKNOWN pin; suppressed when the model marks the pin no-connect.
- `SINGLE_PIN_NET` (warning): a named net driving exactly one pin.
- `AMBIGUOUS_CROSSING` (warning): wires that cross without a junction where a T-connection would join — EasyEDA joins at T-endpoints, not at four-way crossings, and the generated geometry must not rely on ambiguous visual contact.

### Electrical rules

- `NET_MULTI_DRIVER` (error): two or more `OUTPUT` pins on one net, excluding nets whose members are all power/ground class.
- `POWER_SHORT` (error): pins belonging to different declared power names (e.g. `VCC`, `GND`) merged onto one net by a Short symbol or a shared NetFlag.
- `INPUT_NO_DRIVER` (warning): a net whose only members are INPUT pins.
- `ELECTRIC_TYPE_UNKNOWN` (warning): a pin carrying `electric = UNKNOWN` into a checked rule — the generator should resolve symbol electrical types rather than pass through the default.

### Device, symbol, and footprint matching

- `DESIGNATOR_*`: every physical component carries a `Designator` ATTR; designators are unique project-wide and follow the per-kind prefix convention.
- `BINDING_UNRESOLVED` (error when the library is reachable, warning otherwise): the `Device`, `Symbol`, and `Footprint` ATTR bindings on each `COMPONENT` resolve to real library UUIDs in the target workspace.
- `PIN_PAD_MISMATCH` (error): a symbol pin `NUMBER` with no pad in the bound footprint under the device's pin-pad mapping — the mismatch that silently drops connections at PCB transfer.
- `MULTI_PART_INCONSISTENT` (error): parts of one multi-part `COMPONENT` disagreeing on device binding or designator.
- Flag coherence: `addIntoBom`/`addIntoPcb` consistent with a bound footprint; a NoneElec symbol must not carry PCB intent.

### Net naming and format invariants

- `NET_NAME_*`: net names match the declared grammar — non-empty, no leading or trailing whitespace, restricted charset, a documented case-folding policy applied uniformly. Bus names such as `A[1:5]` must be well-formed and every `BUSENTRY` order index must map to a real branch of the bus expansion.
- `WIRE_MISSING_NET` (error): a `WIRE` or `BUS` without its `NET` ATTR, or whose `NET` value disagrees with the NetFlag naming the same graph component.
- `PIN_ATTR_MISSING` (error): a `PIN` without `NAME` or `NUMBER`.
- `ORPHAN_ATTR` (error): an `ATTR` whose `parentId` resolves to no live primitive, including pin-override ATTRs whose composite parent (`component-id` + `pin-id`) must resolve.
- `FORMAT_*`: unique `id` per `type` within the document, monotonic `ticket`, `groupId` never `0` when present, no deletion records (`""` inner data, `DELETE_DOC`) in fresh output, coordinates in `0.01 inch` units.

## Testing strategy

- **Unit** (`pnpm run test`): one minimal IR fixture per rule, positive and negative; the union-find resolver covers buses, Short symbols, NetFlag merge, and multi-page NetPort joins; serializer goldens pin exact emitted lines for each primitive kind; a parse–serialize round-trip proves the importer recovers IR from its own output.
- **Coverage**: per-file 100% on the new `src` trees under `test:coverage`.
- **Loader and HMR safety**: the no-default-export plus `unwrapExports` round-trip guard from [postmortem 0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md) for every function plugin; each registry contribution gets a dispose-and-observe-removal test.
- **Real composition**: a test-only `cordis.yml` boots seam, provider, consumer, and guard through the Loader and drives `ctx.tools.execute()`; only the bridge boundary is stubbed.
- **Owner-local expected output**: golden document-source files and expected-findings tables live in the owning package's `tests/expected/`, not `snapshots/` — they are not session-driven, per [snapshot ownership](../../../../snapshots/AGENTS.md).
- **Snapshot**: a keyless recorded session under `snapshots/session/` replays a generate → validate → repair → pass transcript; findings reach the model as tool results, so the session fixture pins them verbatim, and a failing-rule fixture pins the repair path.
- **Real-API e2e**: a `DEEPSEEK_API_KEY`-gated suite prompts for a small real circuit and asserts the loop engages and the delivered artifact passes static validation. A separately env-gated suite runs the live bridge oracle — import, `SCH_Drc`, netlist diff — against a running EasyEDA client; it self-skips without a bridge.

## Delivery milestones

- **M1 — IR, serializer, validator core.** Typed IR, IR→SCH_PAGE projection, format-invariant and connectivity rules, unit suite. No tool surface yet.
- **M2 — Tool seam and verify-repair loop.** The model tool returns structured findings; the guard bounds repair rounds; real-composition test and the recorded snapshot land in the same change.
- **M3 — Library resolution.** Device/symbol/footprint binding checks against the real workspace library, pin-pad mapping validation, the unreachable-library warning degradation, real-API e2e.
- **M4 — Client oracle.** Bridge-mediated import, `SCH_Drc` collection, and netlist diff feeding advisory findings; env-gated live test.

## Progress evidence

- **M1–M4 delivered.** 16 test files / 289 tests; scoped `test:coverage` at 100% statements/branches/functions/lines on `packages/schematic/*/src`; `tsc -b`, `oxlint`, and `verify-export-jsdoc` clean; `pnpm run test:docs` doc-quick 21/21; the headless `schematic-tools` expected e2e replays the generate → findings → repair → emit transcript.
- **M4 netlist diff wired.** `engine.verify(ir)` parses the client's document source back into geometric net regions and diffs them against the IR net graph — `SCHEMATIC_NETLIST_DROPPED`, `SCHEMATIC_NETLIST_WRONG_NET`, and `SCHEMATIC_NETLIST_MERGED` findings return through `verify: true` on both tools so the model can repair; an unreachable engine degrades to a `SCHEMATIC_VERIFY_UNAVAILABLE` warning, and an error-severity diff flips `ok` while the emitted source still returns.
- **Live closed loop (EasyEDA 4.1.71 Web client).** A two-sheet IR with live `C25804` LCSC bindings ran parse → resolve → layout → validate → `importProject` → read-back. The defective document returned `FLOATING_PIN` warnings plus a `BINDING_UNRESOLVED` error; the repaired document passed the gate with warnings only; the import produced project `96e67c786e294795942e9a795636895f` with pages `f7f2add3db984015b3610b57b19f4803`/`99e4a220f36a472eb61285e39f58ba18`, `findings: []`, read-back `P1 {COMPONENT:6, ATTR:17, WIRE:3, LINE:4}` / `P2 {COMPONENT:2, ATTR:3}`.
- **Env-gated live suite.** `tests/live-e2e.spec.ts` in `dsh-schematic-easyeda` probes bridge discovery at module load and self-skips without a running client; when reachable it drives live `resolveByLcsc` binding plus the full `resolveBindings → layout → validate → importIntoEasyEda` chain through a real `Context` composition.
- **Defects found by live validation.** The gate caught a generated trunk wire merging `GND` and `SIG` at a foreign pin endpoint and a flag-stub wire missing its `NET` attribute; routing now checks foreign-occupied points and falls back to flag routing, generated stub wires carry `net`, lone ground nets route through flags, LCSC association fields normalize empty strings to absent, and import read-back waits for the document tree to attach.

## Alternatives considered

**No pre-validation — let EasyEDA's importer reject bad output.** Import failure surfaces as an opaque error or silent misreading (an unrecognized ATTR, a wire that connects nothing), and the model learns nothing actionable. Validation exists to convert those into located, named defects before delivery.

**Prompt-level self-review instead of deterministic checks.** Asking the model to check its own output is the self-report pattern the testing policy rejects — the same probabilistic process that produced the defect reviews it. Deterministic rules over the IR are the oracle; the model consumes their findings.

**Validate emitted document source text instead of IR.** Line-level validation duplicates the serializer's projection logic and forces every rule to re-derive semantics from raw coordinates and ATTR wiring. Validating IR checks intent; the serializer round-trip separately proves projection fidelity.

**Gate on `eda.sch_Drc.check` as the authoritative check.** The client DRC is marked BETA with an explicit do-not-use-in-production warning, and it requires a running EasyEDA client that CI and headless sessions do not have. It stays advisory evidence; the deterministic validator owns the gate.

**Full PCB-grade ERC on day one.** The initial ruleset targets the failures generation actually produces — connectivity, naming, binding, format. The registry structure lets new rules land independently as observed model failures justify them, rather than front-loading an untested rule matrix.

## Acceptance criteria

- No artifact reaches the user without passing the static validator; every finding carries a stable code, severity, locator, and actionable message.
- Each rule has positive and negative unit coverage; `test:coverage` passes on the new packages; every registry contribution proves disposal.
- The verify-repair loop appears in a committed recorded-session snapshot, including at least one repair round.
- The env-gated bridge suite demonstrates netlist parity between the IR's net graph and the client's own netlist extraction, or reports the divergence as an advisory finding.

## Risks

- **Endpoint-coincidence semantics are only partially documented.** Junction-versus-crossing and wire-endpoint rules must be verified against live client behavior; the bridge netlist diff is the arbiter when the static model and EasyEDA disagree, and mismatches file as validator bugs, not user-facing errors.
- **`SCH_Drc` is BETA.** Its result shape may change and it is explicitly not production-supported; all oracle consumption wraps behind an adapter so a changed detail-result format degrades to "oracle unavailable," never a crash.
- **Format documentation is incomplete.** The V3 reference is a partial snapshot and the V2.2 archive is dated; the serializer is version-gated and golden fixtures stay small enough to re-derive when the format reference updates.
- **Workspace library contents vary per user.** Binding resolution must degrade to warnings when a device UUID cannot be resolved offline, or the validator would hard-fail every generation on a missing personal library.
- **Repair loops can spin.** The iteration bound and a "still failing after N rounds" structured report are part of the contract, not an afterthought.
