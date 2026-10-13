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
  it('tolerates a response without a sources array', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY, { status: 'OK', projectUuid: 'p', pageUuids: ['pg'] }])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.findings).toEqual([])
  })

  it('stops reading back once every sheet is accounted for', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY, {
      status: 'OK',
      projectUuid: 'p',
      pageUuids: ['pg-1', 'pg-2'],
      sources: [
        '{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"U1"}|',
        '{"type":"ATTR","id":"a2","ticket":2}||{"key":"Designator","value":"X9"}|',
      ],
    }])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.findings).toEqual([])
  })

  it('does not require a NET attr for the designator check', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY, {
      status: 'OK',
      projectUuid: 'p',
      pageUuids: ['pg-1'],
      sources: ['{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"U1"}|'],
    }])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.findings).toEqual([])
  })

  it('treats a NET-only read-back as missing the designator', async () => {
    const { bridge } = scriptedBridge([EMPTY_LIBRARY, {
      status: 'OK',
      projectUuid: 'p',
      pageUuids: ['pg-1'],
      sources: ['{"type":"ATTR","id":"a1","ticket":1}||{"key":"NET","value":"SIG"}|'],
    }])
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
      const first = executions++ === 0
      return new Response(JSON.stringify({
        result: first
          ? EMPTY_LIBRARY
          : {
            status: 'OK',
            projectUuid: 'proj-live',
            pageUuids: ['pg-1'],
            sources: ['{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"U1"}|'],
          },
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
