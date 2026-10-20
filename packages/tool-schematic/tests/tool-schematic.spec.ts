import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult, type ToolResult } from '@deepseek-ai/dsh-tools'
import SchematicRuntime from '@deepseek-ai/dsh-plugin-eda-sch'
import type { SchematicEngine, SchematicLibrary } from '@deepseek-ai/dsh-plugin-eda-sch'
import { serializeEasyEdaDocument } from '@deepseek-ai/dsh-plugin-eda-easyeda'
import * as ToolSchematic from '@deepseek-ai/dsh-plugin-eda-sch-gen'

const testToolSignal = new AbortController().signal

const stubEngine: SchematicEngine = {
  id: 'stub',
  available: () => true,
  serialize: ir => `EMITTED(${ir.sheets.length})`,
}

const validDoc = {
  sheets: [{
    components: [
      {
        id: 'c1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 },
        deviceUuid: 'dev', symbolUuid: 'sym', footprintUuid: 'fp',
        pins: [{ id: 'p1', name: 'O', number: '1', electric: 'OUTPUT', endpoint: { x: 0, y: 0 } }],
      },
      {
        id: 'c2', kind: 'part', designator: 'U2', position: { x: 10, y: 0 },
        deviceUuid: 'dev', symbolUuid: 'sym', footprintUuid: 'fp',
        pins: [{ id: 'p2', name: 'I', number: '1', electric: 'INPUT', endpoint: { x: 10, y: 0 } }],
      },
    ],
    wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
    busEntries: [], junctions: [], attrs: [],
  }],
}

const invalidDoc = {
  sheets: [{
    components: [{
      id: 'c1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 },
      deviceUuid: 'dev', symbolUuid: 'sym', footprintUuid: 'fp',
      pins: [{ id: 'p1', name: 'I', number: '1', electric: 'INPUT', endpoint: { x: 0, y: 0 } }],
    }],
    wires: [], busEntries: [], junctions: [], attrs: [],
  }],
}

/** Valid document whose only findings are warnings (UNKNOWN electric type, single-pin net). */
const warningDoc = {
  sheets: [{
    components: [{
      id: 'c1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 },
      deviceUuid: 'dev', symbolUuid: 'sym', footprintUuid: 'fp',
      pins: [{ id: 'p1', name: 'O', number: '1', electric: 'UNKNOWN', endpoint: { x: 0, y: 0 } }],
    }],
    wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
    busEntries: [], junctions: [], attrs: [],
  }],
}

/** A valid document whose parts declare LCSC part numbers instead of UUID bindings. */
const lcscDoc = {
  sheets: [{
    components: [
      {
        id: 'c1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 }, lcsc: 'C25804',
        pins: [{ id: 'p1', name: 'O', number: '1', electric: 'OUTPUT', endpoint: { x: 0, y: 0 } }],
      },
      {
        id: 'c2', kind: 'part', designator: 'U2', position: { x: 10, y: 0 }, lcsc: 'C25804',
        pins: [{ id: 'p2', name: 'I', number: '1', electric: 'INPUT', endpoint: { x: 10, y: 0 } }],
      },
    ],
    wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
    busEntries: [], junctions: [], attrs: [],
  }],
}

/** A scripted workspace library whose LCSC lookup returns real bindings. */
const lcscLibrary: SchematicLibrary = {
  id: 'mock',
  resolveDevice: async () => ({}),
  resolveSymbol: async () => ({}),
  resolveFootprint: async () => ({}),
  resolveByLcsc: async () => ({ deviceUuid: 'dev-lcsc', symbolUuid: 'sym-lcsc', footprintUuid: 'fp-lcsc' }),
}

/** Mount the real registry, seam, engine, and tools; return an executor helper. */
async function mountTools(
  options: { config?: Record<string, unknown>; engine?: SchematicEngine | false } = {},
): Promise<{ ctx: Context; call: (name: string, args: unknown) => Promise<ToolExecutionResult> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SchematicRuntime, {})
  if (options.engine !== false) ctx.schematic.registerEngine(options.engine ?? stubEngine)
  await ctx.plugin(ToolSchematic, options.config ?? {})
  let counter = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId(`call-${++counter}`), name, arguments: args })
  return { ctx, call }
}

describe('schematic_generate', () => {
  it('validates then serializes through the selected engine', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_generate', { document: validDoc })
    expect(out.isError).toBe(false)
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('Emitted stub document source')
  })

  it('blocks on validation findings and returns them for repair', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_generate', { document: invalidDoc })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('Static validation failed')
    expect(text).toContain('FLOATING_INPUT_PIN')
  })

  it('returns a repairable finding for a malformed document argument', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_generate', { document: 'nope' })
    expect(out.isError).toBe(false)
    const value = out.value as { ok: boolean; findings: { code: string; message: string; suggestion?: string }[] }
    expect(value.ok).toBe(false)
    expect(value.findings[0]).toMatchObject({ severity: 'error', code: 'SCHEMATIC_IR_INVALID' })
    expect(value.findings[0]!.message).toContain('4-char string')
    expect(value.findings[0]!.suggestion).toContain('reported path')
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('SCHEMATIC_IR_INVALID')
  })

  it('diagnoses a non-string non-object document with its received type', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_validate', { document: 42 })
    expect(out.isError).toBe(false)
    const value = out.value as { ok: boolean; findings: { code: string; message: string }[] }
    expect(value.ok).toBe(false)
    expect(value.findings[0]!.code).toBe('SCHEMATIC_IR_INVALID')
    expect(value.findings[0]!.message).toContain('received a number')
  })

  it('accepts a JSON-encoded document string and flags the double encoding', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_generate', { document: JSON.stringify(validDoc) })
    expect(out.isError).toBe(false)
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('Emitted stub document source')
    expect(text).toContain('SCHEMATIC_IR_STRING_ENCODED')
    const validate = await call('schematic_validate', { document: JSON.stringify(validDoc) })
    const validateText = validate.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(validateText).toContain('Schematic IR is valid')
    expect(validateText).toContain('SCHEMATIC_IR_STRING_ENCODED')
  })

  it('degrades an oversized emitted source to an omitted-source notice', async () => {
    const { call } = await mountTools({
      config: { maxSourceChars: 10 },
      engine: { id: 'big', available: () => true, serialize: () => 'X'.repeat(50) },
    })
    const out = await call('schematic_generate', { document: validDoc })
    expect(out.isError).toBe(false)
    const value = out.value as { ok: boolean; source: string; sourceBytes: number; findings: { code: string; severity: string }[] }
    expect(value).toMatchObject({ ok: false, source: '', sourceBytes: 50 })
    const notice = value.findings.find(f => f.code === 'SCHEMATIC_SOURCE_TOO_LARGE')
    expect(notice?.severity).toBe('error')
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('over the result cap')
    expect(text).toContain('SCHEMATIC_SOURCE_TOO_LARGE')
  })

  it('keeps ok when an oversized source was already delivered through verify: true', async () => {
    const { call } = await mountTools({
      config: { maxSourceChars: 10 },
      engine: {
        id: 'big', available: () => true,
        serialize: () => 'X'.repeat(50),
        verify: async () => [],
      },
    })
    const out = await call('schematic_generate', { document: validDoc, verify: true })
    expect(out.isError).toBe(false)
    const value = out.value as { ok: boolean; source: string; sourceBytes: number; findings: { code: string; severity: string }[] }
    expect(value).toMatchObject({ ok: true, source: '', sourceBytes: 50 })
    expect(value.findings.find(f => f.code === 'SCHEMATIC_SOURCE_TOO_LARGE')?.severity).toBe('warning')
  })

  it('emits source while carrying warning findings', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_generate', { document: warningDoc })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('Emitted stub document source')
    expect(text).toContain('ELECTRIC_TYPE_UNKNOWN')
  })

  it('rejects a document above the sheet or primitive caps', async () => {
    const { call } = await mountTools({ config: { maxSheets: 0 } })
    const sheetOut = await call('schematic_generate', { document: validDoc })
    expect(sheetOut.isError).toBe(true)
    expect(sheetOut.error?.info?.code).toBe('SCHEMATIC_IR_BOUNDS')

    const { call: callCapped } = await mountTools({ config: { maxPrimitives: 1 } })
    const primOut = await callCapped('schematic_validate', { document: validDoc })
    expect(primOut.isError).toBe(true)
    expect(primOut.error?.info?.code).toBe('SCHEMATIC_IR_BOUNDS')

    const { call: callSheetCapped } = await mountTools({ config: { maxSheets: 0 } })
    const validateOut = await callSheetCapped('schematic_validate', { document: validDoc })
    expect(validateOut.isError).toBe(true)
    expect(validateOut.error?.info?.code).toBe('SCHEMATIC_IR_BOUNDS')
  })

  it('fails loudly when no usable engine is registered', async () => {
    const { call } = await mountTools({ engine: false })
    const out = await call('schematic_generate', { document: validDoc })
    expect(out.isError).toBe(true)
    expect(out.error?.info?.code).toBe('SCHEMATIC_ENGINE_UNAVAILABLE')
  })
})

describe('schematic_validate', () => {
  it('reports ok on a valid document', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_validate', { document: validDoc })
    expect(out.isError).toBe(false)
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('Schematic IR is valid')
  })

  it('reports findings without emitting anything', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_validate', { document: invalidDoc })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('FLOATING_INPUT_PIN')
    expect(text).not.toContain('Emitted')
  })

  it('renders warning findings under an ok verdict', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_validate', { document: warningDoc })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('warning(s)')
    expect(text).toContain('ELECTRIC_TYPE_UNKNOWN')
    expect(text).toContain('SINGLE_PIN_NET')
  })

  it('serializes a finding that carries no suggestion', async () => {
    const doc = {
      sheets: [{
        components: [], busEntries: [], junctions: [], attrs: [],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 1, 0]], net: 'X', groupId: '0' }],
      }],
    }
    const { call } = await mountTools()
    const out = await call('schematic_validate', { document: doc })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('FORMAT_GROUP_ID')
  })
})

describe('tool projections and presenters', () => {
  it('renders findings that carry neither locator nor suggestion', async () => {
    const { ctx } = await mountTools()
    const bare = { severity: 'warning', code: 'W_BARE', message: 'unlocated' }
    const gen = ctx.tools.get('schematic_generate')
    const blocks = gen?.output.render({}, { ok: true, format: 'stub', source: 'x', sourceBytes: 1, findings: [bare, { ...bare, suggestion: '' }] })
    const text = blocks?.[0]?.type === 'text' ? blocks[0].text : ''
    expect(text).toContain('[warning W_BARE] unlocated')
    expect(text).not.toContain('()')

    const val = ctx.tools.get('schematic_validate')
    const failed = val?.output.render({}, { ok: false, findings: [bare] })
    expect(failed?.[0]?.type === 'text' ? failed[0].text : '').toContain('Static validation failed')
  })

  it('renders the clean verdicts when no findings exist', async () => {
    const { ctx } = await mountTools()
    const gen = ctx.tools.get('schematic_generate')
    const genBlocks = gen?.output.render({}, { ok: true, format: 'stub', source: 'abc', sourceBytes: 3, findings: [] })
    expect(genBlocks?.[0]?.type === 'text' ? genBlocks[0].text : '').toBe('Emitted stub document source (3 chars).')
    const capped = gen?.output.render({}, { ok: true, format: 'stub', source: '', sourceBytes: 50, findings: [{ severity: 'warning', code: 'SCHEMATIC_SOURCE_TOO_LARGE', message: 'omitted' }] })
    expect(capped?.[0]?.type === 'text' ? capped[0].text : '').toContain('over the result cap')
    const val = ctx.tools.get('schematic_validate')
    const valBlocks = val?.output.render({}, { ok: true, findings: [] })
    expect(valBlocks?.[0]?.type === 'text' ? valBlocks[0].text : '').toBe('Schematic IR is valid.')
  })

  it('projects presentationMeta for both tools', async () => {
    const { ctx } = await mountTools()
    const gen = ctx.tools.get('schematic_generate')
    expect(gen?.output.presentationMeta?.({}, { ok: true, format: 'stub', sourceBytes: 7, findings: [{}, {}] }))
      .toEqual({ ok: true, format: 'stub', findings: 2, sourceBytes: 7 })
    const val = ctx.tools.get('schematic_validate')
    expect(val?.output.presentationMeta?.({}, { ok: false, findings: [{}] }))
      .toEqual({ ok: false, findings: 1 })
  })

  it('exposes generic call/result views and concurrency safety', async () => {
    const { ctx } = await mountTools()
    const gen = ctx.tools.get('schematic_generate')
    const val = ctx.tools.get('schematic_validate')
    expect(gen?.isConcurrencySafe?.({ document: validDoc })).toBe(true)
    expect(val?.isConcurrencySafe?.({ document: validDoc })).toBe(true)
    expect(gen?.presentCall?.({ document: validDoc })).toMatchObject({ card: 'generic', title: 'Generate schematic source' })
    expect(val?.presentCall?.({ document: validDoc })).toMatchObject({ card: 'generic', title: 'Validate schematic' })
    const args = { document: validDoc }
    const result = (meta: ToolResult['meta']) => meta === undefined
      ? { content: [], isError: false }
      : { content: [], isError: false, meta }
    expect(gen?.presentResult?.(args, result({ ok: true }))).toMatchObject({ title: 'Schematic source emitted' })
    expect(gen?.presentResult?.(args, result({ ok: false }))).toMatchObject({ title: 'Schematic validation failed' })
    expect(val?.presentResult?.(args, result({ ok: true }))).toMatchObject({ title: 'Schematic valid' })
    expect(val?.presentResult?.(args, result({ ok: false }))).toMatchObject({ title: 'Schematic validation failed' })
    for (const meta of [undefined, null, 'x', {}]) {
      expect(gen?.presentResult?.(args, result(meta))).toBeUndefined()
      expect(val?.presentResult?.(args, result(meta))).toBeUndefined()
    }
  })
})

describe('library binding resolution', () => {
  it('serializes UUID bindings resolved from lcsc declarations', async () => {
    const { ctx, call } = await mountTools({
      engine: {
        id: 'stub',
        available: () => true,
        serialize: ir => ir.sheets[0]!.components.map(c => `${c.deviceUuid}/${c.symbolUuid}/${c.footprintUuid}`).join(','),
      },
    })
    ctx.schematic.registerLibrary(lcscLibrary)
    const out = await call('schematic_generate', { document: lcscDoc })
    expect(out.isError).toBe(false)
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('Emitted stub document source')
  })

  it('passes the resolved bindings to the engine serializer', async () => {
    const seen: string[] = []
    const spyEngine: SchematicEngine = {
      id: 'spy',
      available: () => true,
      serialize: (ir) => {
        const component = ir.sheets[0]!.components[0]!
        seen.push(`${component.deviceUuid},${component.symbolUuid},${component.footprintUuid}`)
        return 'src'
      },
    }
    const { ctx, call } = await mountTools({ engine: spyEngine })
    ctx.schematic.registerLibrary(lcscLibrary)
    const out = await call('schematic_generate', { document: lcscDoc })
    expect(out.isError).toBe(false)
    expect(seen).toEqual(['dev-lcsc,sym-lcsc,fp-lcsc'])
  })

  it('degrades to unreachable warnings when the library throws', async () => {
    const { ctx, call } = await mountTools()
    ctx.schematic.registerLibrary({
      id: 'dead',
      resolveDevice: async () => { throw new Error('bridge down') },
      resolveSymbol: async () => { throw new Error('bridge down') },
      resolveFootprint: async () => { throw new Error('bridge down') },
      resolveByLcsc: async () => { throw new Error('bridge down') },
    })
    const out = await call('schematic_validate', { document: lcscDoc })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('LCSC part "C25804"')
  })

  it('reports an LCSC miss as a blocking BINDING_UNRESOLVED', async () => {
    const { ctx, call } = await mountTools()
    ctx.schematic.registerLibrary({ ...lcscLibrary, resolveByLcsc: async () => undefined })
    const out = await call('schematic_validate', { document: lcscDoc })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('Static validation failed')
    expect(text).toContain('BINDING_UNRESOLVED')
  })
})

describe('live verification (verify: true)', () => {
  const verifyingEngine = (findings: readonly { code: string; severity: 'error' | 'warning'; message: string }[]): SchematicEngine => ({
    id: 'stub',
    available: () => true,
    serialize: () => 'src',
    verify: async () => findings,
  })

  it('merges verify findings into validate and blocks on error severity', async () => {
    const { call } = await mountTools({
      engine: verifyingEngine([{ code: 'SCHEMATIC_NETLIST_WRONG_NET', severity: 'error', message: 'pin u1:p1 sits on OTHER' }]),
    })
    const out = await call('schematic_validate', { document: validDoc, verify: true })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('SCHEMATIC_NETLIST_WRONG_NET')
    expect(text).toContain('Static validation failed')
  })

  it('blocks ok on a verify error while the emitted source stays inspectable', async () => {
    const { call } = await mountTools({
      engine: verifyingEngine([{ code: 'SCHEMATIC_NETLIST_DROPPED', severity: 'error', message: 'no geometry' }]),
    })
    const out = await call('schematic_generate', { document: validDoc, verify: true })
    expect((out.value as { ok: boolean; source: string })).toMatchObject({ ok: false, source: 'src' })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('Emitted stub document source')
    expect(text).toContain('SCHEMATIC_NETLIST_DROPPED')
  })

  it('keeps ok when verify returns warnings only', async () => {
    const { call } = await mountTools({
      engine: verifyingEngine([{ code: 'SCHEMATIC_EDA_DRC', severity: 'warning', message: 'client drc detail' }]),
    })
    const out = await call('schematic_validate', { document: validDoc, verify: true })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('Schematic IR is valid')
    expect(text).toContain('SCHEMATIC_EDA_DRC')
  })

  it('fails ok with SCHEMATIC_VERIFY_UNAVAILABLE when the engine has no live path', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_validate', { document: validDoc, verify: true })
    expect((out.value as { ok: boolean }).ok).toBe(false)
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('[error SCHEMATIC_VERIFY_UNAVAILABLE]')
    expect(text).toContain('no live verification path')
  })

  it('fails ok with SCHEMATIC_VERIFY_UNAVAILABLE when verify throws', async () => {
    const { call } = await mountTools({
      engine: {
        id: 'stub', available: () => true, serialize: () => 'src',
        verify: async () => { throw new Error('bridge down') },
      },
    })
    const out = await call('schematic_validate', { document: validDoc, verify: true })
    expect((out.value as { ok: boolean }).ok).toBe(false)
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('[error SCHEMATIC_VERIFY_UNAVAILABLE]')
    expect(text).toContain('bridge down')
  })

  it('fails ok with SCHEMATIC_VERIFY_UNAVAILABLE when no engine resolves', async () => {
    const { call } = await mountTools({ engine: false })
    const out = await call('schematic_validate', { document: validDoc, verify: true })
    expect((out.value as { ok: boolean }).ok).toBe(false)
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('SCHEMATIC_VERIFY_UNAVAILABLE')
    expect(text).toContain('skipped')
  })

  it('stringifies non-Error failures from engine resolution and verify', async () => {
    const { ctx, call } = await mountTools()
    vi.spyOn(ctx.schematic, 'engine').mockImplementation(() => { throw 'flat resolve' })
    const out = await call('schematic_validate', { document: validDoc, verify: true })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('SCHEMATIC_VERIFY_UNAVAILABLE')
    expect(text).toContain('flat resolve')

    const { call: callThrower } = await mountTools({
      engine: {
        id: 'stub', available: () => true, serialize: () => 'src',
        verify: async () => { throw 'flat verify' },
      },
    })
    const verifyOut = await callThrower('schematic_validate', { document: validDoc, verify: true })
    const verifyText = verifyOut.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(verifyText).toContain('flat verify')
  })

  it('emitted source stays inspectable when verification could not run', async () => {
    const { call } = await mountTools({
      engine: { id: 'stub', available: () => true, serialize: () => 'src' },
    })
    const out = await call('schematic_generate', { document: validDoc, verify: true })
    expect((out.value as { ok: boolean; source: string })).toMatchObject({ ok: false, source: 'src' })
    const text = out.content.map(b => b.type === 'text' ? b.text : '').join('\n')
    expect(text).toContain('Emitted stub document source')
    expect(text).toContain('[error SCHEMATIC_VERIFY_UNAVAILABLE]')
  })

  it('skips verification when the argument is omitted', async () => {
    let verified = 0
    const { call } = await mountTools({
      engine: {
        id: 'stub', available: () => true, serialize: () => 'src',
        verify: async () => { verified += 1; return [] },
      },
    })
    const out = await call('schematic_validate', { document: validDoc })
    expect(out.isError).toBe(false)
    expect(verified).toBe(0)
  })
})

describe('model prompt section', () => {
  /** Create a real per-agent scope over the mounted plugins. */
  async function guidanceScope(ctx: Context) {
    const key = {}
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
      { inject: ['tools', 'systemPrompt'] }))
    return { key, scope }
  }

  it('advertises the schematic tools when they are visible', async () => {
    const { ctx } = await mountTools()
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('schematic_generate')
    expect(prompt).toContain('schematic_validate')
    expect(prompt).toContain('0.01-inch')
  })

  it('emits no schematic guidance when the tools are hidden', async () => {
    const { ctx } = await mountTools()
    const { key, scope } = await guidanceScope(ctx)
    const baseline = renderPrompt(await ctx.systemPrompt.assemble())
    expect(baseline).toContain('schematic_generate')
    const release = scope.ctx.tools.restrict({ allow: [] })
    try {
      const restricted = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
      expect(restricted).not.toContain('schematic_generate')
      expect(restricted).not.toContain('schematic_validate')
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(baseline)
      release()
      expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toBe(baseline)
    } finally {
      await scope.dispose()
    }
  })
})

describe('page frame and title block', () => {
  /** Engine that records the serialize/verify options the tool passes down. */
  function recordingEngine(): { engine: SchematicEngine; serialize: Record<string, unknown>[]; verify: Record<string, unknown>[] } {
    const serialize: Record<string, unknown>[] = []
    const verify: Record<string, unknown>[] = []
    const engine: SchematicEngine = {
      id: 'recording',
      available: () => true,
      serialize: (ir, options) => {
        serialize.push((options ?? {}) as Record<string, unknown>)
        return `EMITTED(${ir.sheets.length})`
      },
      verify: async (_ir, options) => {
        verify.push((options ?? {}) as Record<string, unknown>)
        return []
      },
    }
    return { engine, serialize, verify }
  }

  it('defaults to the A3 production frame and forwards it to layout and the serializer', async () => {
    const recorder = recordingEngine()
    const { call } = await mountTools({ engine: recorder.engine })
    await call('schematic_generate', { document: validDoc })
    expect(recorder.serialize[0]?.pageSize).toEqual({ width: 1655, height: 1170 })
    // No title block requested and no configured title: the engine's own
    // defaults stand, so the tool passes an empty title block.
    expect(recorder.serialize[0]?.titleBlock).toEqual({})
  })

  it('honors an explicit A4 page size and a per-call title block', async () => {
    const recorder = recordingEngine()
    const { call } = await mountTools({ engine: recorder.engine })
    await call('schematic_generate', {
      document: validDoc,
      pageSize: 'A4',
      titleBlock: { projectTitle: 'Demo Board', version: 'V2', company: 'ACME', date: '2026-10-17' },
    })
    expect(recorder.serialize[0]?.pageSize).toEqual({ width: 1170, height: 825 })
    expect(recorder.serialize[0]?.titleBlock).toEqual({
      projectTitle: 'Demo Board', version: 'V2', company: 'ACME', date: '2026-10-17',
    })
  })

  it('forwards the drawing-number, sheet-name, and signature cells', async () => {
    const recorder = recordingEngine()
    const { call } = await mountTools({ engine: recorder.engine })
    await call('schematic_generate', {
      document: validDoc,
      titleBlock: {
        drawingNumber: 'DSH-001',
        schematicName: 'SHEET A',
        drawnBy: 'j2',
        checkedBy: 'j3',
        approvedBy: 'j1',
      },
    })
    expect(recorder.serialize[0]?.titleBlock).toEqual({
      drawingNumber: 'DSH-001',
      schematicName: 'SHEET A',
      drawnBy: 'j2',
      checkedBy: 'j3',
      approvedBy: 'j1',
    })
  })

  it('falls back to the configured drawing cells and lets a call override them', async () => {
    const recorder = recordingEngine()
    const { call } = await mountTools({
      engine: recorder.engine,
      config: { drawingNumber: 'CFG-7', schematicName: 'CFG SHEET', drawnBy: 'd', checkedBy: 'c', approvedBy: 'a' },
    })
    await call('schematic_generate', { document: validDoc })
    expect(recorder.serialize[0]?.titleBlock).toEqual({
      drawingNumber: 'CFG-7', schematicName: 'CFG SHEET', drawnBy: 'd', checkedBy: 'c', approvedBy: 'a',
    })
    await call('schematic_generate', { document: validDoc, titleBlock: { drawingNumber: 'CALL-9' } })
    expect(recorder.serialize[1]?.titleBlock).toEqual({
      drawingNumber: 'CALL-9', schematicName: 'CFG SHEET', drawnBy: 'd', checkedBy: 'c', approvedBy: 'a',
    })
  })

  it('falls back to the configured page size and title when a call omits them', async () => {
    const recorder = recordingEngine()
    const { call } = await mountTools({
      engine: recorder.engine,
      config: { pageSize: 'A4', projectTitle: 'Configured Board', company: 'Configured Co' },
    })
    await call('schematic_generate', { document: validDoc })
    expect(recorder.serialize[0]?.pageSize).toEqual({ width: 1170, height: 825 })
    expect(recorder.serialize[0]?.titleBlock).toEqual({ projectTitle: 'Configured Board', company: 'Configured Co' })
  })

  it('ignores an unknown page size and non-string title-block fields', async () => {
    const recorder = recordingEngine()
    const { call } = await mountTools({ engine: recorder.engine, config: { pageSize: 'A4' } })
    await call('schematic_generate', {
      document: validDoc,
      pageSize: 'A2',
      titleBlock: { projectTitle: 42, version: '', company: 'ACME' },
    })
    // A2 is not offered: the configured A4 stands. Empty/non-string fields are
    // dropped rather than printed as "42" or an empty cell.
    expect(recorder.serialize[0]?.pageSize).toEqual({ width: 1170, height: 825 })
    expect(recorder.serialize[0]?.titleBlock).toEqual({ company: 'ACME' })
  })

  it('passes the frame to the live verification path too', async () => {
    const recorder = recordingEngine()
    const { call } = await mountTools({ engine: recorder.engine })
    await call('schematic_generate', { document: validDoc, verify: true, pageSize: 'A4', titleBlock: { company: 'ACME' } })
    expect(recorder.verify[0]?.pageSize).toEqual({ width: 1170, height: 825 })
    expect(recorder.verify[0]?.titleBlock).toEqual({ company: 'ACME' })
  })

  it('plans validation against the selected frame', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_validate', { document: validDoc, pageSize: 'A3' })
    expect(out.isError).toBe(false)
  })
})

describe('net-label font size', () => {
  /** Records the options the tool passes down; the emitted text is irrelevant here. */
  function optionRecorder(): { engine: SchematicEngine; serialize: Record<string, unknown>[]; verify: Record<string, unknown>[] } {
    const serialize: Record<string, unknown>[] = []
    const verify: Record<string, unknown>[] = []
    const engine: SchematicEngine = {
      id: 'recording',
      available: () => true,
      serialize: (_ir, options) => {
        serialize.push((options ?? {}) as Record<string, unknown>)
        return 'EMITTED'
      },
      verify: async (_ir, options) => {
        verify.push((options ?? {}) as Record<string, unknown>)
        return []
      },
    }
    return { engine, serialize, verify }
  }

  /**
   * Runs the real document serializer with a fixed document uuid, so the
   * assertions below cover emitted bytes rather than only the option object.
   * The mapping mirrors the EasyEDA engine: `titleBlock` reaches the serializer
   * as `frame`, and an absent size stays absent so the engine default applies.
   */
  const byteEngine: SchematicEngine = {
    id: 'bytes',
    available: () => true,
    serialize: (ir, options) => serializeEasyEdaDocument(ir, {
      clientId: 'test',
      docUuid: 'net-label-font-size',
      ...(options?.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      ...(options?.titleBlock === undefined ? {} : { frame: options.titleBlock }),
      ...(options?.netLabelFontSize === undefined ? {} : { netLabelFontSize: options.netLabelFontSize }),
    }),
  }
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

  it('leaves the option unset when the call omits it', async () => {
    const recorder = optionRecorder()
    const { call } = await mountTools({ engine: recorder.engine })
    await call('schematic_generate', { document: validDoc })
    expect(recorder.serialize[0]).not.toHaveProperty('netLabelFontSize')
  })

  it('emits the same bytes as before the option existed', async () => {
    const { call } = await mountTools({ engine: byteEngine })
    const out = await call('schematic_generate', { document: validDoc })
    expect(out.isError).toBe(false)
    const source = (out.value as { source: string }).source
    // The default is still 6 units; the digest pins every byte of the page so a
    // future change to the default (or to the geometry) cannot pass unnoticed.
    expect(source).toContain('"fontSize":6')
    expect(sha256(source)).toBe('e99452bfb064d82670fa51b02728b4488d0c38785e93cdb91a7c643fb8693fb2')
  })

  it('applies an explicit size on both delivery paths', async () => {
    const recorder = optionRecorder()
    const { call } = await mountTools({ engine: recorder.engine })
    await call('schematic_generate', { document: validDoc, netLabelFontSize: 5, verify: true })
    expect(recorder.serialize[0]?.netLabelFontSize).toBe(5)
    expect(recorder.verify[0]?.netLabelFontSize).toBe(5)

    const { call: callBytes } = await mountTools({ engine: byteEngine })
    const out = await callBytes('schematic_generate', { document: validDoc, netLabelFontSize: 5 })
    expect((out.value as { source: string }).source).toContain('"fontSize":5')
  })

  it('rejects zero and negative sizes instead of clamping them', async () => {
    const { call } = await mountTools()
    for (const bad of [0, -1]) {
      const out = await call('schematic_generate', { document: validDoc, netLabelFontSize: bad })
      expect(out.isError).toBe(true)
      expect(out.error?.info?.code).toBe('SCHEMATIC_NET_LABEL_FONT_SIZE')
    }
  })

  it('lets the argument schema reject a non-numeric size', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_generate', { document: validDoc, netLabelFontSize: '5' })
    expect(out.isError).toBe(true)
    expect(out.error?.info?.code).toBe('INVALID_ARGS')
  })
})
