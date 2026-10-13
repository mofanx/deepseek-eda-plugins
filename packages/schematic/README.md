---
description: "The schematic seam service (ctx.schematic): a typed schematic IR, an engine registry with order-independent selection, and the authoritative static validator every engine inherits."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-eda-sch

English | [中文](README.zh.md)

## Summary

Use `dsh-plugin-eda-sch` to represent a schematic design as a typed intermediate representation (IR) and to run the deterministic delivery gate before any document source is emitted. It selects one registered serialization engine per call and gives callers a consistent validation-finding vocabulary. Choose it when a plugin or tool produces or checks schematic content; the shipped `dsh-plugin-eda-sch-gen` tools load it for you.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

A composition that needs schematic generation loads the `dsh-plugin-eda-sch` service and at least one engine plugin; callers then pass typed IR to `ctx.schematic.validate()` and obtain the resolved engine with `ctx.schematic.engine()`. The service resolves the engine at call time, so callers never see engine ids unless they configured one.

### Minimal configuration

Load the service and let a single mounted engine auto-select, or pin an engine id with `engine`. `$DSH_SCHEMATIC_ENGINE` feeds the same field and is not a separate priority chain.

```yaml
- name: '@deepseek-ai/dsh-plugin-eda-sch'
- name: '@deepseek-ai/dsh-plugin-eda-easyeda'
```

| Field | Default | Meaning |
|---|---|---|
| `engine` | (unset) | Pinned engine id; unset auto-selects when exactly one is usable |
| `layout` | `auto` | `auto` runs the deterministic layout stage; `off` makes `layout()` a pass-through |
| `requireLibrary` | `false` | Escalate `BINDING_UNRESOLVED` to an error when no registered library answers; `false` keeps the unreachable-library warning degradation |

### Deterministic layout

`layout(ir, options)` fills the geometry a logical document leaves out. When a sheet declares functional modules (`blocks` on the sheet plus `block` on each component), components cluster by module and the module cells pack row-major into a deterministic grid — declared blocks in declaration order, undeclared names alphabetically, ungrouped members last, `moduleColumns` cells per row. Each module then lays out internally with the same signal-flow columns used for a flat sheet (drivers left, loads right; `netflag`/`netport`/`nonelec` symbols stack in the annotation margin), pin endpoints sit on the pin's electrical side, and net routing picks an orthogonal wire trunk or net flags — power nets hang flags upward, grounds hang them downward, and high-fanout, cross-sheet, or cross-module nets use flags or ports instead of long wires. A sheet with no module membership degenerates to one group, the flat pre-module layout. Explicit geometry (positions, pin endpoints, wire polylines) passes through untouched, so the pass is idempotent and `pin.net` stays the connectivity declaration until geometry exists. `layoutSchematic` is the same pass as a pure function; `SchematicLayoutOptions` tunes grid, margin, column pitch, pin pitch/stub, the flag-fanout threshold, and the module-grid column count. Component outlines size from declared pin counts — the EasyEDA library APIs expose no symbol geometry, so resolved parts reuse the same sizing.

### Validating and emitting

`validate(ir, options)` runs the static gate over a typed IR document and returns `{ ok, findings }`; `ok` is false when any `error`-severity finding exists. Findings carry a stable `code`, a `severity`, a `locator`, and an actionable `suggestion`. `options.libraryResolver` supplies workspace-library lookups for the binding family; `options.requireLibrary` overrides the configured gate per call; `options.disabledRules` suppresses named codes. `engine()` resolves the selected engine, whose `serialize(ir)` projects the IR to document source.

`await resolveBindings(ir)` is the async step ahead of validation: it turns resolvable `lcsc` declarations into real UUID bindings through the registered libraries (declared UUIDs always win) and prefetches every declared UUID into the synchronous `libraryResolver` snapshot the validator consumes. It returns `{ ir, libraryResolver }`; the resolver is `undefined` when no library answered, which is the unreachable-library degradation, not a definitive miss. Serialize the returned IR — it is the one carrying resolved bindings.

### Engine and library registration

Engine plugins call `ctx.schematic.registerEngine(engine)`. The call rejects duplicate ids with `SCHEMATIC_DUPLICATE_ENGINE` and returns a disposer; the registration unwinds with the contributing fiber. Engine resolution never depends on registration order: a configured id must be registered and `available()`, or exactly one usable engine must be registered. Failures throw `SchematicError` with `SCHEMATIC_ENGINE_CONFIGURED_MISSING`, `SCHEMATIC_ENGINE_CONFIGURED_UNAVAILABLE`, `SCHEMATIC_ENGINE_AMBIGUOUS`, or `SCHEMATIC_ENGINE_UNAVAILABLE`.

Workspace-library providers call `ctx.schematic.registerLibrary(library)` — a `SCHEMATIC_DUPLICATE_LIBRARY` failure on duplicate ids, same effect/disposer contract. `resolveBindings` queries libraries in insertion order and takes the first answered (non-throwing) result; a throwing library counts as unreachable for that lookup, never as a definitive miss, and lookups that fail mid-run surface through the `SCHEMATIC_LOOKUP_FAILED` sentinel as unverifiable warnings.

<a id="understand-the-implementation"></a>
## Understand the implementation

### The IR

`SchematicIr` holds ordered sheets of components, pins, wires, bus entries, junctions, and generic attributes. Coordinates are `0.01 inch` sheet units — never mil or millimetre values. A sheet may carry a `name` (serializers write it into the page title record, falling back to `P<n>`) and a `blocks` list declaring functional modules as `{ name, title? }` in display order; a component's optional `block` binds it to one module name for layout clustering. A `kind: 'block'` component is a hierarchy element: its `sheetIndex` names the child sheet it expands into, or — absent the index — validation binds the unique other sheet whose `name` matches the block's `designator`, `netName`, or `id`; the block's pin `net` names are the interface the child's `netport` components must echo, and cross-sheet nets route through `netport`s. Components carry a `kind` discriminant (`part`, `block`, `netflag`, `netport`, `sheet`, `nonelec`, `short`) plus optional `deviceUuid`/`symbolUuid`/`footprintUuid` bindings, an `lcsc` part number a library may resolve into those bindings, a `designator`, and named pin endpoints in sheet space so the validator never re-derives placement. Geometry fields (`position`, pin `endpoint`, wire `dots`, junction `point`) are optional on input — a logical document declares connectivity through `pin.net` and the layout stage derives the geometry; a fully laid-out IR needs no `net` to stay connected.

### The gate

`validateSchematic` computes connectivity with a union-find over pin endpoints, wire polylines, T-taps, named netflags/netports, and short symbols, then applies four rule families: pin connectivity (floating pins, crossing ambiguity, naming conflicts on one net), electrical sanity (multiple drivers, input-only nets, power shorts), device/symbol/footprint binding (designators, library resolution, pin-pad matching, multi-part consistency, BOM/PCB intent), and net-naming plus format invariants (net grammar, bus expansion, ids, group ids, orphan attributes). A hierarchy family guards block-to-sheet bindings: `HIERARCHY_BAD_SHEET_INDEX`, `HIERARCHY_UNRESOLVED_BLOCK`, `HIERARCHY_AMBIGUOUS_BLOCK`, and `HIERARCHY_CYCLE` are errors; `HIERARCHY_INTERFACE_MISMATCH` (pin nets without same-named `netport`s on the child, or child ports no block pin exposes) and `HIERARCHY_INDEX_ON_NON_BLOCK` are warnings. One advisory rule sits outside the families: `SCHEMATIC_LAYOUT_MONOLITHIC` warns when a sheet places more than `monolithicThreshold` parts (default 20) with zero module membership, nudging the producer toward `blocks` declarations or a sheet split. `parseSchematicIr` is the model/JSON boundary that turns raw `document` arguments into the typed IR or throws `SCHEMATIC_IR_INVALID`.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-plugin-eda-sch-gen`, which renders the gate's findings and emitted source to the model while this service contributes no prompt or schema.

#### KV Cache effect

No direct invalidation; the tool package owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the service is incomplete on its own. They are current package constraints.

- **No hierarchy expansion** — `block` components bind child sheets for validation, layout, and naming, but nothing expands a block into its child's primitives; a consumer needing a flattened view composes the sheets itself.
- **Module frames are not drawn** — `blocks` affect placement, flag routing, and the page title record only; a visible partition frame with a title label is deferred to the serializer that owns drawing primitives.
- **No live-EDA readback** — the gate is deliberately in-process and keyless; engine-specific readback (for example an EasyEDA client's own import check) belongs in the engine package.
- **Pad lists depend on the library** — `PIN_PAD_MISMATCH` runs only when the resolved footprint carries a `pads` list; the EasyEDA BETA footprint API does not expose pads, so EasyEDA-resolved footprints verify existence only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Open: engine-supplied validation options

`resolveBindings` supplies the prefetched snapshot the binding family needs, and `dsh-plugin-eda-sch-gen` already runs it before the gate. A consumer that validates without the async step sees the unreachable-library degradation (or the `requireLibrary` gate) rather than verified bindings.

</details>
