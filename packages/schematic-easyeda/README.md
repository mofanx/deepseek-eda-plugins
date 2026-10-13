---
description: "The EasyEDA document-source engine plugin: projects the schematic IR to EasyEDA V3 SCH_PAGE document source text through the ctx.schematic registry."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-eda-easyeda

English | [中文](README.zh.md)

## Summary

`dsh-plugin-eda-easyeda` is the engine plugin that serializes validated schematic IR into EasyEDA V3 document source (`SCH_PAGE` log records) in the client's persisted schema. Load it alongside `dsh-plugin-eda-sch` when the composition must emit EasyEDA-importable source; the plugin registers itself as engine id `easyeda`. Beyond serialization it can deliver the IR into a running EasyEDA client through the run-api-gateway bridge: primitive-by-primitive onto a freshly created page (`engine.build`), or as a new project imported from a generated `.epro2` package (`engine.importProject`).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Load the plugin next to the seam service; it registers the `easyeda` engine and the `easyeda` workspace library at mount time and unregisters both on fiber disposal.

```yaml
- name: '@deepseek-ai/dsh-plugin-eda-sch'
- name: '@deepseek-ai/dsh-plugin-eda-easyeda'
```

| Field | Default | Meaning |
|---|---|---|
| `clientId` | `dsh` | Eventual-consistency client tag written into each emitted `DOCHEAD` |
| `bridgeHost` | `127.0.0.1` | Host the run-api-gateway bridge is probed on |
| `bridgeTimeoutMs` | `30000` | Per-request timeout for bridge calls |
| `bridgeQueryTimeoutMs` | `10000` | Per-request timeout for `lib_*` read calls; defaults to `bridgeTimeoutMs` |
| `bridgeTimeoutStreakLimit` | `3` | Consecutive bridge timeouts that open the fail-fast circuit |
| `bridgeCircuitCooldownMs` | `15000` | Cooldown before a half-open probe retries the client |
| `advisoryDrc` | `true` | Collect the BETA `sch_Drc` detail as advisory findings after a build |
| `libraryUuid` | (unset) | Workspace library UUID restricting every library lookup; unset uses the client's default scope |

The emitted text is EasyEDA document source: one `DOCHEAD`-headed log document per IR sheet, followed by `CANVAS`, `COMPONENT`/`ATTR`, `WIRE`/`BUS` plus their `LINE` segments, and sheet `ATTR` records, each a `||`-joined pair of JSON objects per line. `serializeEasyEdaProject` additionally wraps the sheets with the `CONFIG` and `SCH` documents needed for an `importProjectByProjectFile` `.epro2` import.

The live build/import paths need the run-api-gateway bridge server between this package and the running EasyEDA client. The package ships it as the `dsh-eda-bridge` bin — `npx dsh-eda-bridge` (or `node bin/dsh-eda-bridge.mjs` inside the package) starts a localhost relay that binds the first free port in 49620–49629, serves `GET /health` (`{service:"easyeda-bridge", bridge:"dsh-eda-bridge", edaConnected…}`) and `POST /execute`, and accepts the extension's WebSocket registration on `/eda` plus agent connections on `/agent` with a `{type:"handshake", service:"easyeda-bridge"}` first frame. A second invocation exits when a compatible bridge already answers; a foreign implementation holding the service id (an incompatible protocol marked by a different `bridge` health field) fails startup unless `--force` is passed. The EasyEDA client side needs the `run-api-gateway` extension installed and loaded — it discovers the bridge by scanning the same port range.

`scripts/live-verify.mjs` verifies the whole live path without a test runner: bridge discovery, a real `lib_Device` LCSC lookup, `resolveSymbolPins`, and a one-component `.epro2` import whose read-back is diffed against the IR (`--check-defect` injects a pin offset and requires `WIRE_NOT_ON_PIN`).

```sh
node node_modules/@deepseek-ai/dsh-plugin-eda-easyeda/scripts/live-verify.mjs [--lcsc C25804] [--name <project>] [--check-defect]
```

<a id="understand-the-implementation"></a>
## Understand the implementation

The serializer (`src/serialize.ts`) is a pure projection emitting the persisted 4.1.x schema: `x`/`y` keys with the Y axis negated against the `SCH_*` API, `attrs` on `COMPONENT`, wire geometry in sibling `LINE` records bound by `lineGroup`, and page-to-schematic binding through the page `META` record. Components emit their binding `ATTR` rows (`Device`, `Symbol`, `Footprint`, `Designator`) and every wire emits a `NET` `ATTR` naming its graph component; sheet pins are symbol data and are not emitted. It never validates — the seam gate runs first — and never invents library references: the IR must already carry resolvable `deviceUuid`/`symbolUuid`/`footprintUuid` values.

Two delivery paths build on the projection. `buildIntoEasyEda`/`engine.build` creates a fresh page per sheet inside the open project, activates and identity-checks it before placing primitives — parts go one bridge execution each, flags/wires in bounded batches, with position-keyed retries and a read-back plus client-oracle (counts, net names, `sch_Drc`) verification pass — and never writes into whatever document happens to be open. `importIntoEasyEda`/`engine.importProject` packages `serializeEasyEdaProject` output as a store-method zip (`project2.json` plus one `*.epru` log) and hands it to the BETA `sys_FileManager.importProjectByProjectFile`, auto-suffixing the project name when a same-named project exists. The archive embeds project-local copies of every referenced `DEVICE`/`SYMBOL`/`FOOTPRINT` document — fetched live through the bridge by `collectProjectLibrary` — and rewrites component `ATTR` values to the local uuids, which the client requires to render component graphics; a failed fetch degrades to an unresolved box reported as `SCHEMATIC_IMPORT_LIBDOC`. `netflag`/`netport` components bind name-searched flag devices (`Ground-GND`, `Power-<net>`, `Netport`) through the same pipeline; `short`/`nonelec` kinds carry no symbol binding and stay unresolved. Opening the imported project may require closing the current project's document tabs; that fallback mutates the user's editor layout and runs only under the explicit `allowTabClose` option, otherwise `SCHEMATIC_IMPORT_OPEN_FAILED` reports the blocking tab count. Successful imports re-open only the pages the archive emitted and diff the read-back source against the IR's names and nets.

The plugin also registers `EasyEdaLibrary` (`src/library.ts`), the workspace-library adapter behind `ctx.schematic.registerLibrary`. Lookups run inside the running client's extension runtime through the run-api-gateway bridge: `resolveByLcsc` resolves an LCSC part number under the system library scope (or the configured `libraryUuid` when set) via `lib_Device.getByLcscIds` with a `lib_Device.search` fallback, then verifies the device's symbol/footprint associations are loadable in their owning scopes before emitting them. `resolveDevice`/`resolveSymbol`/`resolveFootprint` verify declared UUIDs through `lib_Device.get`/`lib_Symbol.get`/`lib_Footprint.get` — a symbol or footprint lookup without a library scope resolves only the client's default scope and is reported as unverifiable rather than a false miss — and `resolveSymbolPins` reads a bound symbol's pin geometry from its library document source (`lib_Symbol.getDocumentSource`, undocumented but live-verified) for the layout stage's real-endpoint placement. All of these are BETA APIs, so the adapter isolates them: a missing client or a drifted payload surfaces as an unreachable or missed lookup, never as a crash inside the gate.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-plugin-eda-sch-gen`: this plugin registers engine `easyeda` and emits no model-visible text itself; the model sees the source via the tool output.

#### KV Cache effect

No direct invalidation; the tool package owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is incomplete on its own. They are current package constraints.

- **No pad lists from the library API** — `lib_Footprint.get` exposes no pad enumeration, so EasyEDA-resolved footprints verify existence only and `PIN_PAD_MISMATCH` does not run for them.
- **Beta API surface** — the library adapter and the live build/import paths rely on EasyEDA beta interfaces whose semantics may change; the seam treats them as adapter internals so drift degrades to lookup failures rather than crashes.
- **Import depends on live library fetches** — component graphics resolve only because `collectProjectLibrary` embeds a project-local copy of each referenced `DEVICE`/`SYMBOL`/`FOOTPRINT` document in the `.epro2`; a client that cannot reach the library (offline workspace, permission-denied scope, dropped doc fetch) degrades to unresolved boxes reported as `SCHEMATIC_IMPORT_LIBDOC`. `short`/`nonelec` components carry no symbol binding and stay unresolved.
- **Imported projects carry a partially materialized document model** — on pages of an imported project, `createSchematicPage` throws after the page is already created (the script recovers the uuid by diffing the page list) and `sch_PrimitiveComponent.create` can hang past the page-side timeout, surfacing as a bridge execution error. Live `build` into imported projects is therefore unreliable; native projects are unaffected.
- **`setDocumentSource` cannot add records** — client 4.1.71 accepts only value edits to existing records and rejects every appended record, so it is not a delivery path; use `build` for open documents and `importProject` for new projects.
- **LCSC catalog results are nondeterministic** — `lib_Device.getByLcscIds` can return different listing variants across calls, and some variants carry no symbol/footprint association; `resolveByLcsc` queries the system library scope first, verifies each association loads under its owning scope, and omits the ones that do not, so validation reports the remaining UUIDs as unverified rather than binding a drifted marketplace copy.
- **The extension gateway serializes executions** — a hung client-side API call (observed on `lib_Device.getByLcscIds`) blocks every later `execute` until the editor page is reloaded; the bridge timeout does not release the page-side queue. To keep one hang from stalling every caller, `bridgeTimeoutStreakLimit` consecutive timeouts open a fail-fast circuit: later calls return `SCHEMATIC_BRIDGE_CIRCUIT_OPEN` instantly until a half-open probe after `bridgeCircuitCooldownMs` confirms the client responds again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Open: cold-workspace library documents

The `.epro2` import verifies `CONFIG`/`SCH`/`SCH_PAGE` logs carrying workspace-resolved UUIDs; embedding `DEVICE`/`SYMBOL`/`FOOTPRINT` documents so an import is self-contained on a workspace that lacks the referenced entries is unverified and deferred.

</details>
