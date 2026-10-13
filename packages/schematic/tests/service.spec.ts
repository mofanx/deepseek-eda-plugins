import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SchematicRuntime, {
  SchematicError,
  type SchematicEngine,
} from '@deepseek-ai/dsh-schematic'

/** A scripted engine for registry contract tests. */
function makeEngine(id: string, available: boolean, source = `src:${id}`): SchematicEngine {
  return { id, available: () => available, serialize: () => source }
}

const usable = true
const unusable = false

/** Mount a SchematicRuntime on a fresh root context with the given config. */
async function mountSchematic(
  config: ConstructorParameters<typeof SchematicRuntime>[1] = {},
): Promise<{ ctx: Context; schematic: SchematicRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SchematicRuntime, config)
  return { ctx, schematic: ctx.schematic }
}

describe('SchematicRuntime registration', () => {
  it('registers an engine and unregisters it via the returned disposer', async () => {
    const { schematic } = await mountSchematic()
    const dispose = schematic.registerEngine(makeEngine('easyeda', usable))
    expect(schematic.engine().id).toBe('easyeda')
    dispose()
    expect(() => schematic.engine()).toThrow(expect.objectContaining({ code: 'SCHEMATIC_ENGINE_UNAVAILABLE' }))
  })

  it('throws SCHEMATIC_DUPLICATE_ENGINE on a duplicate id', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerEngine(makeEngine('easyeda', usable))
    expect(() => schematic.registerEngine(makeEngine('easyeda', usable)))
      .toThrow(expect.objectContaining({ code: 'SCHEMATIC_DUPLICATE_ENGINE' }))
  })

  it('disposes engine registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, schematic } = await mountSchematic()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.schematic.registerEngine(makeEngine('easyeda', usable))
    }, { inject: ['schematic'] }))
    expect(schematic.engine().id).toBe('easyeda')
    await fiber.dispose()
    expect(() => schematic.engine()).toThrow(expect.objectContaining({ code: 'SCHEMATIC_ENGINE_UNAVAILABLE' }))
  })
})

describe('SchematicRuntime engine resolution', () => {
  it('throws SCHEMATIC_ENGINE_UNAVAILABLE when nothing is registered', async () => {
    const { schematic } = await mountSchematic()
    expect(() => schematic.engine()).toThrow(expect.objectContaining({ code: 'SCHEMATIC_ENGINE_UNAVAILABLE' }))
  })

  it('throws SCHEMATIC_ENGINE_UNAVAILABLE when engines exist but none are usable', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerEngine(makeEngine('easyeda', unusable))
    expect(() => schematic.engine()).toThrow(expect.objectContaining({ code: 'SCHEMATIC_ENGINE_UNAVAILABLE' }))
  })

  it('throws SCHEMATIC_ENGINE_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { schematic } = await mountSchematic({ engine: 'kicad' })
    schematic.registerEngine(makeEngine('easyeda', usable))
    expect(() => schematic.engine()).toThrow(expect.objectContaining({ code: 'SCHEMATIC_ENGINE_CONFIGURED_MISSING' }))
  })

  it('throws SCHEMATIC_ENGINE_CONFIGURED_UNAVAILABLE for an unusable configured id', async () => {
    const { schematic } = await mountSchematic({ engine: 'easyeda' })
    schematic.registerEngine(makeEngine('easyeda', unusable))
    expect(() => schematic.engine()).toThrow(expect.objectContaining({ code: 'SCHEMATIC_ENGINE_CONFIGURED_UNAVAILABLE' }))
  })

  it('throws SCHEMATIC_ENGINE_AMBIGUOUS rather than picking by order', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerEngine(makeEngine('easyeda', usable))
    schematic.registerEngine(makeEngine('kicad', usable))
    expect(() => schematic.engine()).toThrow(expect.objectContaining({ code: 'SCHEMATIC_ENGINE_AMBIGUOUS' }))
  })

  it('runs the configured engine even when another usable engine is registered', async () => {
    const { schematic } = await mountSchematic({ engine: 'kicad' })
    schematic.registerEngine(makeEngine('easyeda', usable))
    schematic.registerEngine(makeEngine('kicad', usable))
    expect(schematic.engine().id).toBe('kicad')
  })

  it('ignores unusable engines when auto-selecting', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerEngine(makeEngine('easyeda', usable))
    schematic.registerEngine(makeEngine('kicad', unusable))
    expect(schematic.engine().id).toBe('easyeda')
  })

  it('does not let registration order change auto-selection', async () => {
    const a = await mountSchematic()
    a.schematic.registerEngine(makeEngine('easyeda', unusable))
    a.schematic.registerEngine(makeEngine('kicad', usable))
    expect(a.schematic.engine().id).toBe('kicad')

    const b = await mountSchematic()
    b.schematic.registerEngine(makeEngine('kicad', usable))
    b.schematic.registerEngine(makeEngine('easyeda', unusable))
    expect(b.schematic.engine().id).toBe('kicad')
  })
})

describe('SchematicRuntime layout', () => {
  const doc = {
    sheets: [{
      components: [{ id: 'u1', kind: 'part' as const, pins: [{ id: 'p1', electric: 'INPUT' as const }] }],
      wires: [],
      busEntries: [],
      junctions: [],
      attrs: [],
    }],
  }

  it('fills missing geometry under the default auto mode', async () => {
    const { schematic } = await mountSchematic()
    const laid = schematic.layout(doc)
    expect(laid.sheets[0]?.components[0]?.position).toBeDefined()
    expect(laid.sheets[0]?.components[0]?.pins[0]?.endpoint).toBeDefined()
  })

  it('passes the document through under layout: off', async () => {
    const { schematic } = await mountSchematic({ layout: 'off' })
    expect(schematic.layout(doc)).toBe(doc)
  })
})

describe('SchematicError', () => {
  it('is a HarnessError carrying its code', () => {
    const error = new SchematicError('boom', 'SCHEMATIC_IR_INVALID')
    expect(error.code).toBe('SCHEMATIC_IR_INVALID')
    expect(error.name).toBe('SchematicError')
  })
})
