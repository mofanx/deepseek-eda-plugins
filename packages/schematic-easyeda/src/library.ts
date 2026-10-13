/**
 * EasyEDA workspace-library adapter for the seam's async library contract.
 * Lookups evaluate `lib_Device`/`lib_Symbol`/`lib_Footprint` BETA calls inside
 * the running client's extension runtime through the run-api-gateway bridge;
 * the adapter isolates those calls so API drift surfaces as lookup failures
 * (unreachable warnings), not validator crashes.
 * @module @deepseek-ai/dsh-plugin-eda-easyeda/library
 */

import type {
  SchematicLibrary,
  SchematicResolvedFootprint,
  SchematicResolvedPart,
  SchematicSymbolPin,
} from '@deepseek-ai/dsh-plugin-eda-sch'
import { SCHEMATIC_LOOKUP_FAILED } from '@deepseek-ai/dsh-plugin-eda-sch'
import { HttpEasyEdaBridge } from './bridge.ts'
import type { EasyEdaBridge } from './bridge.ts'
import { parseDocumentSource } from './readback.ts'

/** Options for {@link EasyEdaLibrary}. */
export interface EasyEdaLibraryOptions {
  /** Pre-connected bridge; when absent, discovery runs against `host`. */
  readonly bridge?: EasyEdaBridge | undefined
  /** run-api-gateway bridge host. */
  readonly host?: string | undefined
  /** Fetch override forwarded to discovery when `bridge` is absent. */
  readonly fetchFn?: typeof fetch | undefined
  /** Per-request timeout in milliseconds for bridge calls. */
  readonly timeoutMs?: number | undefined
  /**
   * Per-request timeout for `lib_*` read calls; defaults to `timeoutMs`. A
   * shorter read timeout bounds how long one hung catalog query can stall a
   * resolution batch before the bridge circuit opens.
   */
  readonly queryTimeoutMs?: number | undefined
  /** Consecutive read timeouts that open the bridge fail-fast circuit. */
  readonly timeoutStreakLimit?: number | undefined
  /** Cooldown before the bridge half-open probe retries the client, in ms. */
  readonly circuitCooldownMs?: number | undefined
  /**
   * Workspace library UUID restricting every lookup (`lib_*` `libraryUuid`
   * argument). Omit for the client's default library scope.
   */
  readonly libraryUuid?: string | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Script fragment for a scoped `lib_*.get` that retries unscoped when the
 * scoped call throws — the client rejects association-supplied library scopes
 * (e.g. system libraries) with an internal error rather than a miss.
 */
function scopedGet(api: 'lib_Device' | 'lib_Symbol' | 'lib_Footprint', uuid: string, scope: string): string {
  const key = JSON.stringify(uuid)
  return `try { return await eda.${api}.get(${key}, ${scope}) }\n` +
    `catch (e) { return await eda.${api}.get(${key}, undefined) }`
}

/**
 * Extract `{number, name?, x, y}` pins from a symbol document source: each
 * `PIN` record carries `x`/`y` in symbol coordinates; its `Pin Number` /
 * `Pin Name` ATTR children (keyed by `parentId`) supply the identifiers.
 *
 * The symbol document is a **persisted** EasyEDA document, and persisted
 * documents have their y axis negated relative to the `SCH_*` placement API
 * (the same relation `serialize.ts` applies when it writes a page). The IR is
 * in API space, so `y` is negated here once: a caller placing a component at
 * API `(X, Y)` finds this pin at `(X + x, Y + y)`, which is exactly where the
 * client draws it. Without the flip every pin with `y ≠ 0` lands on its
 * y-mirrored sibling (see the layout/validator consumers).
 * @param source - the symbol document source text.
 * @returns the symbol's pins in document order, in **sheet/API space**, or
 * `undefined` when no pin carries a number.
 */
function parseSymbolPins(source: string): readonly SchematicSymbolPin[] | undefined {
  const attrByParent = new Map<string, Map<string, string>>()
  const records = parseDocumentSource(source)
  for (const record of records) {
    if (record.type !== 'ATTR' || typeof record.inner !== 'object') continue
    const inner = record.inner as { key?: unknown; value?: unknown; parentId?: unknown }
    if (typeof inner.key !== 'string' || typeof inner.value !== 'string' || typeof inner.parentId !== 'string') continue
    const perKey = attrByParent.get(inner.parentId) ?? new Map<string, string>()
    perKey.set(inner.key, inner.value)
    attrByParent.set(inner.parentId, perKey)
  }
  const pins: SchematicSymbolPin[] = []
  for (const record of records) {
    if (record.type !== 'PIN' || typeof record.inner !== 'object') continue
    const inner = record.inner as { x?: unknown; y?: unknown; uuid?: unknown; id?: unknown }
    const x = typeof inner.x === 'number' ? inner.x : undefined
    const y = typeof inner.y === 'number' ? inner.y : undefined
    if (x === undefined || y === undefined) continue
    const pinId = record.id ?? asString(inner.uuid) ?? asString(inner.id) ?? ''
    const attrs = attrByParent.get(pinId)
    const number = attrs?.get('Pin Number')
    if (number === undefined) continue
    const name = attrs?.get('Pin Name')
    // Persisted space → API space (see the doc comment above).
    pins.push({ number, ...name === undefined ? {} : { name }, x, y: -y })
  }
  return pins.length === 0 ? undefined : pins
}

/**
 * EasyEDA workspace library: resolves LCSC part numbers to real device,
 * symbol, and footprint bindings and answers UUID existence lookups through
 * the running client. A missing client makes every call reject, which the
 * seam treats as an unreachable lookup.
 */
export class EasyEdaLibrary implements SchematicLibrary {
  readonly id = 'easyeda'
  private bridgePromise: Promise<EasyEdaBridge> | undefined

  constructor(private readonly options: EasyEdaLibraryOptions = {}) {}

  /** The `libraryUuid` argument source fragment for `lib_*` calls. */
  private get libraryArg(): string {
    return this.options.libraryUuid === undefined ? 'undefined' : JSON.stringify(this.options.libraryUuid)
  }

  /**
   * Lazily discover and memoize the bridge. Failed discovery clears the cache
   * so a client started later still connects.
   * @returns a connected bridge client.
   */
  private connect(): Promise<EasyEdaBridge> {
    if (this.bridgePromise === undefined) {
      const options = this.options
      this.bridgePromise = options.bridge === undefined
        ? HttpEasyEdaBridge.discover({
          host: options.host,
          fetchFn: options.fetchFn,
          timeoutMs: options.timeoutMs,
          timeoutStreakLimit: options.timeoutStreakLimit,
          circuitCooldownMs: options.circuitCooldownMs,
        })
          .catch((error: unknown) => {
            this.bridgePromise = undefined
            throw error
          })
        : Promise.resolve(options.bridge)
    }
    return this.bridgePromise
  }

  /**
   * Evaluate one `lib_*` call inside the client runtime.
   * @param code - the async function body; must `return` the payload.
   * @returns the payload the body returned.
   */
  private async call(code: string): Promise<unknown> {
    return (await this.connect()).execute(code, { timeoutMs: this.options.queryTimeoutMs })
  }

  /**
   * Look up a device through `lib_Device.get`.
   * @param uuid - the `Device` binding UUID.
   * @param libraryUuid - library scope from a resolved association.
   * @returns the device item when it exists, `undefined` on a definitive miss.
   */
  async resolveDevice(uuid: string, libraryUuid?: string): Promise<unknown> {
    const scope = libraryUuid === undefined ? this.libraryArg : JSON.stringify(libraryUuid)
    const item = await this.call(scopedGet('lib_Device', uuid, scope))
    return item ?? undefined
  }

  /**
   * Verify a symbol through `lib_Symbol.get`. Without a library scope the
   * query resolves only the client's default scope and misses symbols that
   * live in system/project libraries, so a scopeless lookup reports the
   * lookup-failure sentinel (unverifiable) instead of a false miss.
   * @param uuid - the `Symbol` binding UUID.
   * @param libraryUuid - library scope from a resolved association.
   * @returns the symbol item when it exists, `undefined` on a definitive
   * scoped miss, or the lookup-failure sentinel when no scope is available.
   */
  async resolveSymbol(uuid: string, libraryUuid?: string): Promise<unknown> {
    const scope = libraryUuid ?? this.options.libraryUuid
    if (scope === undefined) return SCHEMATIC_LOOKUP_FAILED
    const item = await this.call(scopedGet('lib_Symbol', uuid, JSON.stringify(scope)))
    return item ?? undefined
  }

  /**
   * Verify a footprint through `lib_Footprint.get`. The BETA item carries no
   * pad list, so the resolved record omits `pads` and `PIN_PAD_MISMATCH` stays
   * out for EasyEDA-resolved footprints. Scopeless lookups degrade like
   * {@link resolveSymbol}: unverifiable, never a false miss.
   * @param uuid - the `Footprint` binding UUID.
   * @param libraryUuid - library scope from a resolved association.
   * @returns the footprint record when it exists, `undefined` on a definitive
   * scoped miss, or the lookup-failure sentinel when no scope is available.
   */
  async resolveFootprint(
    uuid: string,
    libraryUuid?: string,
  ): Promise<SchematicResolvedFootprint | typeof SCHEMATIC_LOOKUP_FAILED | undefined> {
    const scope = libraryUuid ?? this.options.libraryUuid
    if (scope === undefined) return SCHEMATIC_LOOKUP_FAILED
    const item = await this.call(scopedGet('lib_Footprint', uuid, JSON.stringify(scope)))
    return item === undefined || item === null ? undefined : {}
  }

  /**
   * Resolve an LCSC part number to real bindings: the system library is
   * queried first (its uuid resolved through `lib_LibrariesList`), then the
   * configured scope, then the client's default scope. Each returned
   * association is verified loadable under its scope before it is reported —
   * an association that cannot be loaded is omitted rather than emitted as an
   * unverifiable binding.
   * @param lcsc - the LCSC part number, e.g. `C25804`.
   * @returns the resolved bindings, or `undefined` on a definitive miss.
   */
  async resolveByLcsc(lcsc: string): Promise<SchematicResolvedPart | undefined> {
    const key = JSON.stringify(lcsc)
    const raw = await this.call(
      'let sysUuid; try { sysUuid = await eda.lib_LibrariesList.getSystemLibraryUuid() } catch (e) {}\n' +
      `const lib = ${this.libraryArg} !== undefined ? ${this.libraryArg} : sysUuid\n` +
      'const pick = (list) => Array.isArray(list)\n' +
      '  ? list.find(i => i?.symbol?.uuid || i?.association?.symbol?.uuid) ?? list[0]\n' +
      '  : list\n' +
      `let item = pick(await eda.lib_Device.getByLcscIds(${key}, lib))\n` +
      'if (item === undefined) {\n' +
      `  item = pick(await eda.lib_Device.search(${key}, lib))\n` +
      '}\n' +
      'if (item === undefined) return undefined\n' +
      'const assoc = (p) => item[p]?.uuid ?? item.association?.[p]?.uuid ?? item.association?.[p + "Uuid"] ?? item[p + "Uuid"]\n' +
      'const assocLib = (p) => (item[p]?.libraryUuid ?? item.association?.[p]?.libraryUuid) ?? lib\n' +
      'const loadable = async (api, uuid, scope) => {\n' +
      '  try { return !!(await eda[api].get(uuid, scope)) } catch (e) {\n' +
      '    try { return !!(await eda[api].get(uuid, undefined)) } catch (e2) { return false }\n' +
      '  }\n' +
      '}\n' +
      'const out = { item, symbolUuid: undefined, symbolLibraryUuid: undefined, footprintUuid: undefined, footprintLibraryUuid: undefined, scopeLibraryUuid: lib }\n' +
      'const symUuid = assoc("symbol"); const symLib = assocLib("symbol")\n' +
      'if (symUuid !== undefined && await loadable("lib_Symbol", symUuid, symLib)) {\n' +
      '  out.symbolUuid = symUuid; out.symbolLibraryUuid = symLib\n' +
      '}\n' +
      'const fpUuid = assoc("footprint"); const fpLib = assocLib("footprint")\n' +
      'if (fpUuid !== undefined && await loadable("lib_Footprint", fpUuid, fpLib)) {\n' +
      '  out.footprintUuid = fpUuid; out.footprintLibraryUuid = fpLib\n' +
      '}\n' +
      'return out',
    )
    const result = asRecord(raw)
    if (result === undefined) return undefined
    const device = asRecord(result.item)
    const deviceUuid = asString(device?.uuid)
    if (device === undefined || deviceUuid === undefined) return undefined
    return {
      deviceUuid,
      deviceLibraryUuid: asString(device.libraryUuid) ?? asString(result.scopeLibraryUuid),
      symbolUuid: asString(result.symbolUuid),
      symbolLibraryUuid: asString(result.symbolLibraryUuid),
      footprintUuid: asString(result.footprintUuid),
      footprintLibraryUuid: asString(result.footprintLibraryUuid),
      name: asString(device.name),
    }
  }

  /**
   * Read the bound symbol's real pin geometry from its library document
   * source. `lib_Symbol.getDocumentSource` is not in the published reference
   * but was live-verified on the client (PIN records carry `x`/`y`/`length`/
   * `rotation`; `Pin Number`/`Pin Name` ATTR children supply identifiers), so
   * the call runs defensively — a missing API, a scopeless query, or a failed
   * fetch returns `undefined` and layout falls back to synthesized rows.
   * @param symbolUuid - the `Symbol` binding UUID.
   * @param libraryUuid - library scope from a resolved association.
   * @returns the symbol's pins in symbol coordinates, or `undefined` when the
   * source cannot be read.
   */
  async resolveSymbolPins(symbolUuid: string, libraryUuid?: string): Promise<readonly SchematicSymbolPin[] | undefined> {
    const scope = libraryUuid ?? this.options.libraryUuid
    if (scope === undefined) return undefined
    const key = JSON.stringify(symbolUuid)
    const source = await this.call(
      `try { return await eda.lib_Symbol.getDocumentSource(${key}, ${JSON.stringify(scope)}) }\n` +
      `catch (e) { try { return await eda.lib_Symbol.getDocumentSource(${key}, undefined) } catch (e2) { return undefined } }`,
    )
    return typeof source === 'string' ? parseSymbolPins(source) : undefined
  }
}
