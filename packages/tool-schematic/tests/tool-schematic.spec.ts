import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult, type ToolResult } from '@deepseek-ai/dsh-tools'
import SchematicRuntime from '@deepseek-ai/dsh-plugin-eda-sch'
import type { SchematicEngine, SchematicLibrary } from '@deepseek-ai/dsh-plugin-eda-sch'
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

  it('fails argument validation on a non-object document', async () => {
    const { call } = await mountTools()
    const out = await call('schematic_generate', { document: 'nope' })
    expect(out.isError).toBe(true)
    expect(out.error?.info).toMatchObject({ code: 'SCHEMATIC_IR_INVALID', name: 'SchematicError' })
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
    const blocks = gen?.output.render({}, { ok: true, format: 'stub', source: 'x', findings: [bare, { ...bare, suggestion: '' }] })
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
    const genBlocks = gen?.output.render({}, { ok: true, format: 'stub', source: 'abc', findings: [] })
    expect(genBlocks?.[0]?.type === 'text' ? genBlocks[0].text : '').toBe('Emitted stub document source (3 chars).')
    const val = ctx.tools.get('schematic_validate')
    const valBlocks = val?.output.render({}, { ok: true, findings: [] })
    expect(valBlocks?.[0]?.type === 'text' ? valBlocks[0].text : '').toBe('Schematic IR is valid.')
  })

  it('projects presentationMeta for both tools', async () => {
    const { ctx } = await mountTools()
    const gen = ctx.tools.get('schematic_generate')
    expect(gen?.output.presentationMeta?.({}, { ok: true, format: 'stub', findings: [{}, {}] }))
      .toEqual({ ok: true, format: 'stub', findings: 2 })
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
