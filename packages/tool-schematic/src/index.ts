/**
 * Model-facing schematic tools (`schematic_generate`, `schematic_validate`)
 * over the capability seam: parse the model's `document` JSON into the typed
 * IR, run the seam's authoritative static validator, then hand off to the
 * resolved engine's serializer. Seam error codes pass through to model-visible
 * output.
 * @module @deepseek-ai/dsh-plugin-eda-sch-gen
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SCHEMATIC_PAGE_A3, SCHEMATIC_PAGE_A4, parseSchematicIr, SchematicError } from '@deepseek-ai/dsh-plugin-eda-sch'
import type { SchematicBindingResolution, SchematicFinding, SchematicIr, SchematicPageSize, SchematicTitleBlockOptions } from '@deepseek-ai/dsh-plugin-eda-sch'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-schematic'

/** Tool registrations, the schematic seam, and the model system prompt. */
export const inject = ['tools', 'schematic', 'systemPrompt']

/** Hard caps applied before validation and emission. */
export interface Config {
  /** Maximum number of primitives across the whole IR document. */
  maxPrimitives?: number
  /** Maximum number of sheets in the IR document. */
  maxSheets?: number
  /** Maximum chars of emitted document source returned in one tool result; larger sources degrade to an omitted-source notice. */
  maxSourceChars?: number
  /**
   * Default page frame the layout plans against: `A3` (default — the production
   * module-board size the reference project uses, ~2× the A4 area so a dense
   * board paginates less) or `A4`. A per-call `pageSize` overrides it.
   */
  pageSize?: 'A3' | 'A4'
  /**
   * Default project title printed in each page's title block. When omitted the
   * title block falls back to the sheet name; a per-call `titleBlock` overrides.
   */
  projectTitle?: string
  /** Default company/owner cell of the title block. */
  company?: string
}

export const Config: z<Config> = z.object({
  maxPrimitives: z.number().default(5000),
  maxSheets: z.number().default(32),
  maxSourceChars: z.number().default(1_000_000),
  pageSize: z.union(['A3', 'A4']).default('A3'),
  projectTitle: z.string().default(''),
  company: z.string().default(''),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Count every id-carrying primitive in the document. */
function countPrimitives(ir: SchematicIr): number {
  let count = 0
  for (const sheet of ir.sheets) {
    count += sheet.components.length + sheet.wires.length + sheet.busEntries.length + sheet.attrs.length
    for (const component of sheet.components) count += component.pins.length
  }
  return count
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Resolve the page frame the layout plans against: the per-call choice wins,
 * then the configured default. The frame is what makes a dense board fit one
 * page instead of paginating, so it must reach the layout stage and the
 * serializer as the same size.
 */
function pageSizeFor(requested: unknown, config: ResolvedConfig): SchematicPageSize {
  const choice = requested === 'A4' || requested === 'A3' ? requested : config.pageSize
  return choice === 'A4' ? SCHEMATIC_PAGE_A4 : SCHEMATIC_PAGE_A3
}

/** Read one optional non-empty string field off an untrusted object. */
function textField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Resolve the title-block fields printed on every page frame: per-call values
 * win, then the configured defaults. An empty result leaves the engine's own
 * defaults in place (project title, `V0.1`, empty company/date).
 */
function titleBlockFor(requested: unknown, config: ResolvedConfig): SchematicTitleBlockOptions {
  const source = typeof requested === 'object' && requested !== null ? requested as Record<string, unknown> : {}
  return {
    projectTitle: textField(source, 'projectTitle') ?? (config.projectTitle === '' ? undefined : config.projectTitle),
    version: textField(source, 'version'),
    company: textField(source, 'company') ?? (config.company === '' ? undefined : config.company),
    date: textField(source, 'date'),
  }
}

const PAGE_SIZE_PARAM_DESCRIPTION =
  'Page frame the layout plans against: "A3" (1655×1170, the production module-board size) or "A4" (1170×825). ' +
  'Defaults to the configured size. Geometry is placed and validated against this frame, so it must match the sheet the design targets.'

const TITLE_BLOCK_PARAM_DESCRIPTION =
  'Title-block fields printed in each page\'s border: { projectTitle?, version?, company?, date? }. ' +
  'The page name, page number, and page count are filled in per page automatically.'

/** JSON-canonical projection of one validator finding, matching `FINDINGS_SCHEMA`. */
interface FindingJson {
  severity: string
  code: string
  message: string
  locator?: JsonValue
  suggestion?: string
}

/** Project one finding into the tool-output value shape (defined fields only). */
function findingJson(finding: SchematicFinding): FindingJson {
  /* v8 ignore start -- the validator always emits a locator today; the seam tolerates its absence for forward compatibility */
  const locator = finding.locator === undefined
    ? undefined
    : Object.fromEntries(Object.entries(finding.locator).filter(([, value]) => value !== undefined))
  /* v8 ignore stop */
  return {
    severity: finding.severity,
    code: finding.code,
    message: finding.message,
    /* v8 ignore next -- locator is defined for all current findings; tolerated for forward compatibility */
    ...locator !== undefined ? { locator } : {},
    ...finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {},
  }
}

/** Project one finding into the model-facing line used by render and tests. */
function findingText(finding: {
  severity: string
  code: string
  message: string
  locator?: unknown
  suggestion?: string
}): string {
  const where = finding.locator === undefined ? '' : ` at ${JSON.stringify(finding.locator)}`
  const fix = finding.suggestion === undefined || finding.suggestion.length === 0 ? '' : ` (${finding.suggestion})`
  return `[${finding.severity} ${finding.code}]${where} ${finding.message}${fix}`
}

/**
 * Parse the `document` argument, tolerating the model's double-encoding into a
 * JSON string. A parse or shape failure becomes a repairable error finding
 * instead of a thrown exception, so the model sees the same finding vocabulary
 * it repairs validation failures against.
 */
function parseDocument(document: unknown): { ir: SchematicIr; stringified: boolean } | { failure: FindingJson } {
  try {
    return { ir: parseSchematicIr(document), stringified: typeof document === 'string' }
  } catch (error) {
    /* v8 ignore start -- parseSchematicIr only throws SchematicError; other throws are bugs and must propagate */
    if (!(error instanceof SchematicError)) throw error
    /* v8 ignore stop */
    return {
      failure: {
        severity: 'error',
        code: error.code,
        message: error.message,
        suggestion: 'fix the value at the reported path and resend the document',
      },
    }
  }
}

/** Warning finding teaching the model to stop JSON-encoding the document argument. */
function stringifiedNote(document: unknown): readonly SchematicFinding[] {
  return typeof document === 'string'
    ? [{
      severity: 'warning',
      code: 'SCHEMATIC_IR_STRING_ENCODED',
      message: `document arrived as a JSON-encoded string (${document.length} chars) and was parsed`,
      suggestion: 'pass the document object itself, not its JSON text',
    }]
    : []
}

const DOCUMENT_PARAM_DESCRIPTION =
  'Schematic IR document: { sheets: [{ name?, blocks?, components, wires, busEntries, junctions, attrs }] }. ' +
  'Pass the object itself — a JSON-encoded string is tolerated but flagged SCHEMATIC_IR_STRING_ENCODED. ' +
  'A sheet may carry name (page title) and blocks: [{ name, title? }] — declared functional modules in display order. ' +
  'Components have { id, kind: "part"|"block"|"netflag"|"netport"|"sheet"|"nonelec"|"short", block?, pins: [{ id, name, number, electric: "UNKNOWN"|"INPUT"|"OUTPUT"|"BI", net?, noConnect?, powerName?, endpoint?: {x,y} }] } ' +
  'where block names the component\'s functional module (a sheet.blocks name or a free-form label; same-module components cluster together and inter-module nets route through flags). ' +
  'plus optional deviceUuid/symbolUuid/footprintUuid (each with its owning-library scope deviceLibraryUuid/symbolLibraryUuid/footprintLibraryUuid — a scopeless binding is only an unverifiable warning, not a blocking miss), designator/netName/lcsc (LCSC part number resolved to library bindings when a workspace library is reachable). ' +
  'Declare connectivity with pin.net — the layout stage deterministically assigns positions, pin endpoints, and orthogonal wire or net-flag routing in 0.01-inch coordinates, so position/endpoint/dots may be omitted. ' +
  'All geometry must stay inside the page frame the layout plans against (A3 1655×1170 by default, A4 1170×825 when selected); layout packs modules within it and paginates overflow onto extra sheets — authored geometry outside the frame fails OBJECT_OUT_OF_SHEET. ' +
  'Wires have { id, kind: "wire"|"bus", dots?: [[x1,y1,x2,y2,...]], net }. ' +
  'A shape violation returns SCHEMATIC_IR_INVALID naming the failing path and the received value — fix that field and resend.'

/**
 * Run the engine's live verification when requested. `verify: true` is an
 * explicit request for client-truth evidence, so a verification path that
 * cannot run or throws reports `SCHEMATIC_VERIFY_UNAVAILABLE` as an *error* —
 * the result must not claim a clean `ok` on evidence that never happened.
 */
async function liveVerify(
  ctx: Context,
  ir: SchematicIr,
  symbolPins?: SchematicBindingResolution['symbolPins'],
  pageSize?: SchematicPageSize,
  titleBlock?: SchematicTitleBlockOptions,
): Promise<readonly SchematicFinding[]> {
  let engine
  try {
    engine = ctx.schematic.engine()
  } catch (error) {
    return [{
      code: 'SCHEMATIC_VERIFY_UNAVAILABLE',
      severity: 'error',
      message: `live verification skipped: ${error instanceof Error ? error.message : String(error)}`,
    }]
  }
  if (engine.verify === undefined) {
    return [{
      code: 'SCHEMATIC_VERIFY_UNAVAILABLE',
      severity: 'error',
      message: `engine "${engine.id}" exposes no live verification path`,
    }]
  }
  try {
    return await engine.verify(ir, { symbolPins, pageSize, titleBlock })
  } catch (error) {
    return [{
      code: 'SCHEMATIC_VERIFY_UNAVAILABLE',
      severity: 'error',
      message: `live verification failed: ${error instanceof Error ? error.message : String(error)}`,
    }]
  }
}

const FINDINGS_SCHEMA = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      severity: { type: 'string', required: true, description: "'error' blocks delivery; 'warning' reports only" },
      code: { type: 'string', required: true, description: 'Stable rule code, e.g. FLOATING_INPUT_PIN' },
      message: { type: 'string', required: true },
      locator: { type: 'json', description: 'IR location (sheetIndex, componentId, designator, pinId, pinNumber, net, x, y)' },
      suggestion: { type: 'string', description: 'Actionable fix hint' },
    },
  },
} as const

function renderReport(okWord: string, findings: readonly FindingJson[]): ContentBlock[] {
  const lines = findings.map(findingText)
  return [{ type: 'text', text: lines.length === 0 ? okWord : `${okWord}\n${lines.join('\n')}` }]
}

function applyGenerateTool(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'schematic_generate',
    description: 'Generate schematic document source from a schematic IR document. Runs the full static-validation gate (connectivity, electrical sanity, device/symbol/footprint binding, net naming, format invariants); on pass, serializes via the selected engine and returns the document source. On fail, returns the findings so you can repair and retry. Pass verify: true to additionally deliver through a live client and diff the read-back netlist.',
    parameters: {
      document: { type: 'json', required: true, description: DOCUMENT_PARAM_DESCRIPTION },
      pageSize: { type: 'string', description: PAGE_SIZE_PARAM_DESCRIPTION },
      titleBlock: { type: 'json', description: TITLE_BLOCK_PARAM_DESCRIPTION },
      verify: { type: 'boolean', description: 'Also deliver through the engine live path and read the document back; netlist diffs and build failures return as findings for repair. Requires a reachable client — when the live path cannot run, the result reports SCHEMATIC_VERIFY_UNAVAILABLE as an error rather than passing unverified.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          format: { type: 'string', required: true, description: 'Document-source format label emitted by the engine; empty when the gate blocked' },
          source: { type: 'string', required: true, description: 'Serialized document source text; empty when the gate blocked or the source exceeded the result cap' },
          sourceBytes: { type: 'number', required: true, description: 'Full emitted source length in chars; greater than source.length when the source was omitted over the cap' },
          findings: FINDINGS_SCHEMA,
        },
      },
      render: (_args, value) =>
        value.source.length > 0
          ? [{ type: 'text', text: `Emitted ${value.format} document source (${value.sourceBytes} chars).${value.findings.length === 0 ? '' : `\n${value.findings.map(findingText).join('\n')}`}` }]
          : value.sourceBytes > 0
            ? [{ type: 'text', text: `Emitted ${value.format} document source (${value.sourceBytes} chars); over the result cap — source text omitted.\n${value.findings.map(findingText).join('\n')}` }]
            : renderReport('Static validation failed; repair the document and retry:', value.findings),
      presentationMeta: (_args, value) => ({ ok: value.ok, format: value.format, findings: value.findings.length, sourceBytes: value.sourceBytes }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parsed = parseDocument(args.document)
      if ('failure' in parsed) return { ok: false, format: '', source: '', sourceBytes: 0, findings: [parsed.failure] }
      const ir = parsed.ir
      if (ir.sheets.length > config.maxSheets) {
        throw new HarnessError(`schematic document has ${ir.sheets.length} sheets, above the ${config.maxSheets} sheet cap`, 'SCHEMATIC_IR_BOUNDS')
      }
      const primitives = countPrimitives(ir)
      if (primitives > config.maxPrimitives) {
        throw new HarnessError(`schematic document has ${primitives} primitives, above the ${config.maxPrimitives} cap`, 'SCHEMATIC_IR_BOUNDS')
      }
      const { ir: bound, libraryResolver, symbolPins } = await ctx.schematic.resolveBindings(ir)
      const pageSize = pageSizeFor(args.pageSize, config)
      const titleBlock = titleBlockFor(args.titleBlock, config)
      const laid = ctx.schematic.layout(bound, { symbolPins, pageSize })
      exec.signal.throwIfAborted()
      const report = ctx.schematic.validate(laid, { libraryResolver })
      const notes = stringifiedNote(args.document)
      if (!report.ok) return { ok: false, format: '', source: '', sourceBytes: 0, findings: [...notes, ...report.findings].map(findingJson) }
      const engine = ctx.schematic.engine()
      const source = await engine.serialize(laid, { pageSize, titleBlock })
      const verifyFindings = args.verify === true ? await liveVerify(ctx, laid, symbolPins, pageSize, titleBlock) : []
      const ok = verifyFindings.every(f => f.severity !== 'error')
      const findings = [...notes, ...report.findings, ...verifyFindings]
      if (source.length > config.maxSourceChars) {
        const delivered = args.verify === true
        const notice: SchematicFinding = {
          severity: delivered ? 'warning' : 'error',
          code: 'SCHEMATIC_SOURCE_TOO_LARGE',
          message: `emitted document source is ${source.length} chars, above the ${config.maxSourceChars}-char result cap — the source text is omitted from this result`,
          suggestion: delivered
            ? 'the document was already delivered through the live client; no in-band source is needed'
            : 're-run with verify: true to deliver through the live client, or reduce the document size',
        }
        return { ok: ok && delivered, format: engine.id, source: '', sourceBytes: source.length, findings: [...findings, notice].map(findingJson) }
      }
      return { ok, format: engine.id, source, sourceBytes: source.length, findings: findings.map(findingJson) }
    },
    presentCall: () => ({ card: 'generic', title: 'Generate schematic source' }),
    presentResult: (_args, result) => {
      const meta = result.meta
      if (typeof meta !== 'object' || meta === null || !('ok' in meta)) return undefined
      return { card: 'generic', title: meta.ok === true ? 'Schematic source emitted' : 'Schematic validation failed' }
    },
  }))
}

function applyValidateTool(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'schematic_validate',
    description: 'Statically validate a schematic IR document without emitting anything — the same authoritative gate that schematic_generate runs (connectivity, electrical sanity, device/symbol/footprint binding, net naming, format invariants). Returns ok plus every finding with a stable rule code, locator, and fix suggestion. Pass verify: true to additionally diff the live client read-back netlist.',
    parameters: {
      document: { type: 'json', required: true, description: DOCUMENT_PARAM_DESCRIPTION },
      pageSize: { type: 'string', description: PAGE_SIZE_PARAM_DESCRIPTION },
      verify: { type: 'boolean', description: 'Also deliver through the engine live path and read the document back; netlist diffs and build failures return as findings for repair. Requires a reachable client — when the live path cannot run, the result reports SCHEMATIC_VERIFY_UNAVAILABLE as an error rather than passing unverified.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          findings: FINDINGS_SCHEMA,
        },
      },
      render: (_args, value) =>
        value.ok
          ? renderReport(`Schematic IR is valid${value.findings.length === 0 ? '.' : ` (${value.findings.length} warning(s)):`}`, value.findings)
          : renderReport('Static validation failed; repair the document and retry:', value.findings),
      presentationMeta: (_args, value) => ({ ok: value.ok, findings: value.findings.length }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parsed = parseDocument(args.document)
      if ('failure' in parsed) return { ok: false, findings: [parsed.failure] }
      const ir = parsed.ir
      if (ir.sheets.length > config.maxSheets) {
        throw new HarnessError(`schematic document has ${ir.sheets.length} sheets, above the ${config.maxSheets} sheet cap`, 'SCHEMATIC_IR_BOUNDS')
      }
      const primitives = countPrimitives(ir)
      if (primitives > config.maxPrimitives) {
        throw new HarnessError(`schematic document has ${primitives} primitives, above the ${config.maxPrimitives} cap`, 'SCHEMATIC_IR_BOUNDS')
      }
      exec.signal.throwIfAborted()
      const { ir: bound, libraryResolver, symbolPins } = await ctx.schematic.resolveBindings(ir)
      const pageSize = pageSizeFor(args.pageSize, config)
      const laid = ctx.schematic.layout(bound, { symbolPins, pageSize })
      const report = ctx.schematic.validate(laid, { libraryResolver })
      const verifyFindings = args.verify === true && report.ok ? await liveVerify(ctx, laid, symbolPins, pageSize) : []
      return {
        ok: report.ok && verifyFindings.every(f => f.severity !== 'error'),
        findings: [...stringifiedNote(args.document), ...report.findings, ...verifyFindings].map(findingJson),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Validate schematic' }),
    presentResult: (_args, result) => {
      const meta = result.meta
      if (typeof meta !== 'object' || meta === null || !('ok' in meta)) return undefined
      return { card: 'generic', title: meta.ok === true ? 'Schematic valid' : 'Schematic validation failed' }
    },
  }))
}

/** Register both schematic tools and the model-facing prompt guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  applyGenerateTool(ctx, resolved)
  applyValidateTool(ctx, resolved)
  ctx.systemPrompt.section({
    name: 'tool:schematic',
    // 2500 == TOOL_SCHEMATIC in the host's PromptSectionOrder map; the published
    // system-prompt build predates getSectionOrder, so the literal is required
    // until a release exposing it lands.
    order: 2500,
    text: ({ scope }) => ctx.tools.get('schematic_generate', scope) === undefined && ctx.tools.get('schematic_validate', scope) === undefined
      ? ''
      : 'When the user asks to produce, emit, or check schematic primitives from a schematic IR document, call `schematic_generate` (validate-then-emit) or `schematic_validate` (validate only). Declare connectivity through pin.net names — the layout stage places and routes deterministically in 0.01-inch coordinates, so geometry fields may be omitted; every wire must declare its net name and every pin must carry NAME/NUMBER attributes. Tag each component\'s functional module via component.block (e.g. "power", "mcu-core", "clock", "reset", "io"; custom names are fine) and list them on sheets[].blocks so modules cluster under labelled frames; a design beyond roughly 20 parts should split into multiple sheets, one module per page, with sheets[].name set. All geometry stays inside the selected page frame (A3 1655×1170 by default, or A4 1170×825 via pageSize) — overflowing module grids paginate automatically, and authored geometry outside the frame fails OBJECT_OUT_OF_SHEET. Each page gets a drawn border and title block; pass titleBlock { projectTitle, version, company, date } to fill it, or pageSize to pick the frame. Pass verify: true to run the live-client netlist read-back when one is reachable. If either tool reports findings, repair the document and retry.',
  })
}
