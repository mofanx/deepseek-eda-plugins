import { describe, expect, it } from 'vitest'
import { EasyEdaLibrary } from '@deepseek-ai/dsh-schematic-easyeda'
import type { EasyEdaBridge } from '@deepseek-ai/dsh-schematic-easyeda'
import { SCHEMATIC_LOOKUP_FAILED } from '@deepseek-ai/dsh-schematic'

/** A scripted bridge that records every code body and returns canned values. */
function scriptedBridge(handler: (code: string) => unknown): { bridge: EasyEdaBridge; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    bridge: {
      execute: async (code: string) => {
        calls.push(code)
        return handler(code)
      },
    },
  }
}

/** The `{item, ...}` payload the resolveByLcsc script returns. */
function resolvedResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item: {
      uuid: 'dev-1',
      libraryUuid: 'lib-dev',
      name: 'NE555',
    },
    symbolUuid: 'sym-1',
    symbolLibraryUuid: 'lib-sym',
    footprintUuid: 'fp-1',
    footprintLibraryUuid: 'lib-fp',
    scopeLibraryUuid: 'sys-lib',
    ...overrides,
  }
}

describe('EasyEdaLibrary uuid lookups', () => {
  it('forwards queryTimeoutMs as the per-call bridge timeout', async () => {
    const seen: (number | undefined)[] = []
    const bridge: EasyEdaBridge = {
      execute: async (_code: string, options?: { timeoutMs?: number | undefined }) => {
        seen.push(options?.timeoutMs)
        return { uuid: 'dev-1' }
      },
    }
    const library = new EasyEdaLibrary({ bridge, queryTimeoutMs: 4000 })
    await library.resolveDevice('dev-1')
    expect(seen).toEqual([4000])
  })

  it('resolves a device through lib_Device.get with the association scope', async () => {
    const { bridge, calls } = scriptedBridge(() => ({ uuid: 'dev-1' }))
    const library = new EasyEdaLibrary({ bridge })
    expect(await library.resolveDevice('dev-1', 'lib-dev')).toEqual({ uuid: 'dev-1' })
    // Scoped first, unscoped retry: the client rejects some association
    // scopes with an internal error rather than a miss.
    expect(calls[0]).toContain('eda.lib_Device.get("dev-1", "lib-dev")')
    expect(calls[0]).toContain('catch (e) { return await eda.lib_Device.get("dev-1", undefined) }')
  })

  it('passes the configured library scope when no hint is given', async () => {
    const { bridge, calls } = scriptedBridge(() => ({}))
    const library = new EasyEdaLibrary({ bridge, libraryUuid: 'ws-1' })
    await library.resolveSymbol('sym-1')
    expect(calls[0]).toContain('eda.lib_Symbol.get("sym-1", "ws-1")')
  })

  it('queries with the hint scope but never issues an unscoped symbol lookup', async () => {
    const { bridge, calls } = scriptedBridge(() => ({}))
    const library = new EasyEdaLibrary({ bridge })
    await library.resolveSymbol('sym-1', 'lib-sym')
    expect(calls[0]).toContain('eda.lib_Symbol.get("sym-1", "lib-sym")')
    // E5: an unscoped symbol query resolves only the client's default scope
    // and misses system/project copies — it degrades to "unverified" instead
    // of a false miss.
    expect(await library.resolveSymbol('sym-2')).toBe(SCHEMATIC_LOOKUP_FAILED)
    expect(calls).toHaveLength(1)
  })

  it('maps a footprint item to a pad-less record and a miss to undefined', async () => {
    const { bridge } = scriptedBridge(() => ({ uuid: 'fp-1' }))
    const library = new EasyEdaLibrary({ bridge, libraryUuid: 'ws-1' })
    expect(await library.resolveFootprint('fp-1')).toEqual({})

    const empty = scriptedBridge(() => undefined)
    expect(await new EasyEdaLibrary({ bridge: empty.bridge, libraryUuid: 'ws-1' }).resolveFootprint('gone')).toBeUndefined()
  })

  it('reports an unscoped footprint lookup as unverifiable, not a miss', async () => {
    const { bridge, calls } = scriptedBridge(() => ({ uuid: 'fp-1' }))
    const library = new EasyEdaLibrary({ bridge })
    expect(await library.resolveFootprint('fp-1')).toBe(SCHEMATIC_LOOKUP_FAILED)
    expect(calls).toHaveLength(0)
  })

  it('maps a device miss to undefined', async () => {
    const { bridge } = scriptedBridge(() => undefined)
    const library = new EasyEdaLibrary({ bridge })
    expect(await library.resolveDevice('gone')).toBeUndefined()
  })

  it('maps a symbol miss to undefined', async () => {
    const { bridge } = scriptedBridge(() => null)
    const library = new EasyEdaLibrary({ bridge, libraryUuid: 'ws-1' })
    expect(await library.resolveSymbol('gone')).toBeUndefined()
  })

  it('passes an explicit scope hint to lib_Footprint.get', async () => {
    const { bridge, calls } = scriptedBridge(() => ({ uuid: 'fp-1' }))
    const library = new EasyEdaLibrary({ bridge })
    await library.resolveFootprint('fp-1', 'lib-fp')
    expect(calls[0]).toContain('eda.lib_Footprint.get("fp-1", "lib-fp")')
    expect(calls[0]).toContain('eda.lib_Footprint.get("fp-1", undefined)')
  })

  it('treats a null footprint payload as a miss', async () => {
    const { bridge } = scriptedBridge(() => null)
    const library = new EasyEdaLibrary({ bridge, libraryUuid: 'ws-1' })
    expect(await library.resolveFootprint('fp-1')).toBeUndefined()
  })
})

describe('EasyEdaLibrary.resolveByLcsc', () => {
  it('queries the system library first and verifies associations in scope', async () => {
    const { bridge, calls } = scriptedBridge(() => resolvedResult())
    const library = new EasyEdaLibrary({ bridge })
    const part = await library.resolveByLcsc('C25804')
    expect(part).toEqual({
      deviceUuid: 'dev-1',
      deviceLibraryUuid: 'lib-dev',
      symbolUuid: 'sym-1',
      symbolLibraryUuid: 'lib-sym',
      footprintUuid: 'fp-1',
      footprintLibraryUuid: 'lib-fp',
      name: 'NE555',
    })
    const code = calls[0]!
    // System library scope is preferred over the client's default scope.
    expect(code).toContain('lib_LibrariesList.getSystemLibraryUuid')
    expect(code).toContain('eda.lib_Device.getByLcscIds("C25804", lib)')
    expect(code).toContain('eda.lib_Device.search("C25804", lib)')
    // Associations are verified loadable under their scope before emission.
    expect(code).toContain('loadable("lib_Symbol", symUuid, symLib)')
    expect(code).toContain('loadable("lib_Footprint", fpUuid, fpLib)')
  })

  it('falls back to the queried scope uuid when the device item omits one', async () => {
    const { bridge } = scriptedBridge(() => resolvedResult({ item: { uuid: 'dev-2', name: 'X' } }))
    const library = new EasyEdaLibrary({ bridge })
    const part = await library.resolveByLcsc('C1')
    expect(part?.deviceUuid).toBe('dev-2')
    expect(part?.deviceLibraryUuid).toBe('sys-lib')
  })

  it('omits associations the client could not verify in scope', async () => {
    const { bridge } = scriptedBridge(() => resolvedResult({ symbolUuid: undefined, symbolLibraryUuid: undefined }))
    const library = new EasyEdaLibrary({ bridge })
    const part = await library.resolveByLcsc('C1')
    expect(part?.symbolUuid).toBeUndefined()
    expect(part?.footprintUuid).toBe('fp-1')
  })

  it('returns undefined on a definitive miss and on malformed payloads', async () => {
    const { bridge } = scriptedBridge(() => undefined)
    const library = new EasyEdaLibrary({ bridge })
    expect(await library.resolveByLcsc('C1')).toBeUndefined()

    const malformed = scriptedBridge(() => ({ item: { name: 'no uuid' } }))
    expect(await new EasyEdaLibrary({ bridge: malformed.bridge }).resolveByLcsc('C1')).toBeUndefined()
  })
})

describe('EasyEdaLibrary.resolveSymbolPins', () => {
  const symbolSource = [
    '{"type":"DOCHEAD","id":"h"}||{}|',
    '{"type":"PIN","id":"p1"}||{"x":-60,"y":-20,"length":10,"rotation":0}|',
    '{"type":"ATTR","id":"a1"}||{"key":"Pin Number","value":"1","parentId":"p1"}|',
    '{"type":"ATTR","id":"a2"}||{"key":"Pin Name","value":"GND","parentId":"p1"}|',
    '{"type":"PIN","id":"p2"}||{"x":50,"y":-20}|',
    '{"type":"ATTR","id":"a3"}||{"key":"Pin Number","value":"8","parentId":"p2"}|',
    // A pin with no Pin Number is not joinable and must be dropped.
    '{"type":"PIN","id":"p3"}||{"x":0,"y":0}|',
  ].join('\n')

  it('parses PIN records and their Pin Number/Pin Name attrs', async () => {
    const { bridge, calls } = scriptedBridge(() => symbolSource)
    const library = new EasyEdaLibrary({ bridge })
    expect(await library.resolveSymbolPins('sym-1', 'lib-sym')).toEqual([
      // The source records y -20; the persisted→API flip makes it +20.
      { number: '1', name: 'GND', x: -60, y: 20 },
      { number: '8', x: 50, y: 20 },
    ])
    expect(calls[0]).toContain('eda.lib_Symbol.getDocumentSource("sym-1", "lib-sym")')
  })

  it('returns undefined for a scopeless lookup without issuing a query', async () => {
    const { bridge, calls } = scriptedBridge(() => symbolSource)
    const library = new EasyEdaLibrary({ bridge })
    expect(await library.resolveSymbolPins('sym-1')).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('drops malformed ATTR/PIN records and resolves pin ids through fallbacks', async () => {
    const weird = [
      '{"type":"DOCHEAD","id":"h"}||{}|',
      // ATTRs skipped when key/value/parentId are not all strings.
      '{"type":"ATTR","id":"a0"}||{"key":7,"value":"1","parentId":"p1"}|',
      '{"type":"ATTR","id":"a1"}||{"key":"Pin Number","value":7,"parentId":"p1"}|',
      '{"type":"ATTR","id":"a2"}||{"key":"Pin Number","value":"1","parentId":7}|',
      // PINs skipped when x/y are not numbers.
      '{"type":"PIN","id":"px"}||{"x":"-60","y":-20}|',
      '{"type":"PIN","id":"py"}||{"x":-60}|',
      // Pin ids fall back to inner.uuid, then inner.id, then ''.
      '{"type":"PIN"}||{"x":1,"y":2,"uuid":"u9"}|',
      '{"type":"ATTR","id":"a3"}||{"key":"Pin Number","value":"3","parentId":"u9"}|',
      '{"type":"PIN"}||{"x":3,"y":4,"id":"i9"}|',
      '{"type":"ATTR","id":"a4"}||{"key":"Pin Number","value":"4","parentId":"i9"}|',
      '{"type":"PIN"}||{"x":5,"y":6}|',
      '{"type":"ATTR","id":"a5"}||{"key":"Pin Number","value":"5","parentId":""}|',
    ].join('\n')
    const { bridge } = scriptedBridge(() => weird)
    const library = new EasyEdaLibrary({ bridge })
    expect(await library.resolveSymbolPins('sym-1', 'lib-sym')).toEqual([
      { number: '3', x: 1, y: -2 },
      { number: '4', x: 3, y: -4 },
      { number: '5', x: 5, y: -6 },
    ])
  })

  it('returns undefined when the source is unreadable or carries no pins', async () => {
    const { bridge } = scriptedBridge(() => undefined)
    const library = new EasyEdaLibrary({ bridge, libraryUuid: 'ws-1' })
    expect(await library.resolveSymbolPins('sym-1')).toBeUndefined()

    const empty = scriptedBridge(() => '{"type":"DOCHEAD","id":"h"}||{}|')
    expect(await new EasyEdaLibrary({ bridge: empty.bridge, libraryUuid: 'ws-1' }).resolveSymbolPins('sym-1')).toBeUndefined()
  })
})

describe('EasyEdaLibrary bridge lifecycle', () => {
  it('memoizes an injected bridge across calls', async () => {
    const { bridge, calls } = scriptedBridge(() => ({}))
    const library = new EasyEdaLibrary({ bridge, libraryUuid: 'ws-1' })
    await library.resolveDevice('a')
    await library.resolveSymbol('b')
    expect(calls).toHaveLength(2)
  })

  it('rediscovers after a failed discovery so a later-started client still connects', async () => {
    let healthCalls = 0
    const fetchFn = (async (input: unknown): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/health')) {
        healthCalls++
        if (healthCalls <= 10) throw new Error('refused')
        return new Response(JSON.stringify({ service: 'easyeda-bridge', edaConnected: true }))
      }
      return new Response(JSON.stringify({ result: {} }))
    }) as typeof fetch
    const library = new EasyEdaLibrary({ host: '127.0.0.1', fetchFn, timeoutMs: 1000 })
    await expect(library.resolveDevice('x')).rejects.toThrow(/no easyeda bridge found/)
    const value = await library.resolveDevice('x')
    expect(value).toEqual({})
    // First attempt scanned all ten ports; the retry succeeded on the first.
    expect(healthCalls).toBe(11)
  })
})
