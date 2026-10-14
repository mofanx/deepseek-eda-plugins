/**
 * EasyEDA engine plugin for the schematic seam (`ctx.schematic`). Registers the
 * `easyeda` {@link SchematicEngine}, which projects the IR to V3 `SCH_PAGE`
 * document source in the client's persisted schema, and carries two delivery
 * paths through the run-api-gateway bridge: live build places the IR
 * primitive-by-primitive into an open document; project import zips the IR as
 * `.epro2` and hands it to `importProjectByProjectFile`. Validation stays in
 * the seam.
 * @module @deepseek-ai/dsh-plugin-eda-easyeda
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SchematicEngine, SchematicFinding, SchematicIr, SchematicSymbolPin } from '@deepseek-ai/dsh-plugin-eda-sch'
import { serializeEasyEdaDocument } from '@deepseek-ai/dsh-plugin-eda-core'
import { HttpEasyEdaBridge } from '@deepseek-ai/dsh-plugin-eda-core'
import { buildIntoEasyEda, importIntoEasyEda } from './build.ts'
import { EasyEdaLibrary } from '@deepseek-ai/dsh-plugin-eda-core'
import type { EasyEdaBridge } from '@deepseek-ai/dsh-plugin-eda-core'
import type { EasyEdaBuildReport, EasyEdaImportReport } from './build.ts'

export { serializeEasyEdaDocument, serializeEasyEdaProject } from '@deepseek-ai/dsh-plugin-eda-core'
export type {
  EasyEdaEmbeddedDoc,
  EasyEdaProjectLibrary,
  EasyEdaProjectPackage,
  EasyEdaSerializeOptions,
} from '@deepseek-ai/dsh-plugin-eda-core'
export {
  EASYEDA_BRIDGE_IMPLEMENTATION,
  EASYEDA_BRIDGE_LANDING_URL,
  EASYEDA_BRIDGE_PORT_MAX,
  EASYEDA_BRIDGE_PORT_MIN,
  HttpEasyEdaBridge,
  spawnEasyEdaBridge,
} from '@deepseek-ai/dsh-plugin-eda-core'
export type { EasyEdaBridge, EasyEdaBridgeExecuteOptions, HttpEasyEdaBridgeOptions } from '@deepseek-ai/dsh-plugin-eda-core'
export {
  buildIntoEasyEda,
  collectProjectLibrary,
  importIntoEasyEda,
  renderPrepareScript,
  renderComponentChunkScript,
  renderWireChunkScript,
  renderBlockChunkScript,
  renderSheetSymbolChunkScript,
  renderOracleScript,
  renderImportScript,
  renderImportReadbackScript,
} from './build.ts'
export type {
  EasyEdaBuildOptions,
  EasyEdaBuildReport,
  EasyEdaImportLibrary,
  EasyEdaImportOptions,
  EasyEdaImportReport,
} from './build.ts'
export { diffNetlists, parseDocumentSource, readBackAttrs, readBackNetRegions } from '@deepseek-ai/dsh-plugin-eda-core'
export { EasyEdaLibrary } from '@deepseek-ai/dsh-plugin-eda-core'
export type { EasyEdaLibraryOptions } from '@deepseek-ai/dsh-plugin-eda-core'

/** Stable engine id of the EasyEDA document-source serializer. */
export const EASYEDA_ENGINE_ID = 'easyeda'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'schematic-easyeda'

/** The schematic seam this engine registers into. */
export const inject = ['schematic']

/** Plugin config: emission-time knobs plus live-build bridge settings. */
export interface Config {
  /** Eventual-consistency client tag written into each `DOCHEAD` line. */
  clientId?: string
  /** run-api-gateway bridge host for the live build path. */
  bridgeHost?: string
  /** Per-request timeout in milliseconds for bridge calls. */
  bridgeTimeoutMs?: number
  /** Per-request timeout in milliseconds for `lib_*` read calls; defaults to `bridgeTimeoutMs`. */
  bridgeQueryTimeoutMs?: number
  /** Consecutive bridge timeouts that open the fail-fast circuit. */
  bridgeTimeoutStreakLimit?: number
  /** Cooldown before a half-open probe retries the client, in milliseconds. */
  bridgeCircuitCooldownMs?: number
  /**
   * Spawn the bundled `dsh-eda-bridge` bin and rescan when a localhost
   * discovery finds no relay (default `true`); `false` keeps discovery
   * passive in locked-down runtimes.
   */
  bridgeAutoSpawn?: boolean
  /** Collect the BETA `sch_Drc` detail as advisory findings after a build. */
  advisoryDrc?: boolean
  /** Workspace library UUID restricting every library lookup; omit for the default scope. */
  libraryUuid?: string
}

export const Config: z<Config> = z.object({
  clientId: z.string().default('dsh'),
  bridgeHost: z.string().default('127.0.0.1'),
  bridgeTimeoutMs: z.number().default(30_000),
  bridgeQueryTimeoutMs: z.number().default(10_000),
  bridgeTimeoutStreakLimit: z.number().default(3),
  bridgeCircuitCooldownMs: z.number().default(15_000),
  bridgeAutoSpawn: z.boolean().default(true),
  advisoryDrc: z.boolean().default(true),
  libraryUuid: z.string(),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Overrides for one {@link EasyEdaSchematicEngine.build} call. */
export interface EasyEdaEngineBuildOptions {
  /** Pre-connected bridge; when absent, discovery runs against `bridgeHost`. */
  readonly bridge?: EasyEdaBridge | undefined
  /** Fetch override forwarded to discovery when `bridge` is absent. */
  readonly fetchFn?: typeof fetch | undefined
  /** Allow creating a schematic/page when none is open (BETA document APIs). */
  readonly createDocument?: boolean | undefined
  /** Per-call override of the configured advisory-DRC switch. */
  readonly advisoryDrc?: boolean | undefined
  /** Per-call override of the configured bridge timeout, in milliseconds. */
  readonly timeoutMs?: number | undefined
  /**
   * Pin geometry per bound symbol UUID (the `symbolPins` snapshot from
   * `resolveBindings`); the read-back diff reconciles pin endpoints against
   * the real symbol pins when present.
   */
  readonly symbolPins?: ReadonlyMap<string, readonly SchematicSymbolPin[]> | undefined
}

/** Overrides for one {@link EasyEdaSchematicEngine.importProject} call. */
export interface EasyEdaEngineImportOptions {
  /** Pre-connected bridge; when absent, discovery runs against `bridgeHost`. */
  readonly bridge?: EasyEdaBridge | undefined
  /** Fetch override forwarded to discovery when `bridge` is absent. */
  readonly fetchFn?: typeof fetch | undefined
  /** Friendly name of the imported project. */
  readonly projectName?: string | undefined
  /** Allow closing the current project's open document tabs when the client
   * refuses to switch to the imported project; defaults to `false`. */
  readonly allowTabClose?: boolean | undefined
  /** Per-call override of the configured bridge timeout, in milliseconds. */
  readonly timeoutMs?: number | undefined
  /** See {@link EasyEdaEngineBuildOptions.symbolPins}. */
  readonly symbolPins?: ReadonlyMap<string, readonly SchematicSymbolPin[]> | undefined
}

/**
 * The EasyEDA engine: document-source serialization is always usable; the two
 * delivery paths additionally place the IR into a running client — primitive-
 * by-primitive into an open document, or as a whole imported `.epro2` project
 * — and verify by read-back.
 */
export class EasyEdaSchematicEngine implements SchematicEngine {
  readonly id = EASYEDA_ENGINE_ID

  constructor(private readonly config: ResolvedConfig) {}

  /** @returns always true — serialization needs no external resource. */
  available(): boolean {
    return true
  }

  /**
   * Project the IR to EasyEDA V3 document source.
   * @param ir - the schematic IR.
   * @returns the `||`-joined document-source text.
   */
  serialize(ir: SchematicIr): string {
    return serializeEasyEdaDocument(ir, { clientId: this.config.clientId })
  }

  /**
   * Place the IR into a running EasyEDA client through the bridge. Uses
   * `options.bridge` when given, otherwise discovers the run-api-gateway server
   * on the configured host and port range. The static seam validator remains
   * the delivery gate; this path returns advisory and build findings only.
   * @param ir - the schematic IR to place.
   * @param options - bridge injection and per-call build switches.
   * @returns creation count, built page uuids, and structured findings.
   */
  async build(ir: SchematicIr, options: EasyEdaEngineBuildOptions = {}): Promise<EasyEdaBuildReport> {
    const bridge = options.bridge ?? await HttpEasyEdaBridge.discover({
      host: this.config.bridgeHost,
      fetchFn: options.fetchFn,
      timeoutMs: this.config.bridgeTimeoutMs,
      timeoutStreakLimit: this.config.bridgeTimeoutStreakLimit,
      circuitCooldownMs: this.config.bridgeCircuitCooldownMs,
      autoSpawn: this.config.bridgeAutoSpawn,
    })
    return buildIntoEasyEda(ir, {
      bridge,
      createDocument: options.createDocument,
      advisoryDrc: options.advisoryDrc ?? this.config.advisoryDrc,
      timeoutMs: options.timeoutMs,
      symbolPins: options.symbolPins,
    })
  }

  /**
   * Live verification for the verify-repair loop: build the IR onto a fresh
   * page created and activated inside the open project, and return every
   * build, round-trip, and structural
   * netlist-diff finding (`SCHEMATIC_NETLIST_*` errors for dropped, merged, or
   * wrongly named nets). The build places primitives in the client; callers
   * opt in through the tools' `verify` parameter. Verification creates a
   * schematic when the client has no active page — `verify` is already an
   * explicit live-delivery opt-in; pass `createDocument: false` to require
   * an existing document instead.
   * @param ir - the validated, laid-out schematic IR.
   * @param options - bridge injection and per-call build switches.
   * @returns build, round-trip, and netlist-diff findings.
   */
  async verify(ir: SchematicIr, options: EasyEdaEngineBuildOptions = {}): Promise<readonly SchematicFinding[]> {
    return (await this.build(ir, { ...options, createDocument: options.createDocument ?? true })).findings
  }

  /**
   * Archive the IR as a new project through the BETA
   * `importProjectByProjectFile` path: the engine serializes `CONFIG`/`SCH`/
   * `SCH_PAGE` logs in the client's persisted schema together with
   * project-local copies of the referenced device/symbol/footprint
   * documents, zips them as `.epro2`, imports, and read-back verifies every
   * attached page. Embedded copies are what make component graphics resolve;
   * a failed library fetch degrades that binding to `SCHEMATIC_IMPORT_LIBDOC`
   * rather than silently shipping an unrenderable record. The static seam
   * validator remains the delivery gate.
   * @param ir - the schematic IR to import.
   * @param options - bridge injection, project naming, and tab-close consent.
   * @returns imported project uuid, page uuids, and structured findings.
   */
  async importProject(ir: SchematicIr, options: EasyEdaEngineImportOptions = {}): Promise<EasyEdaImportReport> {
    const bridge = options.bridge ?? await HttpEasyEdaBridge.discover({
      host: this.config.bridgeHost,
      fetchFn: options.fetchFn,
      timeoutMs: this.config.bridgeTimeoutMs,
      timeoutStreakLimit: this.config.bridgeTimeoutStreakLimit,
      circuitCooldownMs: this.config.bridgeCircuitCooldownMs,
      autoSpawn: this.config.bridgeAutoSpawn,
    })
    return importIntoEasyEda(ir, {
      bridge,
      projectName: options.projectName,
      allowTabClose: options.allowTabClose,
      clientId: this.config.clientId,
      timeoutMs: options.timeoutMs,
      symbolPins: options.symbolPins,
    })
  }
}

/** Register the `easyeda` engine and workspace library with `ctx.schematic`. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  ctx.schematic.registerEngine(new EasyEdaSchematicEngine(resolved))
  ctx.schematic.registerLibrary(new EasyEdaLibrary({
    host: resolved.bridgeHost,
    timeoutMs: resolved.bridgeTimeoutMs,
    queryTimeoutMs: resolved.bridgeQueryTimeoutMs,
    timeoutStreakLimit: resolved.bridgeTimeoutStreakLimit,
    circuitCooldownMs: resolved.bridgeCircuitCooldownMs,
    autoSpawn: resolved.bridgeAutoSpawn,
    libraryUuid: resolved.libraryUuid,
  }))
}
