import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SchematicRuntime, {
  SCHEMATIC_LOOKUP_FAILED,
  type SchematicIr,
  type SchematicLibrary,
  type SchematicResolvedFootprint,
} from '@deepseek-ai/dsh-schematic'

/** Mount a SchematicRuntime on a fresh root context with the given config. */
async function mountSchematic(
  config: ConstructorParameters<typeof SchematicRuntime>[1] = {},
): Promise<{ ctx: Context; schematic: SchematicRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SchematicRuntime, config)
  return { ctx, schematic: ctx.schematic }
}

/** A scripted workspace library: undefined = miss, thrown = unreachable. */
function makeLibrary(id: string, overrides: Partial<SchematicLibrary> = {}): SchematicLibrary {
  return {
    id,
    resolveDevice: async () => ({}),
    resolveSymbol: async () => ({}),
    resolveFootprint: async (): Promise<SchematicResolvedFootprint | undefined> => ({ pads: ['1'] }),
    ...overrides,
  }
}

const baseComponent = {
  id: 'c1',
  kind: 'part',
  designator: 'U1',
  position: { x: 0, y: 0 },
  pins: [{ id: 'p1', name: 'I', number: '1', electric: 'INPUT', endpoint: { x: 0, y: 0 } }],
} as const

function doc(components: readonly object[]): SchematicIr {
  return {
    sheets: [{
      components: components as SchematicIr['sheets'][number]['components'],
      wires: [], busEntries: [], junctions: [], attrs: [],
    }],
  }
}

describe('SchematicRuntime library registry', () => {
  it('throws SCHEMATIC_DUPLICATE_LIBRARY on a duplicate id', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerLibrary(makeLibrary('easyeda'))
    expect(() => schematic.registerLibrary(makeLibrary('easyeda')))
      .toThrow(expect.objectContaining({ code: 'SCHEMATIC_DUPLICATE_LIBRARY' }))
  })

  it('unregisters a library via the returned disposer', async () => {
    const { schematic } = await mountSchematic()
    const dispose = schematic.registerLibrary(makeLibrary('easyeda'))
    dispose()
    const { libraryResolver } = await schematic.resolveBindings(doc([{ ...baseComponent, deviceUuid: 'd' }]))
    expect(libraryResolver).toBeUndefined()
  })

  it('disposes library registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, schematic } = await mountSchematic()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.schematic.registerLibrary(makeLibrary('easyeda'))
    }, { inject: ['schematic'] }))
    await fiber.dispose()
    const { libraryResolver } = await schematic.resolveBindings(doc([{ ...baseComponent, deviceUuid: 'd' }]))
    expect(libraryResolver).toBeUndefined()
  })
})

describe('SchematicRuntime.resolveBindings', () => {
  it('passes the IR through unchanged when no library is registered', async () => {
    const { schematic } = await mountSchematic()
    const ir = doc([baseComponent])
    const { ir: bound, libraryResolver } = await schematic.resolveBindings(ir)
    expect(bound).toBe(ir)
    expect(libraryResolver).toBeUndefined()
  })

  it('fills device/symbol/footprint UUIDs from an LCSC hit and propagates library scopes', async () => {
    const { schematic } = await mountSchematic()
    const symbolCalls: Array<[string, string | undefined]> = []
    schematic.registerLibrary(makeLibrary('easyeda', {
      resolveByLcsc: async () => ({
        deviceUuid: 'dev-1', deviceLibraryUuid: 'lib-dev',
        symbolUuid: 'sym-1', symbolLibraryUuid: 'lib-sym',
        footprintUuid: 'fp-1', footprintLibraryUuid: 'lib-fp',
        name: 'NE555',
      }),
      resolveSymbol: async (uuid: string, libraryUuid?: string) => {
        symbolCalls.push([uuid, libraryUuid])
        return {}
      },
    }))
    const { ir: bound, libraryResolver } = await schematic.resolveBindings(
      doc([{ ...baseComponent, lcsc: 'C25804' }]),
    )
    const component = bound.sheets[0]!.components[0]!
    expect(component.deviceUuid).toBe('dev-1')
    expect(component.symbolUuid).toBe('sym-1')
    expect(component.footprintUuid).toBe('fp-1')
    expect(component.deviceLibraryUuid).toBe('lib-dev')
    expect(component.symbolLibraryUuid).toBe('lib-sym')
    expect(component.footprintLibraryUuid).toBe('lib-fp')
    expect(symbolCalls).toEqual([['sym-1', 'lib-sym']])
    expect(libraryResolver).toBeDefined()
    const bindingFindings = schematic.validate(bound, { libraryResolver }).findings
      .filter(f => f.code.startsWith('BINDING'))
    expect(bindingFindings).toEqual([])
  })

  it('never overwrites declared UUIDs with LCSC-resolved ones', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerLibrary(makeLibrary('easyeda', {
      resolveByLcsc: async () => ({ deviceUuid: 'dev-1', symbolUuid: 'sym-1', footprintUuid: 'fp-1' }),
    }))
    const { ir: bound } = await schematic.resolveBindings(
      doc([{ ...baseComponent, lcsc: 'C1', deviceUuid: 'mine', symbolUuid: 'sym-1', footprintUuid: 'fp-1' }]),
    )
    expect(bound.sheets[0]!.components[0]!.deviceUuid).toBe('mine')
  })

  it('leaves an LCSC miss unresolved and reports it through validation', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerLibrary(makeLibrary('easyeda', { resolveByLcsc: async () => undefined }))
    const { ir: bound, libraryResolver } = await schematic.resolveBindings(
      doc([{ ...baseComponent, lcsc: 'C999' }]),
    )
    expect(bound.sheets[0]!.components[0]!.deviceUuid).toBeUndefined()
    expect(libraryResolver).toBeDefined()
    const finding = schematic.validate(bound, { libraryResolver }).findings
      .find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.severity).toBe('error')
    expect(finding?.message).toContain('LCSC part "C999"')
  })

  it('does not query resolveByLcsc when every binding is already declared', async () => {
    const { schematic } = await mountSchematic()
    let lcscCalls = 0
    schematic.registerLibrary(makeLibrary('easyeda', {
      resolveByLcsc: async () => { lcscCalls++; return { deviceUuid: 'd' } },
    }))
    await schematic.resolveBindings(
      doc([{ ...baseComponent, lcsc: 'C1', deviceUuid: 'd', symbolUuid: 's', footprintUuid: 'f' }]),
    )
    expect(lcscCalls).toBe(0)
  })

  it('skips resolveByLcsc entirely for components without an lcsc field', async () => {
    const { schematic } = await mountSchematic()
    let lcscCalls = 0
    schematic.registerLibrary(makeLibrary('easyeda', {
      resolveByLcsc: async () => { lcscCalls++; return { deviceUuid: 'd' } },
    }))
    const { ir: bound } = await schematic.resolveBindings(doc([baseComponent]))
    expect(lcscCalls).toBe(0)
    expect(bound.sheets[0]!.components[0]!.deviceUuid).toBeUndefined()
  })

  it('leaves lcsc declarations unresolved when the library has no resolveByLcsc', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerLibrary(makeLibrary('easyeda'))
    const { ir: bound } = await schematic.resolveBindings(doc([{ ...baseComponent, lcsc: 'C1' }]))
    expect(bound.sheets[0]!.components[0]!.deviceUuid).toBeUndefined()
  })

  it('takes the first answered result across registered libraries', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerLibrary(makeLibrary('flaky', {
      resolveByLcsc: async () => { throw new Error('bridge down') },
      resolveDevice: async () => { throw new Error('bridge down') },
      resolveSymbol: async () => { throw new Error('bridge down') },
      resolveFootprint: async () => { throw new Error('bridge down') },
    }))
    schematic.registerLibrary(makeLibrary('backup', {
      resolveByLcsc: async () => ({ deviceUuid: 'dev-b' }),
    }))
    const { ir: bound } = await schematic.resolveBindings(doc([{ ...baseComponent, lcsc: 'C1' }]))
    expect(bound.sheets[0]!.components[0]!.deviceUuid).toBe('dev-b')
  })

  it('lets a definitive miss fall through to the next library', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerLibrary(makeLibrary('first', {
      resolveByLcsc: async () => undefined,
      resolveDevice: async () => undefined,
      resolveSymbol: async () => undefined,
      resolveFootprint: async () => undefined,
    }))
    schematic.registerLibrary(makeLibrary('second', {
      resolveByLcsc: async () => ({ deviceUuid: 'dev-2' }),
      resolveDevice: async () => ({}),
    }))
    const { ir: bound, libraryResolver } = await schematic.resolveBindings(
      doc([{ ...baseComponent, lcsc: 'C1' }]),
    )
    expect(bound.sheets[0]!.components[0]!.deviceUuid).toBe('dev-2')
    expect(libraryResolver?.resolveDevice?.('dev-2')).toEqual({})
  })

  it('reports an unreachable library as resolver absence, not as misses', async () => {
    const { schematic } = await mountSchematic()
    const dead = makeLibrary('dead', {
      resolveDevice: async () => { throw new Error('bridge down') },
      resolveSymbol: async () => { throw new Error('bridge down') },
      resolveFootprint: async () => { throw new Error('bridge down') },
    })
    schematic.registerLibrary(dead)
    const { libraryResolver } = await schematic.resolveBindings(
      doc([{ ...baseComponent, deviceUuid: 'd', symbolUuid: 's', footprintUuid: 'f' }]),
    )
    expect(libraryResolver).toBeUndefined()
    const finding = schematic.validate(doc([{ ...baseComponent, deviceUuid: 'd', symbolUuid: 's', footprintUuid: 'f' }]), {})
      .findings.find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.severity).toBe('warning')
  })

  it('marks one flaky lookup with the sentinel while sibling lookups verify', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerLibrary(makeLibrary('flaky', {
      resolveDevice: async () => { throw new Error('timeout') },
    }))
    const { libraryResolver } = await schematic.resolveBindings(
      doc([{ ...baseComponent, deviceUuid: 'd', symbolUuid: 's', footprintUuid: 'f' }]),
    )
    expect(libraryResolver?.resolveDevice?.('d')).toBe(SCHEMATIC_LOOKUP_FAILED)
    expect(libraryResolver?.resolveSymbol?.('s')).toEqual({})
    const finding = schematic.validate(doc([{ ...baseComponent, deviceUuid: 'd', symbolUuid: 's', footprintUuid: 'f' }]), { libraryResolver })
      .findings.find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.severity).toBe('warning')
    expect(finding?.message).toContain('lookup failed')
  })

  it('prefetches each declared UUID once across repeated components', async () => {
    const { schematic } = await mountSchematic()
    let deviceCalls = 0
    schematic.registerLibrary(makeLibrary('easyeda', {
      resolveDevice: async () => { deviceCalls++; return {} },
    }))
    await schematic.resolveBindings(doc([
      { ...baseComponent, deviceUuid: 'shared' },
      { ...baseComponent, id: 'c2', designator: 'U2', deviceUuid: 'shared' },
    ]))
    expect(deviceCalls).toBe(1)
  })

  it('treats a lookup as unreachable when no registered library implements it', async () => {
    const { schematic } = await mountSchematic()
    const sparse = makeLibrary('sparse')
    Reflect.deleteProperty(sparse, 'resolveDevice')
    schematic.registerLibrary(sparse)
    const { libraryResolver } = await schematic.resolveBindings(doc([{ ...baseComponent, deviceUuid: 'd', symbolUuid: 's' }]))
    expect(libraryResolver?.resolveDevice?.('d')).toBe(SCHEMATIC_LOOKUP_FAILED)
    expect(libraryResolver?.resolveSymbol?.('s')).toEqual({})
  })

  it('reports a real scoped miss through the prefetched snapshot', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerLibrary(makeLibrary('easyeda', {
      resolveDevice: async () => undefined,
    }))
    const bound = [{ ...baseComponent, deviceUuid: 'gone', deviceLibraryUuid: 'lib-1' }]
    const { libraryResolver } = await schematic.resolveBindings(doc(bound))
    const finding = schematic.validate(doc(bound), { libraryResolver })
      .findings.find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.severity).toBe('error')
    expect(finding?.message).toContain('"gone"')
  })

  it('degrades a scopeless miss to an unverifiable warning', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerLibrary(makeLibrary('easyeda', {
      resolveDevice: async () => undefined,
    }))
    const { libraryResolver } = await schematic.resolveBindings(doc([{ ...baseComponent, deviceUuid: 'gone' }]))
    const finding = schematic.validate(doc([{ ...baseComponent, deviceUuid: 'gone' }]), { libraryResolver })
      .findings.find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.severity).toBe('warning')
    expect(finding?.message).toContain('unverifiable without a library scope')
  })

  it('does not borrow a scope for a declared UUID that won over the resolved one', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerLibrary(makeLibrary('easyeda', {
      resolveByLcsc: async () => ({
        deviceUuid: 'dev-1', deviceLibraryUuid: 'lib-dev',
        symbolUuid: 'sym-1', symbolLibraryUuid: 'lib-sym',
        footprintUuid: 'fp-1', footprintLibraryUuid: 'lib-fp',
      }),
    }))
    const { ir: bound } = await schematic.resolveBindings(doc([
      // Declared device/symbol win and take no scope; the absent footprint
      // fills from the part and carries its scope.
      { ...baseComponent, lcsc: 'C1', deviceUuid: 'mine-dev', symbolUuid: 'mine-sym' },
      // Declared footprint wins and takes no scope; absent device/symbol fill.
      { ...baseComponent, id: 'c2', designator: 'U2', lcsc: 'C1', footprintUuid: 'mine-fp' },
    ]))
    const c1 = bound.sheets[0]!.components[0]!
    expect(c1.deviceUuid).toBe('mine-dev')
    expect(c1.deviceLibraryUuid).toBeUndefined()
    expect(c1.symbolUuid).toBe('mine-sym')
    expect(c1.symbolLibraryUuid).toBeUndefined()
    expect(c1.footprintUuid).toBe('fp-1')
    expect(c1.footprintLibraryUuid).toBe('lib-fp')
    const c2 = bound.sheets[0]!.components[1]!
    expect(c2.footprintUuid).toBe('mine-fp')
    expect(c2.footprintLibraryUuid).toBeUndefined()
    expect(c2.deviceUuid).toBe('dev-1')
    expect(c2.deviceLibraryUuid).toBe('lib-dev')
    expect(c2.symbolLibraryUuid).toBe('lib-sym')
  })

  it('prefetches symbol pin geometry once per bound symbol', async () => {
    const { schematic } = await mountSchematic()
    const calls: Array<[string, string | undefined]> = []
    schematic.registerLibrary(makeLibrary('easyeda', {
      resolveSymbolPins: async (uuid: string, libraryUuid?: string) => {
        calls.push([uuid, libraryUuid])
        return [{ number: '1', x: -60, y: -20 }, { number: '2', x: -60, y: 0 }]
      },
    }))
    const { libraryResolver, symbolPins } = await schematic.resolveBindings(doc([
      { ...baseComponent, symbolUuid: 'sym-1', symbolLibraryUuid: 'lib-sym' },
      { ...baseComponent, id: 'c2', designator: 'U2', symbolUuid: 'sym-1', symbolLibraryUuid: 'lib-sym' },
      { ...baseComponent, id: 'c3', designator: 'U3', symbolUuid: 'sym-2' },
    ]))
    expect(calls).toEqual([['sym-1', 'lib-sym'], ['sym-2', undefined]])
    expect(symbolPins?.get('sym-1')?.[0]).toMatchObject({ number: '1', x: -60 })
    expect(libraryResolver?.resolveSymbolPins?.('sym-1')).toHaveLength(2)
  })

  it('skips symbol-pin prefetch when no library implements it and tolerates throws', async () => {
    const { schematic } = await mountSchematic()
    schematic.registerLibrary(makeLibrary('no-pins'))
    schematic.registerLibrary(makeLibrary('throwing', {
      resolveSymbolPins: async () => { throw new Error('bridge down') },
    }))
    schematic.registerLibrary(makeLibrary('sparse-pins', {
      resolveSymbolPins: async () => undefined,
    }))
    const { libraryResolver, symbolPins } = await schematic.resolveBindings(
      doc([{ ...baseComponent, symbolUuid: 'sym-1' }]),
    )
    expect(symbolPins).toBeUndefined()
    expect(libraryResolver?.resolveSymbolPins?.('sym-1')).toBeUndefined()
  })
})

describe('SchematicRuntime requireLibrary gate', () => {
  const boundDoc = () => doc([{ ...baseComponent, deviceUuid: 'd', symbolUuid: 's', footprintUuid: 'f' }])

  it('escalates the unreachable-library degradation to an error when configured', async () => {
    const { schematic } = await mountSchematic({ requireLibrary: true })
    const { libraryResolver } = await schematic.resolveBindings(boundDoc())
    const finding = schematic.validate(boundDoc(), { libraryResolver }).findings
      .find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.severity).toBe('error')
  })

  it('keeps warnings by default', async () => {
    const { schematic } = await mountSchematic()
    const finding = schematic.validate(boundDoc()).findings.find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.severity).toBe('warning')
  })

  it('lets a per-call option override the configured gate', async () => {
    const { schematic } = await mountSchematic({ requireLibrary: true })
    const finding = schematic.validate(boundDoc(), { requireLibrary: false }).findings
      .find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.severity).toBe('warning')
  })
})
