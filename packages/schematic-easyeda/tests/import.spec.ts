import { describe, expect, it } from 'vitest'
import {
  EasyEdaSchematicEngine,
  importIntoEasyEda,
  serializeEasyEdaProject,
  type EasyEdaBridge,
} from '@deepseek-ai/dsh-plugin-eda-easyeda'
import type { SchematicIr } from '@deepseek-ai/dsh-plugin-eda-sch'

const ir: SchematicIr = {
  sheets: [{
    components: [{ id: 'c1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 }, pins: [] }],
    wires: [], busEntries: [], junctions: [], attrs: [],
  }],
}

/** `collectProjectLibrary` response when the IR binds nothing. */
const EMPTY_LIBRARY = { devices: {}, symbols: {}, footprints: {}, errors: [] }

/** A bridge that returns queued results and captures every executed body. */
function scriptedBridge(responses: unknown[]): { bridge: EasyEdaBridge; calls: string[] } {
  const calls: string[] = []
  const queue = [...responses]
  return {
    calls,
    bridge: {
      async execute(code: string) {
        calls.push(code)
        // Post-import queue-drain probes are no-op executes.
        if (code === 'return true') return true
        return queue.shift()
      },
    },
  }
}

describe('serializeEasyEdaProject defaults', () => {
  it('emits the default title and an empty defaultSheet when there are no pages', () => {
    const pkg = serializeEasyEdaProject({ sheets: [] })
    expect(pkg.projectJson).toContain('DSH Schematic')
    expect(pkg.epru).toContain('"defaultSheet":""')
  })
})

describe('importIntoEasyEda read-back edges', () => {
  it('tolerates a read-back response without a sources array', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY, { status: 'OK', projectUuid: 'p' }, { pageUuids: ['pg'] }])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.findings).toEqual([])
  })

  it('reports dropped pages when the read-back stage returns no page list', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY, { status: 'OK', projectUuid: 'p' }, { sources: [] }])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.findings.map(f => f.code)).toContain('SCHEMATIC_IMPORT_PAGE_LOST')
  })

  it('falls back to the uuid resolved by the read-back stage', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY,
      { status: 'OK', projectUuid: null },
      { status: 'OK', projectUuid: 'resolved-1', pageUuids: [], sources: [] },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.projectUuid).toBe('resolved-1')
  })

  it('reports an empty uuid when neither stage resolves one', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY,
      { status: 'OK' },
      { status: 'OK', pageUuids: [], sources: [] },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.projectUuid).toBe('')
  })

  it('reports an empty uuid on open failure without an import uuid', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY,
      { status: 'OK' },
      { status: 'OPEN_FAILED' },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.projectUuid).toBe('')
    expect(report.findings.map(f => f.code)).toContain('SCHEMATIC_IMPORT_OPEN_FAILED')
  })

  it('resends the read-back script while the client-side open is still landing', async () => {
    let readBackAttempts = 0
    const queue: unknown[] = [EMPTY_LIBRARY, { status: 'OK', projectUuid: 'p' }]
    const bridge: EasyEdaBridge = {
      async execute(code: string) {
        if (code === 'return true') return true
        const next = queue.shift()
        if (next !== undefined) return next
        readBackAttempts++
        if (readBackAttempts < 3) throw new Error('gateway 500')
        return {
          status: 'OK', projectUuid: 'p',
          pageUuids: ['pg-1'],
          sources: ['{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"U1"}|'],
        }
      },
    }
    const report = await importIntoEasyEda(ir, { bridge })
    expect(readBackAttempts).toBe(3)
    expect(report.findings).toEqual([])
    expect(report.pageUuids).toEqual(['pg-1'])
  })

  it('reports open timeout when no read-back attempt lands inside the budget', async () => {
    const queue: unknown[] = [EMPTY_LIBRARY, { status: 'OK', projectUuid: 'p' }]
    const bridge: EasyEdaBridge = {
      async execute(code: string) {
        if (code === 'return true') return true
        const next = queue.shift()
        if (next !== undefined) return next
        throw new Error('gateway 500')
      },
    }
    const report = await importIntoEasyEda(ir, { bridge, timeoutMs: 40 })
    expect(report.findings.map(f => f.code)).toContain('SCHEMATIC_IMPORT_OPEN_FAILED')
    expect(report.findings[0]?.message).toContain('did not finish opening it within')
  })

  it('stops reading back once every sheet is accounted for', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY,
      { status: 'OK', projectUuid: 'p' },
      {
        pageUuids: ['pg-1', 'pg-2'],
        sources: [
          '{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"U1"}|',
          '{"type":"ATTR","id":"a2","ticket":2}||{"key":"Designator","value":"X9"}|',
        ],
      },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.findings).toEqual([])
  })

  it('does not require a NET attr for the designator check', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY,
      { status: 'OK', projectUuid: 'p' },
      { pageUuids: ['pg-1'], sources: ['{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"U1"}|'] },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.findings).toEqual([])
  })

  it('accepts a TEXT sheet-symbol title as the block designator evidence', async () => {
    const hierarchicalIr: SchematicIr = {
      sheets: [{
        components: [{ id: 'blk1', kind: 'block', designator: 'POWER', sheetIndex: 0, position: { x: 0, y: 0 }, pins: [] }],
        wires: [], busEntries: [], junctions: [], attrs: [],
      }],
    }
    const { bridge } = scriptedBridge([EMPTY_LIBRARY,
      { status: 'OK', projectUuid: 'p' },
      { pageUuids: ['pg-1'], sources: ['{"type":"TEXT","id":"t1","ticket":1}||{"x":0,"y":0,"value":"POWER"}|'] },
    ])
    const report = await importIntoEasyEda(hierarchicalIr, { bridge })
    expect(report.findings.filter(f => f.code === 'SCHEMATIC_IMPORT_DESIGNATOR')).toEqual([])
  })

  it('treats a NET-only read-back as missing the designator', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY,
      { status: 'OK', projectUuid: 'p' },
      { pageUuids: ['pg-1'], sources: ['{"type":"ATTR","id":"a1","ticket":1}||{"key":"NET","value":"SIG"}|'] },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.findings.map(f => f.code)).toContain('SCHEMATIC_IMPORT_DESIGNATOR')
  })
})

describe('EasyEdaSchematicEngine.importProject discovery', () => {
  it('discovers the bridge when none is injected', async () => {
    let executions = 0
    const fetchFn = (async (input: unknown): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ service: 'easyeda-bridge', edaConnected: true }))
      }
      expect(url.endsWith('/execute')).toBe(true)
      const nth = executions++
      return new Response(JSON.stringify({
        result: nth === 0
          ? EMPTY_LIBRARY
          : nth === 1
            ? { status: 'OK', projectUuid: 'proj-live' }
            : { pageUuids: ['pg-1'], sources: ['{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"U1"}|'] },
      }))
    }) as typeof fetch
    const engine = new EasyEdaSchematicEngine({
      clientId: 't', bridgeHost: '127.0.0.1', bridgeTimeoutMs: 1000,
      bridgeQueryTimeoutMs: 1000, bridgeTimeoutStreakLimit: 3, bridgeCircuitCooldownMs: 1000,
      advisoryDrc: true, libraryUuid: 'lib-1',
    })
    const report = await engine.importProject(ir, { fetchFn })
    expect(report.projectUuid).toBe('proj-live')
  })
})
