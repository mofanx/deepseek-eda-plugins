---
description: "The model-facing schematic tools: schematic_generate validates the IR document through the seam gate then emits document source; schematic_validate runs the gate alone."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-eda-sch-gen

English | [中文](README.zh.md)

## Summary

`dsh-plugin-eda-sch-gen` registers the `schematic_generate` and `schematic_validate` tools that models use to produce schematic document source or to check a schematic IR document before committing to it. Load it with `dsh-plugin-eda-sch` and at least one engine plugin (for example `dsh-plugin-eda-easyeda`); generation requires a usable engine, while validation works with the seam alone.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

```yaml
- name: '@deepseek-ai/dsh-plugin-eda-sch'
- name: '@deepseek-ai/dsh-plugin-eda-easyeda'
- name: '@deepseek-ai/dsh-plugin-eda-sch-gen'
```

| Field | Default | Meaning |
|---|---|---|
| `maxPrimitives` | `5000` | Maximum id-carrying primitives across the whole IR document |
| `maxSheets` | `32` | Maximum sheets in the IR document |
| `maxSourceChars` | `1000000` | Maximum chars of emitted document source returned in one result |

### schematic_generate

Takes `document` (the schematic IR as JSON), parses it, enforces the sheet/primitive caps, runs `resolveBindings` to turn `lcsc` declarations into real library bindings when a workspace library is reachable, runs the deterministic layout stage to place and route anything the document left unpositioned, runs the seam's static gate against the laid IR and the prefetched snapshot, and — only when no error finding exists — serializes the bound IR through the resolved engine and returns `{ ok, format, source, sourceBytes, findings }`. A blocked call returns `ok: false` with the findings so the model can repair and retry. A `document` passed as a JSON-encoded string is parsed anyway and flagged `SCHEMATIC_IR_STRING_ENCODED`; a document that cannot parse returns `ok: false` with an `SCHEMATIC_IR_INVALID` finding naming the failing path and the received value. Geometry fields (`position`, pin `endpoint`, wire `dots`) may be omitted: `pin.net` is the connectivity declaration, and the layout stage derives the rest. Pass `verify: true` to additionally deliver through the engine's live path and diff the client read-back netlist: verify findings join `findings`, an error-severity verify finding flips `ok` to `false` while `source` is still returned, and an unreachable client or an engine without live verification degrades to a `SCHEMATIC_VERIFY_UNAVAILABLE` warning. Emitted source above `maxSourceChars` is omitted from the result (`source: ''`, `sourceBytes` reports the full length): with `verify: true` the live delivery already happened so the notice degrades to a `SCHEMATIC_SOURCE_TOO_LARGE` warning, otherwise it is an error and the call suggests `verify: true` or a smaller document.

### schematic_validate

Runs the same parse, caps, binding resolution, layout, and gate without emitting anything, returning `{ ok, findings }`. The same string-encoded `document` tolerance and parse-failure findings apply. Use it to check a document before generation or after a repair loop. Pass `verify: true` to run the live read-back diff after a clean static gate.

<a id="understand-the-implementation"></a>
## Understand the implementation

Both tools report argument-shape violations as `ok: false` `SCHEMATIC_IR_INVALID` findings (via `parseSchematicIr`) and cap violations as thrown `SCHEMATIC_IR_BOUNDS` errors before the gate runs. Engine-resolution errors surface the seam's `SCHEMATIC_ENGINE_*` codes unchanged, so the model sees the same vocabulary as the service. Presenters are generic cards; the model-facing body is the rendered finding list.

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The `tool:schematic` section (order `TOOL_SCHEMATIC`, 2500) renders while either schematic tool is visible in the scope:

##### Schematic tools guidance

```markdown
When the user asks to produce, emit, or check schematic primitives from a schematic IR document, call `schematic_generate` (validate-then-emit) or `schematic_validate` (validate only). Declare connectivity through pin.net names — the layout stage places and routes deterministically in 0.01-inch coordinates, so geometry fields may be omitted; every wire must declare its net name and every pin must carry NAME/NUMBER attributes. Pass verify: true to run the live-client netlist read-back when one is reachable. If either tool reports findings, repair the document and retry.
```

#### Token effect

Fixed paragraph cost while either tool registers; scoped restrictions that hide both tools remove the section.

#### KV Cache effect

Prefix-stable while tool visibility and guidance text are unchanged; mounting or removing the plugin mid-session invalidates reuse from this section on.

### Tool schemas

#### What the model sees

The model sees the generated [`schematic_generate` and `schematic_validate` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-eda-sch-gen). Sheet and primitive caps are deployment settings, not model arguments.

#### Token effect

Fixed schema cost per request while both tools register; config disablement and scoped restrictions remove the schemas and their guidance.

#### KV Cache effect

Prefix-stable while definitions and visibility are unchanged; plugin lifecycle or scoped-restriction changes may invalidate reuse from the first changed schema token.

### Gate findings

#### What the model sees

A blocked call renders `Static validation failed; repair the document and retry:` followed by one `[<severity> <CODE>] at <locator> <message> (<suggestion>)` line per finding. A passing `schematic_validate` renders `Schematic IR is valid.`; a passing `schematic_generate` renders `Emitted <format> document source (<n> chars).` Live verification findings join the same list, and an unreachable engine reports `SCHEMATIC_VERIFY_UNAVAILABLE` as a warning rather than failing the call.

#### Token effect

Finding count is data-dependent and resends until compaction; `maxPrimitives` bounds the document and therefore the finding list.

#### KV Cache effect

Append-only; each new finding line follows the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the tools are incomplete on their own. They are current package constraints.

- **Live verification needs a reachable client** — `verify: true` delivers through the engine's live path and diffs the read-back netlist only when an engine with live verification and a running client are available (today `dsh-plugin-eda-easyeda` plus an EasyEDA Pro client); without one the tools report `SCHEMATIC_VERIFY_UNAVAILABLE` and the result rests on the static gate alone.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Future: repair-in-place loop

A verify-repair loop that feeds gate findings back to the model within one call is deferred; today the model itself drives repair across calls.

</details>
