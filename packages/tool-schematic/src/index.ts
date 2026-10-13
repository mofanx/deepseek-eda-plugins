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
import { parseSchematicIr } from '@deepseek-ai/dsh-plugin-eda-sch'
import type { SchematicBindingResolution, SchematicFinding, SchematicIr } from '@deepseek-ai/dsh-plugin-eda-sch'
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
}

export const Config: z<Config> = z.object({
  maxPrimitives: z.number().default(5000),
  maxSheets: z.number().default(32),
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

const DOCUMENT_PARAM_DESCRIPTION =
  'Schematic IR document: { sheets: [{ components, wires, busEntries, junctions, attrs }] }. ' +
  'Components have { id, kind: "part"|"block"|"netflag"|"netport"|"sheet"|"nonelec"|"short", pins: [{ id, name, number, electric: "UNKNOWN"|"INPUT"|"OUTPUT"|"BI", net?, noConnect?, powerName?, endpoint?: {x,y} }] } ' +
  'plus optional deviceUuid/symbolUuid/footprintUuid (each with its owning-library scope deviceLibraryUuid/symbolLibraryUuid/footprintLibraryUuid — a scopeless binding is only an unverifiable warning, not a blocking miss), designator/netName/lcsc (LCSC part number resolved to library bindings when a workspace library is reachable). ' +
  'Declare connectivity with pin.net — the layout stage deterministically assigns positions, pin endpoints, and orthogonal wire or net-flag routing in 0.01-inch coordinates, so position/endpoint/dots may be omitted. ' +
  'Wires have { id, kind: "wire"|"bus", dots?: [[x1,y1,x2,y2,...]], net }.'

/**
 * Run the engine's live verification when requested. `verify: true` is an
 * explicit request for client-truth evidence, so a verification path that
 * cannot run or throws reports `SCHEMATIC_VERIFY_UNAVAILABLE` as an *error* —
 * the result must not claim a clean `ok` on evidence that never happened.
 */
async function liveVerify(ctx: Context, ir: SchematicIr, symbolPins?: SchematicBindingResolution['symbolPins']): Promise<readonly SchematicFinding[]> {
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
    return await engine.verify(ir, { symbolPins })
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
      verify: { type: 'boolean', description: 'Also deliver through the engine live path and read the document back; netlist diffs and build failures return as findings for repair. Requires a reachable client — when the live path cannot run, the result reports SCHEMATIC_VERIFY_UNAVAILABLE as an error rather than passing unverified.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          format: { type: 'string', required: true, description: 'Document-source format label emitted by the engine; empty when the gate blocked' },
          source: { type: 'string', required: true, description: 'Serialized document source text; empty when the gate blocked' },
          findings: FINDINGS_SCHEMA,
        },
      },
      render: (_args, value) =>
        value.source.length > 0
          ? [{ type: 'text', text: `Emitted ${value.format} document source (${value.source.length} chars).${value.findings.length === 0 ? '' : `\n${value.findings.map(findingText).join('\n')}`}` }]
          : renderReport('Static validation failed; repair the document and retry:', value.findings),
      presentationMeta: (_args, value) => ({ ok: value.ok, format: value.format, findings: value.findings.length }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const ir = parseSchematicIr(args.document)
      if (ir.sheets.length > config.maxSheets) {
        throw new HarnessError(`schematic document has ${ir.sheets.length} sheets, above the ${config.maxSheets} sheet cap`, 'SCHEMATIC_IR_BOUNDS')
      }
      const primitives = countPrimitives(ir)
      if (primitives > config.maxPrimitives) {
        throw new HarnessError(`schematic document has ${primitives} primitives, above the ${config.maxPrimitives} cap`, 'SCHEMATIC_IR_BOUNDS')
      }
      const { ir: bound, libraryResolver, symbolPins } = await ctx.schematic.resolveBindings(ir)
      const laid = ctx.schematic.layout(bound, { symbolPins })
      exec.signal.throwIfAborted()
      const report = ctx.schematic.validate(laid, { libraryResolver })
      if (!report.ok) return { ok: false, format: '', source: '', findings: report.findings.map(findingJson) }
      const engine = ctx.schematic.engine()
      const source = await engine.serialize(laid)
      const verifyFindings = args.verify === true ? await liveVerify(ctx, laid, symbolPins) : []
      return {
        ok: verifyFindings.every(f => f.severity !== 'error'),
        format: engine.id,
        source,
        findings: [...report.findings, ...verifyFindings].map(findingJson),
      }
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
      const ir = parseSchematicIr(args.document)
      if (ir.sheets.length > config.maxSheets) {
        throw new HarnessError(`schematic document has ${ir.sheets.length} sheets, above the ${config.maxSheets} sheet cap`, 'SCHEMATIC_IR_BOUNDS')
      }
      const primitives = countPrimitives(ir)
      if (primitives > config.maxPrimitives) {
        throw new HarnessError(`schematic document has ${primitives} primitives, above the ${config.maxPrimitives} cap`, 'SCHEMATIC_IR_BOUNDS')
      }
      exec.signal.throwIfAborted()
      const { ir: bound, libraryResolver, symbolPins } = await ctx.schematic.resolveBindings(ir)
      const laid = ctx.schematic.layout(bound, { symbolPins })
      const report = ctx.schematic.validate(laid, { libraryResolver })
      const verifyFindings = args.verify === true && report.ok ? await liveVerify(ctx, laid, symbolPins) : []
      return {
        ok: report.ok && verifyFindings.every(f => f.severity !== 'error'),
        findings: [...report.findings, ...verifyFindings].map(findingJson),
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
      : 'When the user asks to produce, emit, or check schematic primitives from a schematic IR document, call `schematic_generate` (validate-then-emit) or `schematic_validate` (validate only). Declare connectivity through pin.net names — the layout stage places and routes deterministically in 0.01-inch coordinates, so geometry fields may be omitted; every wire must declare its net name and every pin must carry NAME/NUMBER attributes. Pass verify: true to run the live-client netlist read-back when one is reachable. If either tool reports findings, repair the document and retry.',
  })
}
