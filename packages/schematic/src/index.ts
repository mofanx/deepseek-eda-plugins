/**
 * Service Definition for the schematic-generation capability seam (`ctx.schematic`):
 * the engine registry with selection-order-independent resolution, and the static
 * validator every engine inherits as the authoritative delivery gate. Duplicate
 * engine ids are rejected; at execution time a configured engine must exist and be
 * usable, or exactly one usable engine must be registered.
 * @module @deepseek-ai/dsh-plugin-eda-sch
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SCHEMATIC_LOOKUP_FAILED, SchematicError } from './types.ts'
import type {
  SchematicBindingResolution,
  SchematicEngine,
  SchematicIr,
  SchematicIrComponent,
  SchematicIrSheet,
  SchematicLayoutMode,
  SchematicLayoutOptions,
  SchematicLibrary,
  SchematicResolvedFootprint,
  SchematicResolvedPart,
  SchematicSymbolPin,
  SchematicValidationOptions,
  SchematicValidationReport,
} from './types.ts'
import { layoutSchematic } from './layout.ts'
import { validateSchematic } from './validate.ts'

export { SCHEMATIC_LOOKUP_FAILED, SCHEMATIC_PAGE_A3, SCHEMATIC_PAGE_A4, SchematicError } from './types.ts'
export { transformSymbolPoint } from './geometry.ts'
export { parseSchematicIr } from './ir.ts'
export { layoutSchematic } from './layout.ts'
export { SCHEMATIC_PAGE_BUDGET, contentCoverage, fittedPageSize, outwardContentBox, snapToGrid } from './budget.ts'
export type { SchematicContentBox } from './budget.ts'
export { expandBusName, validateSchematic } from './validate.ts'
export type {
  SchematicBindingResolution,
  SchematicComponentKind,
  SchematicEngine,
  SchematicEngineSerializeOptions,
  SchematicEngineVerifyOptions,
  SchematicFinding,
  SchematicFindingSeverity,
  SchematicIr,
  SchematicIrAttr,
  SchematicIrBlock,
  SchematicIrBusEntry,
  SchematicIrComponent,
  SchematicIrJunction,
  SchematicIrPin,
  SchematicIrSheet,
  SchematicIrWire,
  SchematicLayoutMode,
  SchematicLayoutOptions,
  SchematicLibrary,
  SchematicLibraryResolver,
  SchematicLocator,
  SchematicPageSize,
  SchematicPinElectric,
  SchematicPoint,
  SchematicResolvedFootprint,
  SchematicResolvedPart,
  SchematicSymbolPin,
  SchematicTitleBlockOptions,
  SchematicValidationOptions,
  SchematicValidationReport,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    schematic: SchematicRuntime
  }
}

/**
 * Config for the schematic seam. `engine` pins which registered provider wins;
 * omitted, exactly one usable registered engine auto-selects. Operational
 * overrides such as environment variables must feed this same field rather than
 * introduce a hidden priority chain.
 */
export interface SchematicRuntimeConfig {
  /** Explicit engine id. Omitted = auto-select when exactly one usable. */
  readonly engine?: string
  /**
   * Strict binding gate: an unreachable library escalates `BINDING_UNRESOLVED`
   * to an error. Default `false` keeps the unreachable-warning degradation so
   * generation works without a live workspace library.
   */
  readonly requireLibrary?: boolean
  /**
   * Layout stage mode. `auto` (default) fills missing positions, pin
   * endpoints, and net routing deterministically; explicit geometry passes
   * through untouched. `off` makes {@link SchematicRuntime.layout} a
   * pass-through for callers that own their placement.
   */
  readonly layout?: SchematicLayoutMode
}

/**
 * The schematic-generation service. Registered as `ctx.schematic` (one instance
 * per context).
 *
 * Engine selection (resolved at call time, never order-dependent):
 * - A configured id that is registered and `available()` → that engine.
 * - A configured id not registered → `SCHEMATIC_ENGINE_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `SCHEMATIC_ENGINE_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable engine → that engine.
 * - No id configured, multiple usable engines → `SCHEMATIC_ENGINE_AMBIGUOUS`.
 * - No id configured, no usable engine → `SCHEMATIC_ENGINE_UNAVAILABLE`.
 */
export class SchematicRuntime extends Service {
  /**
   * Engine-selection config. `$DSH_SCHEMATIC_ENGINE` is equivalent to `engine`
   * and is NOT a separate priority chain.
   */
  static Config: z<SchematicRuntimeConfig> = z.object({
    engine: z.string(),
    requireLibrary: z.boolean(),
    layout: z.union(['auto', 'off']),
  })

  private readonly engines = new Map<string, SchematicEngine>()
  private readonly libraries = new Map<string, SchematicLibrary>()
  private readonly engineId: string | undefined
  private readonly requireLibrary: boolean
  private readonly layoutMode: SchematicLayoutMode

  constructor(ctx: Context, config: SchematicRuntimeConfig = {}) {
    super(ctx, 'schematic')
    this.engineId = config.engine ?? process.env.DSH_SCHEMATIC_ENGINE
    this.requireLibrary = config.requireLibrary ?? false
    this.layoutMode = config.layout ?? 'auto'
  }

  /**
   * Register a serialization engine. Throws {@link SchematicError}
   * `SCHEMATIC_DUPLICATE_ENGINE` when the id is already taken. Returns a
   * disposer; the registration unwinds with the calling fiber.
   * @param engine - the engine; its `id` is the registry key.
   * @returns the disposer that unregisters the engine.
   */
  registerEngine(engine: SchematicEngine): () => void {
    if (this.engines.has(engine.id)) {
      throw new SchematicError(`a schematic engine with id "${engine.id}" is already registered`, 'SCHEMATIC_DUPLICATE_ENGINE')
    }
    const store = this.engines
    const dispose = this.ctx.effect(function* () {
      store.set(engine.id, engine)
      yield () => store.delete(engine.id)
    }, 'schematic.registerEngine()')
    // ctx.effect's disposer returns Promise<void>; the registry disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Resolve the selected engine or throw the matching {@link SchematicError}.
   * @returns the configured or auto-selected usable engine.
   */
  engine(): SchematicEngine {
    const configured = this.engineId
    if (configured !== undefined) {
      const engine = this.engines.get(configured)
      if (engine === undefined) {
        throw new SchematicError(`configured schematic engine "${configured}" is not registered`, 'SCHEMATIC_ENGINE_CONFIGURED_MISSING')
      }
      if (!engine.available()) {
        throw new SchematicError(`configured schematic engine "${configured}" is registered but unavailable`, 'SCHEMATIC_ENGINE_CONFIGURED_UNAVAILABLE')
      }
      return engine
    }
    const usable = [...this.engines.values()].filter(engine => engine.available())
    const [single] = usable
    if (single === undefined) {
      throw new SchematicError('no usable schematic engine is registered', 'SCHEMATIC_ENGINE_UNAVAILABLE')
    }
    if (usable.length > 1) {
      const ids = usable.map(engine => engine.id).join(', ')
      throw new SchematicError(`multiple usable schematic engines are registered (${ids}); configure one explicitly`, 'SCHEMATIC_ENGINE_AMBIGUOUS')
    }
    return single
  }

  /**
   * Register an async workspace library used to bind generated components.
   * `resolveBindings` queries registered libraries in insertion order and
   * takes the first answered (non-throwing) result; a throwing library is
   * unreachable for that lookup, never a definitive miss.
   * @param library - the library adapter. `id` must be unique.
   * @returns disposer that deregisters the library.
   */
  registerLibrary(library: SchematicLibrary): () => void {
    if (this.libraries.has(library.id)) {
      throw new SchematicError(`a schematic library with id "${library.id}" is already registered`, 'SCHEMATIC_DUPLICATE_LIBRARY')
    }
    const store = this.libraries
    const dispose = this.ctx.effect(function* () {
      store.set(library.id, library)
      yield () => store.delete(library.id)
    }, 'schematic.registerLibrary()')
    // ctx.effect's disposer returns Promise<void>; the registry disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Resolve one part-number query through the registered libraries in order.
   * @param lcsc - the LCSC part number, e.g. `C25804`.
   * @returns the first answered binding set, plus whether any library
   * answered at all (a throwing library is unreachable, not a miss).
   */
  private async queryLcsc(lcsc: string): Promise<{ part: SchematicResolvedPart | undefined; answered: boolean }> {
    let answered = false
    for (const library of this.libraries.values()) {
      if (library.resolveByLcsc === undefined) continue
      try {
        const part = await library.resolveByLcsc(lcsc)
        answered = true
        if (part !== undefined) return { part, answered }
      } catch {
        // A throwing library is unreachable for this lookup; try the next one.
      }
    }
    return { part: undefined, answered }
  }

  /**
   * Resolve one declared binding UUID through the registered libraries in
   * order.
   * @param kind - which binding field the UUID belongs to.
   * @param uuid - the declared binding UUID.
   * @returns the first non-`undefined` answer, `undefined` when every reached
   * library missed, or {@link SCHEMATIC_LOOKUP_FAILED} when every registered
   * library threw.
   */
  private async queryUuid(
    kind: 'device' | 'symbol' | 'footprint',
    uuid: string,
    libraryUuid?: string,
  ): Promise<unknown> {
    let answered = false
    for (const library of this.libraries.values()) {
      let resolved: unknown
      try {
        resolved = kind === 'device'
          ? await library.resolveDevice(uuid, libraryUuid)
          : kind === 'symbol'
            ? await library.resolveSymbol(uuid, libraryUuid)
            : await library.resolveFootprint(uuid, libraryUuid)
      } catch {
        // A throwing library is unreachable for this lookup; try the next one.
        continue
      }
      answered = true
      if (resolved !== undefined) return resolved
    }
    return answered ? undefined : SCHEMATIC_LOOKUP_FAILED
  }

  /**
   * Resolve one bound symbol's pin geometry through the registered libraries
   * in order.
   * @param symbolUuid - the `Symbol` binding UUID.
   * @param libraryUuid - the binding's library scope, when the IR carries one.
   * @returns the first answered pin list, or `undefined` when no library
   * returned geometry.
   */
  private async querySymbolPins(
    symbolUuid: string,
    libraryUuid?: string,
  ): Promise<{ pins: readonly SchematicSymbolPin[] | undefined; answered: boolean }> {
    let answered = false
    for (const library of this.libraries.values()) {
      if (library.resolveSymbolPins === undefined) continue
      try {
        const pins = await library.resolveSymbolPins(symbolUuid, libraryUuid)
        answered = true
        if (pins !== undefined) return { pins, answered }
      } catch {
        // A throwing library is unreachable for this lookup; try the next one.
      }
    }
    return { pins: undefined, answered }
  }

  /**
   * Async binding pass ahead of validation: turn resolvable `lcsc`
   * declarations into real UUID bindings (declared UUIDs always win) together
   * with the owning-library scopes (`deviceLibraryUuid`/`symbolLibraryUuid`/
   * `footprintLibraryUuid`), then prefetch every declared UUID — scoped where
   * the IR carries a scope — into a synchronous snapshot resolver the
   * validator consumes, plus per-symbol pin geometry for the layout stage.
   * `libraryResolver` comes back `undefined` when no
   * registered library answered any call — the unreachable-library
   * degradation, which `requireLibrary` may escalate to a blocking gate.
   * @param ir - the parsed IR document.
   * @returns the bound IR and the prefetched library snapshot.
   */
  async resolveBindings(ir: SchematicIr): Promise<SchematicBindingResolution> {
    if (this.libraries.size === 0) return { ir, libraryResolver: undefined }
    let answered = false

    const sheets: SchematicIrSheet[] = []
    let irChanged = false
    for (const sheet of ir.sheets) {
      const components: SchematicIrComponent[] = []
      let sheetChanged = false
      for (const component of sheet.components) {
        const needsFill = component.lcsc !== undefined
          && (component.deviceUuid === undefined || component.symbolUuid === undefined || component.footprintUuid === undefined)
        if (!needsFill) {
          components.push(component)
          continue
        }
        const { part, answered: lcscAnswered } = await this.queryLcsc(component.lcsc)
        answered = answered || lcscAnswered
        if (part === undefined) {
          components.push(component)
          continue
        }
        // Resolved associations carry their owning-library scopes; write them
        // into the IR so later stages (prefetch, validation, live build) do
        // not re-derive scope from a drifting marketplace index. A scope only
        // travels with the UUID it was resolved for — a declared UUID winning
        // over the part's keeps the scope unset rather than borrowing it.
        const deviceUuid = component.deviceUuid ?? part.deviceUuid
        const symbolUuid = component.symbolUuid ?? part.symbolUuid
        const footprintUuid = component.footprintUuid ?? part.footprintUuid
        components.push({
          ...component,
          deviceUuid,
          symbolUuid,
          footprintUuid,
          deviceLibraryUuid: component.deviceLibraryUuid
            ?? (deviceUuid === part.deviceUuid ? part.deviceLibraryUuid : undefined),
          symbolLibraryUuid: component.symbolLibraryUuid
            ?? (symbolUuid === part.symbolUuid ? part.symbolLibraryUuid : undefined),
          footprintLibraryUuid: component.footprintLibraryUuid
            ?? (footprintUuid === part.footprintUuid ? part.footprintLibraryUuid : undefined),
        })
        sheetChanged = true
      }
      if (sheetChanged) {
        irChanged = true
        sheets.push({ ...sheet, components })
      } else {
        sheets.push(sheet)
      }
    }
    const boundIr: SchematicIr = irChanged ? { ...ir, sheets } : ir

    const devices = new Map<string, unknown>()
    const symbols = new Map<string, unknown>()
    const footprints = new Map<string, SchematicResolvedFootprint | typeof SCHEMATIC_LOOKUP_FAILED | undefined>()
    const symbolPins = new Map<string, readonly SchematicSymbolPin[]>()
    for (const sheet of boundIr.sheets) {
      for (const component of sheet.components) {
        if (component.deviceUuid !== undefined && !devices.has(component.deviceUuid)) {
          const resolved = await this.queryUuid('device', component.deviceUuid, component.deviceLibraryUuid)
          answered = answered || resolved !== SCHEMATIC_LOOKUP_FAILED
          devices.set(component.deviceUuid, resolved)
        }
        if (component.symbolUuid !== undefined && !symbols.has(component.symbolUuid)) {
          const resolved = await this.queryUuid('symbol', component.symbolUuid, component.symbolLibraryUuid)
          answered = answered || resolved !== SCHEMATIC_LOOKUP_FAILED
          symbols.set(component.symbolUuid, resolved)
        }
        if (component.footprintUuid !== undefined && !footprints.has(component.footprintUuid)) {
          const resolved = await this.queryUuid('footprint', component.footprintUuid, component.footprintLibraryUuid)
          answered = answered || resolved !== SCHEMATIC_LOOKUP_FAILED
          footprints.set(component.footprintUuid, resolved as SchematicResolvedFootprint | typeof SCHEMATIC_LOOKUP_FAILED | undefined)
        }
        if (component.symbolUuid !== undefined && !symbolPins.has(component.symbolUuid)) {
          const { pins, answered: pinsAnswered } = await this.querySymbolPins(component.symbolUuid, component.symbolLibraryUuid)
          answered = answered || pinsAnswered
          if (pins !== undefined) symbolPins.set(component.symbolUuid, pins)
        }
      }
    }

    return {
      ir: boundIr,
      libraryResolver: answered
        ? {
          resolveDevice: uuid => devices.get(uuid),
          resolveSymbol: uuid => symbols.get(uuid),
          resolveFootprint: uuid => footprints.get(uuid),
          resolveSymbolPins: uuid => symbolPins.get(uuid),
        }
        : undefined,
      symbolPins: symbolPins.size === 0 ? undefined : symbolPins,
    }
  }

  /**
   * Run the deterministic layout stage over one IR document. With
   * `layout: 'auto'` (the default) missing positions, pin endpoints, and net
   * routing are filled deterministically — grid-aligned placement in
   * signal-flow columns, an annotation margin for flag/port symbols, and
   * `pin.net` routed through orthogonal trunks or generated net flags. With
   * `layout: 'off'` the document returns unchanged.
   * @param ir - the IR document; geometry fields may be absent under `auto`.
   * @param options - layout tunables forwarded to {@link layoutSchematic}.
   * @returns the laid-out IR (the same object under `off`).
   */
  layout(ir: SchematicIr, options: SchematicLayoutOptions = {}): SchematicIr {
    if (this.layoutMode === 'off') return ir
    return layoutSchematic(ir, options)
  }

  /**
   * Run the static validator over one IR document. This is the authoritative
   * delivery gate owned by the seam so every engine inherits the same contract.
   * @param ir - the typed schematic IR.
   * @param options - optional library resolver, strict-gate override, and rule
   * suppressions.
   * @returns the gate report; `ok` is false when any `error` finding exists.
   */
  validate(ir: SchematicIr, options: SchematicValidationOptions = {}): SchematicValidationReport {
    return validateSchematic(ir, {
      ...options,
      requireLibrary: options.requireLibrary ?? this.requireLibrary,
    })
  }
}

export default SchematicRuntime
