/**
 * Vocabulary for the schematic-generation capability seam (`ctx.schematic`): a typed
 * intermediate representation (IR) of components, pins, nets, and attributes; the
 * engine-provider contract; and the validation-finding taxonomy.
 * @module @deepseek-ai/dsh-plugin-eda-sch/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * One sheet-space point in `0.01 inch` units (the EasyEDA schematic coordinate
 * unit). Generators MUST NOT emit mil or millimeter values here.
 */
export interface SchematicPoint {
  readonly x: number
  readonly y: number
}

/** Electrical class of a pin, mirroring the document-source `electric` field. */
export type SchematicPinElectric = 'UNKNOWN' | 'INPUT' | 'OUTPUT' | 'BI'

/**
 * What a `COMPONENT` stands for, mirroring the document-source Symbol types:
 * `part` (2) is a physical device, `block` (17) a hierarchical block, `netflag`
 * (18) merges nets by name, `netport` (19) merges across pages, `sheet` (20) a
 * reused sheet, `nonelec` (21) carries no pins, and `short` (22) electrically
 * merges the nets its two pins touch.
 */
export type SchematicComponentKind = 'part' | 'block' | 'netflag' | 'netport' | 'sheet' | 'nonelec' | 'short'

/**
 * One connectable pin. `endpoint` is the sheet-space coordinate of the pin's
 * connectable end (farthest from the symbol body) AFTER the component transform,
 * so the validator never re-derives placement; a missing `endpoint` is filled by
 * the layout stage (`ctx.schematic.layout`). `net` declares logical net
 * membership — under `layout: 'auto'` the layout stage turns it into routed
 * wires or net flags. `name`/`number` mirror the mandatory PIN `NAME`/`NUMBER`
 * attributes; `powerName` marks power/ground-class pins for `NET_MULTI_DRIVER`
 * exclusion and `POWER_SHORT` detection.
 */
export interface SchematicIrPin {
  readonly id: string
  /** Pin name (source `NAME` ATTR); required by `PIN_ATTR_MISSING`. */
  readonly name?: string | undefined
  /** Pin number (source `NUMBER` ATTR); required by `PIN_ATTR_MISSING`. */
  readonly number?: string | undefined
  readonly electric: SchematicPinElectric
  /**
   * Logical net membership. The layout stage routes every pin declaring the
   * same net onto shared geometry (orthogonal trunk) or onto net flags; a
   * laid-out IR needs no `net` to stay connected — it is the model-facing
   * connectivity declaration.
   */
  readonly net?: string | undefined
  /**
   * Sheet-space coordinate of the connectable endpoint; layout assigns it when
   * absent. When the bound symbol's pin geometry is known, an explicit value
   * within one grid step of the true pin snaps onto it; anything farther stays
   * for `WIRE_NOT_ON_PIN` to report.
   */
  readonly endpoint?: SchematicPoint | undefined
  /** Model-declared no-connect; suppresses `FLOATING_PIN`. */
  readonly noConnect?: boolean | undefined
  /** Declared power name (`VCC`, `GND`, …) when the pin is power-class. */
  readonly powerName?: string | undefined
  /** Document-source group id; must not be `'0'` when present. */
  readonly groupId?: string | undefined
}

/** One placed component (or a functional symbol such as a NetFlag). */
export interface SchematicIrComponent {
  readonly id: string
  readonly kind: SchematicComponentKind
  /** Sub-part selector for multi-part devices (`""` for single-part). */
  readonly partId?: string | undefined
  readonly groupId?: string | undefined
  /**
   * Functional-module membership, referencing a `name` in the owning sheet's
   * `blocks` list (free-form names are accepted and ordered after declared
   * blocks). The layout stage clusters members of one module together and
   * routes inter-module nets through flags instead of trunk wires; absent is
   * the flat, ungrouped behavior.
   */
  readonly block?: string | undefined
  /**
   * For `kind: 'block'` components, the 0-based index of the child sheet this
   * block expands into. Absent, validation resolves the child by matching
   * another sheet's `name` against the block's `designator`, `netName`, or
   * `id`; the block's pin `net` names are the interface the child's `netport`
   * components must echo.
   */
  readonly sheetIndex?: number | undefined
  /** Reference designator (`U1`, `R3`, …); required on physical kinds. */
  readonly designator?: string | undefined
  /** The net name a `netflag`/`netport` merges under. */
  readonly netName?: string | undefined
  /** Sheet-space symbol origin; the layout stage assigns it when absent. */
  readonly position?: SchematicPoint | undefined
  readonly rotation?: number | undefined
  readonly mirror?: boolean | undefined
  /** Library device UUID this component binds (`Device` ATTR). */
  readonly deviceUuid?: string | undefined
  /** Library symbol UUID this component binds (`Symbol` ATTR). */
  readonly symbolUuid?: string | undefined
  /** Library footprint UUID this component binds (`Footprint` ATTR). */
  readonly footprintUuid?: string | undefined
  /**
   * Owning-library scope of the `deviceUuid` binding. Workspaces hold several
   * libraries whose UUID namespaces do not mix, so a bare UUID is not
   * reproducible or verifiable without its scope; `resolveBindings` writes the
   * scope its resolved association carried, and a scopeless binding is an
   * unverifiable warning rather than a blocking miss.
   */
  readonly deviceLibraryUuid?: string | undefined
  /** Owning-library scope of the `symbolUuid` binding; see {@link SchematicIrComponent.deviceLibraryUuid}. */
  readonly symbolLibraryUuid?: string | undefined
  /** Owning-library scope of the `footprintUuid` binding; see {@link SchematicIrComponent.deviceLibraryUuid}. */
  readonly footprintLibraryUuid?: string | undefined
  /**
   * LCSC part number (`C25804`) the component should bind. The library seam's
   * `resolveBindings` step turns it into real UUID bindings when a reachable
   * library answers; unresolved `lcsc` declarations surface as
   * `BINDING_UNRESOLVED` like missing bindings.
   */
  readonly lcsc?: string | undefined
  readonly addIntoBom?: boolean | undefined
  readonly addIntoPcb?: boolean | undefined
  readonly pins: readonly SchematicIrPin[]
}

/**
 * One wire or bus polyline. `dots` holds one or more independent polylines,
 * each a flat `[x1, y1, x2, y2, …]` vertex sequence; a wire without `dots`
 * declares only its `net` — the layout stage routes `pin.net` members onto it.
 * `net` mirrors the mandatory `NET` attribute; a missing value is a
 * `WIRE_MISSING_NET` error.
 */
export interface SchematicIrWire {
  readonly id: string
  readonly kind: 'wire' | 'bus'
  readonly dots?: readonly (readonly number[])[] | undefined
  readonly net?: string | undefined
  readonly groupId?: string | undefined
}

/** One bus entry (`BUSENTRY`): connects a wire to a bus branch by `order`. */
export interface SchematicIrBusEntry {
  readonly id: string
  /** The bus net name this entry taps, e.g. `A[1:5]`. */
  readonly busNet: string
  /** Branch index inside the bus expansion (0-based). */
  readonly order: number
  readonly point: SchematicPoint
  readonly groupId?: string | undefined
}

/** A generic key-value attribute attached to one primitive (`ATTR`). */
export interface SchematicIrAttr {
  readonly id: string
  /** Owning primitive id, or a pin-override composite `<componentId><pinId>`. */
  readonly parentId: string
  readonly key: string
  readonly value: string
}

/** An explicit junction legitimizing a connection at its point. */
export interface SchematicIrJunction {
  readonly point: SchematicPoint
}

/** A functional module declared on a sheet; components bind by {@link SchematicIrComponent.block}. */
export interface SchematicIrBlock {
  /** Stable module name referenced by component `block` values. */
  readonly name: string
  /** Human-readable module title, e.g. `POWER SUPPLY`. */
  readonly title?: string | undefined
}

/** All primitives of one schematic page. */
export interface SchematicIrSheet {
  /**
   * Page title; serializers write it into the page META record (falling back
   * to `P<n>` when absent).
   */
  readonly name?: string | undefined
  /**
   * Declared functional modules in display order. Component `block` values
   * not listed here are accepted and placed after declared modules (name
   * order); a sheet without any `block` membership lays out flat as before.
   */
  readonly blocks?: readonly SchematicIrBlock[] | undefined
  readonly components: readonly SchematicIrComponent[]
  readonly wires: readonly SchematicIrWire[]
  readonly busEntries: readonly SchematicIrBusEntry[]
  readonly junctions: readonly SchematicIrJunction[]
  readonly attrs: readonly SchematicIrAttr[]
}

/** The complete schematic IR: one or more pages. */
export interface SchematicIr {
  readonly sheets: readonly SchematicIrSheet[]
}

/**
 * Page-frame size in sheet-space units (0.01 inch). EasyEDA schematic pages
 * draw a bordered frame anchored at the origin (0,0) extending `width` right
 * and `height` down; geometry outside it is reported out-of-sheet.
 */
export interface SchematicPageSize {
  readonly width: number
  readonly height: number
}

/**
 * The EasyEDA A4 landscape page frame, measured from the live client's
 * `titleBlockData` (`Width 1170`, `Height 825`, `Size "A4"`). This is the
 * default hard bound for layout placement and `OBJECT_OUT_OF_SHEET`, and the
 * only page size verified against a live client: `pageSize` bounds generated
 * geometry and validation only — the EasyEDA API exposes no way to switch a
 * sheet's drawn frame (that is a manual editor action), so custom sizes plan
 * against a virtual frame while delivered sheets stay the client's default.
 */
export const SCHEMATIC_PAGE_A4: SchematicPageSize = { width: 1170, height: 825 }

/** Whether a finding blocks delivery (`error`) or only reports (`warning`). */
export type SchematicFindingSeverity = 'error' | 'warning'

/** Where a finding lands, for routing back to the generating model. */
export interface SchematicLocator {
  readonly sheetIndex?: number | undefined
  readonly componentId?: string | undefined
  readonly designator?: string | undefined
  readonly pinId?: string | undefined
  readonly pinNumber?: string | undefined
  readonly net?: string | undefined
  readonly x?: number | undefined
  readonly y?: number | undefined
}

/** One deterministic validator finding. `code` is stable and machine-routable. */
export interface SchematicFinding {
  readonly code: string
  readonly severity: SchematicFindingSeverity
  readonly message: string
  readonly locator?: SchematicLocator | undefined
  readonly suggestion?: string | undefined
}

/**
 * The static validator's outcome. `ok` is the delivery gate: it is true only
 * when no `error`-severity finding exists (warnings never block).
 */
export interface SchematicValidationReport {
  readonly ok: boolean
  readonly findings: readonly SchematicFinding[]
}

/**
 * A footprint resolved through the library. `pads` is the pad-number list used
 * by `PIN_PAD_MISMATCH`; when a library can confirm the footprint exists but
 * cannot enumerate its pads, it omits `pads` and the pad check stays out.
 */
export interface SchematicResolvedFootprint {
  readonly pads?: readonly string[] | undefined
}

/**
 * Lookup-failure sentinel: a {@link SchematicLibraryResolver} returns this when
 * the lookup itself failed (transport error, library flaking mid-run) rather
 * than answered a definitive miss. `BINDING_UNRESOLVED` reports it as an
 * unverifiable warning instead of an error.
 */
export const SCHEMATIC_LOOKUP_FAILED: unique symbol = Symbol('SCHEMATIC_LOOKUP_FAILED')

/**
 * One pin of a resolved symbol in symbol-local coordinates: `x`/`y` is the
 * pin's connectable endpoint relative to the symbol origin, matched to IR pins
 * by `number`. The layout stage transforms these offsets by the component's
 * `rotation`/`mirror` (mirror = horizontal flip applied before rotation, and
 * positive rotation is counterclockwise in sheet space) and places real
 * endpoints; the validator uses them for `WIRE_NOT_ON_PIN`.
 *
 * The offsets are in **sheet/API space** (y down), the same space as
 * {@link SchematicIrComponent.position} and {@link SchematicIrPin.endpoint}, so
 * `position + (x, y)` is the endpoint of that pin. A library whose documents
 * use the opposite axis order must convert before returning them.
 */
export interface SchematicSymbolPin {
  /** Symbol pin number (`Pin Number` ATTR); the join key to IR pins. */
  readonly number: string
  /** Symbol pin name (`Pin Name` ATTR), when the library reports one. */
  readonly name?: string | undefined
  readonly x: number
  readonly y: number
}

/**
 * Workspace-library lookup for the binding rules. Absent means "library
 * unreachable": `BINDING_UNRESOLVED` degrades to a warning (an error under
 * {@link SchematicValidationOptions.requireLibrary}) and `PIN_PAD_MISMATCH`
 * does not run. Methods return `undefined` for a definitive miss and
 * {@link SCHEMATIC_LOOKUP_FAILED} when the lookup itself failed.
 */
export interface SchematicLibraryResolver {
  /** Resolve a device UUID to any truthy value, `undefined`, or the lookup-failure sentinel. */
  resolveDevice?(uuid: string): unknown
  /** Resolve a symbol UUID to any truthy value, `undefined`, or the lookup-failure sentinel. */
  resolveSymbol?(uuid: string): unknown
  /** Resolve a footprint UUID to its record, `undefined`, or the lookup-failure sentinel. */
  resolveFootprint?(uuid: string): SchematicResolvedFootprint | typeof SCHEMATIC_LOOKUP_FAILED | undefined
  /**
   * Resolve a symbol UUID to its pin geometry, `undefined` when the snapshot
   * did not resolve that symbol (miss or lookup failure — the two are not
   * distinguished because pin geometry only feeds layout/endpoint checks).
   */
  resolveSymbolPins?(uuid: string): readonly SchematicSymbolPin[] | undefined
}

/**
 * The device bindings one library resolves for a part-number query: the device
 * UUID plus the symbol/footprint UUIDs its association names, with each
 * primitive's library UUID when the library reports one (UUID lookups in
 * multi-library workspaces need the library scope).
 */
export interface SchematicResolvedPart {
  readonly deviceUuid: string
  readonly deviceLibraryUuid?: string | undefined
  readonly symbolUuid?: string | undefined
  readonly symbolLibraryUuid?: string | undefined
  readonly footprintUuid?: string | undefined
  readonly footprintLibraryUuid?: string | undefined
  /** Display name of the resolved device, when the library reports one. */
  readonly name?: string | undefined
}

/**
 * Async workspace-library seam registered through
 * `SchematicRuntime.registerLibrary`. Providers bridge a real component
 * library (the EasyEDA `lib_Device`/`lib_Symbol`/`lib_Footprint` APIs for the
 * EasyEDA engine); a throwing call is treated as "library unreachable" for that
 * lookup, never as a definitive miss.
 */
export interface SchematicLibrary {
  /** Stable id, unique within the library registry. */
  readonly id: string
  /**
   * Look up a device by UUID.
   * @param uuid - the `Device` binding UUID.
   * @param libraryUuid - library scope hint from a resolved association, when known.
   * @returns any truthy record when the device exists, `undefined` on a definitive miss.
   */
  resolveDevice(uuid: string, libraryUuid?: string): Promise<unknown>
  /**
   * Look up a symbol by UUID.
   * @param uuid - the `Symbol` binding UUID.
   * @param libraryUuid - library scope hint from a resolved association, when known.
   * @returns any truthy record when the symbol exists, `undefined` on a definitive miss.
   */
  resolveSymbol(uuid: string, libraryUuid?: string): Promise<unknown>
  /**
   * Look up a footprint by UUID.
   * @param uuid - the `Footprint` binding UUID.
   * @param libraryUuid - library scope hint from a resolved association, when known.
   * @returns the footprint record when it exists, `undefined` on a definitive miss.
   */
  resolveFootprint(uuid: string, libraryUuid?: string): Promise<SchematicResolvedFootprint | typeof SCHEMATIC_LOOKUP_FAILED | undefined>
  /**
   * Resolve an LCSC part number to device bindings. Without this optional
   * method, components that declare `lcsc` stay unresolved.
   * @param lcsc - the LCSC part number, e.g. `C25804`.
   * @returns the resolved device bindings, or `undefined` on a definitive miss.
   */
  resolveByLcsc?(lcsc: string): Promise<SchematicResolvedPart | undefined>
  /**
   * Resolve a symbol UUID to its pin geometry in symbol-local coordinates.
   * Without this optional method the layout stage synthesizes pin endpoints
   * from declared pin counts and `WIRE_NOT_ON_PIN` stays out. A throwing call
   * is treated as "library unreachable" for that lookup.
   * @param symbolUuid - the `Symbol` binding UUID.
   * @param libraryUuid - the binding's library scope, when known.
   * @returns the symbol's pin list, or `undefined` on a definitive miss.
   */
  resolveSymbolPins?(symbolUuid: string, libraryUuid?: string): Promise<readonly SchematicSymbolPin[] | undefined>
}

/**
 * The outcome of {@link SchematicRuntime.resolveBindings}: the IR with every
 * resolvable `lcsc` declaration turned into UUID bindings, plus the prefetched
 * synchronous library snapshot the validator consumes. `libraryResolver` is
 * `undefined` when no registered library answered — the unreachable-library
 * degradation, not a definitive miss. `symbolPins` carries the pin geometry
 * resolved per bound symbol UUID, for the layout stage's real-endpoint
 * placement; it is absent when no registered library implements
 * `resolveSymbolPins` or every lookup missed.
 */
export interface SchematicBindingResolution {
  readonly ir: SchematicIr
  readonly libraryResolver: SchematicLibraryResolver | undefined
  readonly symbolPins?: ReadonlyMap<string, readonly SchematicSymbolPin[]> | undefined
}

/** Inputs to one validation run. */
export interface SchematicValidationOptions {
  /** Workspace-library resolver for the binding family. */
  readonly libraryResolver?: SchematicLibraryResolver | undefined
  /**
   * Strict binding gate: an unreachable library escalates `BINDING_UNRESOLVED`
   * to an error instead of the unreachable-warning degradation.
   */
  readonly requireLibrary?: boolean | undefined
  /** Finding codes to suppress entirely (exact code match). */
  readonly disabledRules?: readonly string[] | undefined
  /**
   * `SCHEMATIC_LAYOUT_MONOLITHIC` advisory threshold: a sheet holding more
   * than this many `part` components with zero module membership reports a
   * grouping suggestion. Default `20`.
   */
  readonly monolithicThreshold?: number | undefined
  /**
   * Page-frame bound for `OBJECT_OUT_OF_SHEET`: primitive geometry outside
   * `[0, width] × [0, height]` is flagged. Default {@link SCHEMATIC_PAGE_A4}.
   */
  readonly pageSize?: SchematicPageSize | undefined
}

/** Inputs to one live {@link SchematicEngine.verify} call. */
export interface SchematicEngineVerifyOptions {
  /**
   * Pin geometry per bound symbol UUID (the `symbolPins` snapshot from
   * {@link SchematicRuntime.resolveBindings}). Engines that read back real
   * client geometry reconcile pin endpoints against it; without it the
   * endpoint-level check stays out.
   */
  readonly symbolPins?: ReadonlyMap<string, readonly SchematicSymbolPin[]> | undefined
}

/**
 * A serialization engine registered with `ctx.schematic.registerEngine`.
 * Implementations project the IR to a deliverable document source; validation
 * stays in the seam so every engine inherits the same gate.
 */
export interface SchematicEngine {
  /** Stable id, unique within the engine registry. */
  readonly id: string
  /** Cheap local usability check; must not perform I/O. */
  available(): boolean
  /**
   * Project the IR to document source.
   * @param ir - the validated schematic IR.
   * @returns the emitted document source text.
   */
  serialize(ir: SchematicIr): string | Promise<string>
  /**
   * Live read-back verification: deliver the IR through the engine's client
   * path and diff the persisted result against the IR, returning structural
   * findings for the verify-repair loop. Engines without a live path omit the
   * method; callers treat its absence as verification unavailable.
   * @param ir - the validated, laid-out schematic IR.
   * @param options - per-call inputs such as the bound symbols' pin geometry.
   * @returns delivery, read-back, and netlist-diff findings.
   */
  verify?(ir: SchematicIr, options?: SchematicEngineVerifyOptions): Promise<readonly SchematicFinding[]>
}

/** Layout-stage mode: `auto` fills missing geometry, `off` is a pass-through. */
export type SchematicLayoutMode = 'auto' | 'off'

/**
 * Tunables for {@link layoutSchematic}. Synthesized coordinates land on `grid`
 * multiples and explicit input geometry passes through untouched, except that
 * an explicit pin endpoint within one `grid` step of the bound symbol's real
 * pin snaps onto it.
 */
export interface SchematicLayoutOptions {
  /** Snap grid in 0.01-inch units. Default `10`. */
  readonly grid?: number | undefined
  /** Horizontal pitch between placement columns. Default `400`. */
  readonly columnPitch?: number | undefined
  /** Vertical gap between stacked components in one column. Default `60`. */
  readonly rowGap?: number | undefined
  /** Sheet-space origin of the main placement zone. Default `{x: 200, y: 200}`. */
  readonly margin?: SchematicPoint | undefined
  /** Vertical pitch between pin rows on one side of a component. Default `20`. */
  readonly pinPitch?: number | undefined
  /** Pin-endpoint offset from the symbol outline. Default `20`. */
  readonly pinStub?: number | undefined
  /**
   * Orthogonal-routing threshold: a net whose fan-out reaches this count routes
   * through net flags instead of a wire trunk. Default `6`.
   */
  readonly flagFanout?: number | undefined
  /**
   * Modules per row in the placement grid when a sheet declares functional
   * blocks. Default `ceil(sqrt(module count))`; ignored for flat sheets.
   */
  readonly moduleColumns?: number | undefined
  /**
   * Pin geometry per bound symbol UUID (the `symbolPins` snapshot from
   * {@link SchematicRuntime.resolveBindings}). When the bound symbol's pins
   * are known, endpoints are placed on the real pin positions — transformed
   * by the component's `rotation`/`mirror` — instead of synthesized rows, and
   * explicit endpoints within one `grid` step snap onto the true pin.
   */
  readonly symbolPins?: ReadonlyMap<string, readonly SchematicSymbolPin[]> | undefined
  /**
   * Hard page-frame bound for placement; defaults to {@link SCHEMATIC_PAGE_A4}.
   * The module grid packs inside `[margin, pageSize - edge allowance]` —
   * module/column spacing compresses first, then groups that still overflow
   * spill onto additional sheets. Sheets carrying explicit component
   * positions or hierarchy primitives keep authored geometry untouched and
   * rely on `OBJECT_OUT_OF_SHEET` instead.
   */
  readonly pageSize?: SchematicPageSize | undefined
}

/** Typed schematic error with a machine-routable, open-string `code`. */
export class SchematicError extends HarnessError {}
