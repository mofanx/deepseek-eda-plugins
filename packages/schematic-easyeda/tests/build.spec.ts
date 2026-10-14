import { describe, expect, it } from 'vitest'
import {
  EasyEdaSchematicEngine,
  buildIntoEasyEda,
  collectProjectLibrary,
  importIntoEasyEda,
  renderBlockChunkScript,
  renderComponentChunkScript,
  renderImportScript,
  renderImportReadbackScript,
  renderOracleScript,
  renderPrepareScript,
  renderSheetSymbolChunkScript,
  renderWireChunkScript,
  serializeEasyEdaProject,
  type EasyEdaBridge,
  type EasyEdaEmbeddedDoc,
} from '@deepseek-ai/dsh-plugin-eda-easyeda'
import type { SchematicIr } from '@deepseek-ai/dsh-plugin-eda-sch'
import { SchematicError } from '@deepseek-ai/dsh-plugin-eda-sch'

const ir: SchematicIr = {
  sheets: [{
    components: [
      {
        id: 'c1', kind: 'part', designator: 'U1', position: { x: 100, y: 200 }, rotation: 90,
        deviceUuid: 'dev-uuid', deviceLibraryUuid: 'sys-lib', partId: 'A',
        pins: [{ id: 'p1', name: 'OUT', number: '3', electric: 'OUTPUT', endpoint: { x: 110, y: 200 } }],
      },
      { id: 'nf1', kind: 'netflag', netName: 'GND', position: { x: 0, y: 0 }, pins: [] },
      { id: 'np1', kind: 'netport', netName: 'SIG', position: { x: 5, y: 0 }, pins: [] },
      { id: 'sh1', kind: 'short', position: { x: 9, y: 0 }, pins: [] },
      { id: 'ne1', kind: 'nonelec', position: { x: 15, y: 0 }, pins: [] },
    ],
    wires: [
      { id: 'w1', kind: 'wire', dots: [[0, 0, 100, 0]], net: 'SIG' },
      { id: 'w2', kind: 'bus', dots: [[0, 0, 5, 0], [9, 9, 9, 9]], net: 'A[1:2]' },
    ],
    busEntries: [{ id: 'b1', busNet: 'A[1:2]', order: 0, point: { x: 50, y: 10 } }],
    junctions: [],
    attrs: [{ id: 'a1', parentId: 'c1', key: 'Note', value: 'x' }],
  }],
}

/** A bridge that returns queued results and captures every executed body. `{reject}` steps throw. */
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
        const next = queue.shift()
        if (typeof next === 'object' && next !== null && 'reject' in next) throw (next as { reject: Error }).reject
        return next
      },
    },
  }
}

const prepareOk = { status: 'OK', failures: [], pageUuids: ['page-1'] }
const chunkOk = (created: number): { status: string; failures: never[]; created: number } => ({ status: 'OK', failures: [], created })
/** Oracle payload matching the fixture IR so no count/net findings arise. */
const oracleOk = { counts: [{ components: 5, wires: 2 }], nets: ['SIG', 'A[1:2]', 'GND'], drc: [] }

/**
 * Responses for the standard five-stage build of the fixture IR:
 * prepare, part chunk, marker chunk, wire chunk, read-back, oracle.
 */
function standardQueue(overrides: Partial<{
  prepare: unknown
  partChunk: unknown
  markerChunk: unknown
  wireChunk: unknown
  readback: unknown
  oracle: unknown
}> = {}): unknown[] {
  return [
    overrides.prepare ?? prepareOk,
    overrides.partChunk ?? chunkOk(1),
    overrides.markerChunk ?? chunkOk(4),
    overrides.wireChunk ?? chunkOk(2),
    overrides.readback ?? [null],
    overrides.oracle ?? oracleOk,
  ]
}

describe('renderPrepareScript', () => {
  it('embeds the payload and the page-preparation APIs', () => {
    const code = renderPrepareScript({ createDocument: true, sheets: [] })
    expect(code).toContain('"createDocument":true')
    for (const api of [
      'dmt_Project.getCurrentProjectInfo',
      'dmt_Schematic.getCurrentSchematicPageInfo',
      'dmt_Schematic.createSchematic',
      'dmt_Schematic.createSchematicPage',
      'dmt_EditorControl.openDocument',
    ]) {
      expect(code).toContain(api)
    }
    // Fresh-page targeting: create, activate, and identity-check a new page
    // per sheet instead of writing into the currently open document.
    expect(code).toContain('PAGE_ACTIVATE_FAILED')
    expect(code).toContain('active.uuid !== targetPageUuid')
    // The client can throw after the page is already created; the script
    // recovers the uuid by diffing the page list around the call.
    expect(code).toContain('beforePages.has')
    expect(code).toContain('fresh.length === 1')
    // No page at all is an explicit precondition, not a silent default.
    expect(code).toContain('NO_ACTIVE_PAGE')
  })
})

describe('renderComponentChunkScript', () => {
  it('scopes the device lookup and dedupes by position', () => {
    const code = renderComponentChunkScript([{
      irId: 'c1', kind: 'part', deviceUuid: 'dev-1', deviceLibraryUuid: 'sys-lib',
      x: 10, y: 20, rotation: 0, mirror: false, addIntoBom: true, addIntoPcb: true,
    }], 'page-1', 0)
    expect(code).toContain('lib_Device.get(c.deviceUuid, c.deviceLibraryUuid)')
    expect(code).toContain('sch_PrimitiveComponent.getAll')
    expect(code).toContain('openDocument')
    expect(code).toContain("'WRONG_PAGE'")
    for (const api of [
      'sch_PrimitiveComponent.create(',
      'sch_PrimitiveComponent.createNetFlag',
      'sch_PrimitiveComponent.createNetPort',
      'sch_PrimitiveComponent.createShortCircuitFlag',
      'sch_PrimitiveComponent.modify',
    ]) {
      expect(code).toContain(api)
    }
  })
})

describe('renderWireChunkScript', () => {
  it('creates wires and buses and dedupes on net+line', () => {
    const code = renderWireChunkScript([
      { irId: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'N' },
    ], 'page-1', 0)
    for (const api of ['sch_PrimitiveWire.create', 'sch_PrimitiveBus.create', 'sch_PrimitiveWire.getAll']) {
      expect(code).toContain(api)
    }
    expect(code).toContain('getState_Net')
    expect(code).toContain("'WRONG_PAGE'")
  })
})

describe('renderBlockChunkScript', () => {
  it('creates rectangles and titles, dedupes on geometry, and counts nothing', () => {
    const code = renderBlockChunkScript([
      { name: 'power', title: 'POWER SUPPLY', x: 20, y: 60, width: 170, height: 220, titleX: 40, titleY: 70 },
    ], 'page-1', 0)
    for (const token of [
      'sch_PrimitiveRectangle.getAll',
      'sch_PrimitiveText.getAll',
      'sch_PrimitiveRectangle.create(',
      'sch_PrimitiveText.create(',
      'getState_TopLeftX',
      'getState_Content',
      'openDocument',
      "'WRONG_PAGE'",
      'FRAME_FAILED',
      'created: 0',
    ]) {
      expect(code).toContain(token)
    }
  })
})

describe('renderSheetSymbolChunkScript', () => {
  it('draws box, title, and pin labels, dedupes on content, and counts nothing', () => {
    const code = renderSheetSymbolChunkScript([
      {
        irId: 'blk1', title: 'POWER', x: 290, y: 300, width: 80, height: 110, titleX: 298, titleY: 310,
        pins: [{ pinId: 'p1', name: 'VIN', x: 298, y: 340 }],
      },
    ], 'page-1', 0)
    for (const token of [
      'sch_PrimitiveRectangle.create(',
      'sch_PrimitiveText.getAll',
      'sch_PrimitiveText.create(',
      'getState_Content',
      '"title":"POWER"',
      '"name":"VIN"',
      'openDocument',
      "'WRONG_PAGE'",
      'FRAME_FAILED',
      'created: 0',
    ]) {
      expect(code).toContain(token)
    }
  })
})

describe('renderOracleScript', () => {
  it('collects counts, net names, and DRC detail', () => {
    const code = renderOracleScript(['page-1'], true)
    for (const token of ['sch_Drc.check', 'sch_PrimitiveComponent.getAll', 'sch_PrimitiveWire.getAll', 'sch_Net', 'sch_Netlist.getNetlist', '"page-1"']) {
      expect(code).toContain(token)
    }
    const noDrc = renderOracleScript(['page-1'], false)
    expect(noDrc).toContain('if (false)')
  })
})

describe('buildIntoEasyEda preconditions', () => {
  const codes: [string, string][] = [
    ['NO_PROJECT', 'SCHEMATIC_BUILD_NO_PROJECT'],
    ['NO_ACTIVE_PAGE', 'SCHEMATIC_BUILD_NO_ACTIVE_PAGE'],
    ['NO_SCHEMATIC', 'SCHEMATIC_BUILD_NO_ACTIVE_PAGE'],
    ['BIZARRE', 'SCHEMATIC_BUILD_PRECONDITION'],
  ]
  for (const [status, code] of codes) {
    it(`maps status ${status} to ${code}`, async () => {
      const { bridge } = scriptedBridge([{ status, failures: [], pageUuids: [] }])
      await expect(buildIntoEasyEda(ir, { bridge })).rejects.toThrow(expect.objectContaining({ code }))
    })
  }

  it('rejects a malformed prepare result as SCHEMATIC_BRIDGE_PROTOCOL', async () => {
    const { bridge } = scriptedBridge(['not-an-object'])
    await expect(buildIntoEasyEda(ir, { bridge })).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BRIDGE_PROTOCOL' }))
  })
})

describe('buildIntoEasyEda chunked placement', () => {
  it('executes prepare, one part chunk, batched markers, batched wires, read-back, oracle', async () => {
    const { bridge, calls } = scriptedBridge(standardQueue())
    const report = await buildIntoEasyEda(ir, { bridge })
    // 7 executions: prepare + part + markers + wires + drain probe + read-back + oracle.
    expect(calls).toHaveLength(7)
    expect(calls[0]).toContain('createSchematicPage')
    expect(calls[1]).toContain('"deviceUuid":"dev-uuid"')
    expect(calls[1]).toContain('"deviceLibraryUuid":"sys-lib"')
    expect(calls[1]).toContain('"subPartName":"A"')
    expect(calls[2]).toContain('"netName":"GND"')
    expect(calls[2]).toContain('"netName":"SIG"')
    expect(calls[3]).toContain('"net":"SIG"')
    expect(calls[4]).toBe('return true')
    expect(calls[5]).toContain('getDocumentSource')
    expect(calls[6]).toContain('counts')
    expect(report.created).toBe(7)
    expect(report.pageUuids).toEqual(['page-1'])
  })

  const blockedIr: SchematicIr = {
    sheets: [{
      ...ir.sheets[0]!,
      blocks: [{ name: 'pwr', title: 'PWR' }],
      components: ir.sheets[0]!.components.map(component => ({ ...component, block: 'pwr' })),
    }],
  }

  it('draws module frames after the electrical chunks without inflating the count', async () => {
    const { bridge, calls } = scriptedBridge([
      prepareOk,
      chunkOk(1),
      chunkOk(4),
      chunkOk(2),
      { status: 'OK', failures: [], created: 0 },
      [null],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(blockedIr, { bridge })
    expect(calls).toHaveLength(8)
    expect(calls[4]).toContain('sch_PrimitiveRectangle.create(')
    expect(calls[4]).toContain('sch_PrimitiveText.create(')
    expect(calls[4]).toContain('"title":"PWR"')
    expect(report.created).toBe(7)
    expect(report.findings.filter(f => f.severity === 'error')).toEqual([])
  })

  const hierarchicalIr: SchematicIr = {
    sheets: [{
      components: [
        ...ir.sheets[0]!.components,
        {
          id: 'blk1', kind: 'block', designator: 'POWER', sheetIndex: 1,
          position: { x: 300, y: 300 },
          pins: [{ id: 'p1', name: 'VIN', number: '1', electric: 'INPUT', endpoint: { x: 310, y: 340 } }],
        },
      ],
      wires: ir.sheets[0]!.wires,
      busEntries: [], junctions: [], attrs: [],
    }],
  }

  it('draws hierarchy blocks instead of placing them, outside the count invariant', async () => {
    const { bridge, calls } = scriptedBridge([
      prepareOk,
      chunkOk(1),
      chunkOk(4),
      chunkOk(2),
      { status: 'OK', failures: [], created: 0 },
      [null],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(hierarchicalIr, { bridge })
    // prepare + part + markers + wires + sheet-symbol chunk + drain + read-back + oracle.
    expect(calls).toHaveLength(8)
    // The block never reaches a component chunk: no NO_DEVICE failure, no
    // component placement call carries it.
    expect(calls.slice(1, 4).some(c => c.includes('"irId":"blk1"') && c.includes('sch_PrimitiveComponent.create('))).toBe(false)
    expect(calls[4]).toContain('sch_PrimitiveRectangle.create(')
    expect(calls[4]).toContain('"title":"POWER"')
    expect(calls[4]).toContain('"name":"VIN"')
    // The oracle's component count (5) matches the fixture without the block.
    expect(report.findings.filter(f => f.severity === 'error')).toEqual([])
    expect(report.created).toBe(7)
  })

  it('accepts the sheet-symbol title TEXT as the block designator evidence', async () => {
    const { bridge } = scriptedBridge([
      prepareOk,
      chunkOk(1),
      chunkOk(4),
      chunkOk(2),
      { status: 'OK', failures: [], created: 0 },
      ['{"type":"TEXT","id":"t1","ticket":9}||{"x":298,"y":-310,"value":"POWER"}|'],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(hierarchicalIr, { bridge })
    expect(report.findings.filter(f => f.code === 'SCHEMATIC_ROUNDTRIP_DESIGNATOR' && f.locator?.componentId === 'blk1')).toEqual([])
  })

  it('warns when the read-back has no sheet-symbol title for a block', async () => {
    const { bridge } = scriptedBridge([
      prepareOk,
      chunkOk(1),
      chunkOk(4),
      chunkOk(2),
      { status: 'OK', failures: [], created: 0 },
      ['{"type":"TEXT","id":"t1","ticket":9}||{"x":298,"y":-310,"value":"OTHER"}|'],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(hierarchicalIr, { bridge })
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_ROUNDTRIP_DESIGNATOR' && f.locator?.componentId === 'blk1')
    expect(finding?.severity).toBe('warning')
    expect(finding?.message).toContain('POWER')
  })

  for (const [thrown, detail] of [[new Error('bridge exploded'), 'bridge exploded'], ['plain-string failure', 'plain-string failure']] as const) {
    it(`reports a sheet-symbol chunk failure as warnings, never errors (${typeof thrown})`, async () => {
      const { bridge } = scriptedBridge([
        prepareOk,
        chunkOk(1),
        chunkOk(4),
        chunkOk(2),
        { reject: thrown },
        [null],
        oracleOk,
      ])
      const report = await buildIntoEasyEda(hierarchicalIr, { bridge, retries: 0 })
      const finding = report.findings.find(f => f.code === 'SCHEMATIC_BUILD_FRAME_FAILED' && f.locator?.componentId === 'blk1')
      expect(finding?.severity).toBe('warning')
      expect(finding?.message).toContain(detail)
      expect(report.findings.filter(f => f.severity === 'error')).toEqual([])
    })
  }

  it('reports a frame create failure as a warning, never an error', async () => {
    const { bridge } = scriptedBridge([
      prepareOk,
      chunkOk(1),
      chunkOk(4),
      chunkOk(2),
      { status: 'OK', failures: [{ code: 'FRAME_FAILED', irId: 'block:pwr', sheetIndex: 0 }], created: 0 },
      [null],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(blockedIr, { bridge })
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_BUILD_FRAME_FAILED')
    expect(finding?.severity).toBe('warning')
    expect(finding?.message).toContain('module frame')
  })

  it('degrades an unreachable frame chunk to warnings instead of CHUNK_FAILED errors', async () => {
    const { bridge } = scriptedBridge([
      prepareOk,
      chunkOk(1),
      chunkOk(4),
      chunkOk(2),
      { reject: new Error('wedged') },
      { reject: new Error('wedged') },
      [null],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(blockedIr, { bridge, retries: 1, retryBackoffMs: 0 })
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_BUILD_FRAME_FAILED')
    expect(finding?.severity).toBe('warning')
    expect(finding?.message).toContain('wedged')
  })

  it('renders a non-Error frame-chunk rejection verbatim', async () => {
    const { bridge } = scriptedBridge([
      prepareOk,
      chunkOk(1),
      chunkOk(4),
      chunkOk(2),
      { reject: 'socket gone' },
      [null],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(blockedIr, { bridge, retries: 0, retryBackoffMs: 0 })
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_BUILD_FRAME_FAILED')
    expect(finding?.message).toContain('socket gone')
  })

  it('retries a timed-out chunk before reporting failure', async () => {
    const { bridge, calls } = scriptedBridge([
      prepareOk,
      { reject: new SchematicError('timed out', 'SCHEMATIC_BRIDGE_TIMEOUT') },
      chunkOk(1),
      chunkOk(4),
      chunkOk(2),
      [null],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(ir, { bridge, retryBackoffMs: 0 })
    expect(calls).toHaveLength(8)
    expect(report.created).toBe(7)
    expect(report.findings.filter(f => f.severity === 'error')).toEqual([])
  })

  it('reports CHUNK_FAILED after retries are exhausted', async () => {
    const { bridge, calls } = scriptedBridge([
      prepareOk,
      { reject: new SchematicError('t', 'SCHEMATIC_BRIDGE_TIMEOUT') },
      { reject: new SchematicError('t', 'SCHEMATIC_BRIDGE_TIMEOUT') },
      { reject: new SchematicError('t', 'SCHEMATIC_BRIDGE_TIMEOUT') },
      chunkOk(4),
      chunkOk(2),
      [null],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(ir, { bridge, retryBackoffMs: 0 })
    expect(calls).toHaveLength(9)
    const chunkFailures = report.findings.filter(f => f.code === 'SCHEMATIC_BUILD_PRIMITIVE_FAILED' && f.message.includes('after retries'))
    expect(chunkFailures).toHaveLength(1)
    expect(chunkFailures[0]?.severity).toBe('error')
    expect(chunkFailures[0]?.locator?.componentId).toBe('c1')
  })

  it('does not retry a circuit-open bridge', async () => {
    const { bridge, calls } = scriptedBridge([
      prepareOk,
      { reject: new SchematicError('open', 'SCHEMATIC_BRIDGE_CIRCUIT_OPEN') },
      chunkOk(4),
      chunkOk(2),
      [null],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(ir, { bridge })
    // No retry on the part chunk.
    expect(calls).toHaveLength(7)
    expect(report.findings.some(f => f.message.includes('after retries'))).toBe(true)
  })

  it('aborts after three consecutive chunk failures', async () => {
    const timeout = (): { reject: Error } => ({ reject: new SchematicError('t', 'SCHEMATIC_BRIDGE_TIMEOUT') })
    const { bridge } = scriptedBridge([
      prepareOk,
      timeout(), timeout(), timeout(),
      timeout(), timeout(), timeout(),
      timeout(), timeout(), timeout(),
      [null],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(ir, { bridge, retryBackoffMs: 0 })
    const aborted = report.findings.find(f => f.code === 'SCHEMATIC_BUILD_ABORTED')
    expect(aborted?.severity).toBe('error')
  })

  it('breaks the chunk loop after the failure streak reaches three', async () => {
    const twoParts: SchematicIr = {
      sheets: [{
        ...ir.sheets[0]!,
        components: [
          ...ir.sheets[0]!.components,
          { id: 'c2', kind: 'part', designator: 'U2', position: { x: 1, y: 1 }, deviceUuid: 'd2', pins: [] },
        ],
      }],
    }
    const fail = (): { reject: Error } => ({ reject: new Error('down') })
    const { bridge, calls } = scriptedBridge([
      prepareOk, fail(), fail(), fail(),
      [null], { counts: [{ components: 6, wires: 2 }], nets: ['SIG', 'A[1:2]', 'GND'], drc: [] },
    ])
    const report = await buildIntoEasyEda(twoParts, { bridge, retries: 0 })
    // 4 chunks exist but the 4th is skipped once the streak hits 3.
    expect(calls).toHaveLength(7)
    expect(calls[5]).toContain('getDocumentSource')
    expect(report.findings.find(f => f.code === 'SCHEMATIC_BUILD_ABORTED')?.severity).toBe('error')
  })

  it('reports a malformed chunk result and a plain-Error throw through retries', async () => {
    const { bridge } = scriptedBridge([
      prepareOk,
      42, 42, 42,
      chunkOk(4),
      { reject: new Error('plain-failure') }, { reject: new Error('plain-failure') }, { reject: new Error('plain-failure') },
      [null],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(ir, { bridge, retryBackoffMs: 0 })
    expect(report.findings.some(f => f.message.includes('unrecognized result shape'))).toBe(true)
    expect(report.findings.some(f => f.message.includes('(plain-failure)'))).toBe(true)
  })

  it('fails a WRONG_PAGE chunk as a page-activation error through retries', async () => {
    const wrong = { status: 'WRONG_PAGE', failures: [], created: 0 }
    const { bridge } = scriptedBridge([
      prepareOk, wrong, wrong, wrong,
      chunkOk(4), chunkOk(2), [null], oracleOk,
    ])
    const report = await buildIntoEasyEda(ir, { bridge, retryBackoffMs: 0 })
    expect(report.findings.some(f => f.message.includes('could not be re-activated'))).toBe(true)
  })

  it('resends the drain probe while the gateway is still busy', async () => {
    // First probe dies (queued work still applying); the retry succeeds and
    // the read-back proceeds normally.
    let probeFails = 1
    const calls: string[] = []
    const queue = standardQueue()
    const bridge: EasyEdaBridge = {
      async execute(code: string) {
        calls.push(code)
        if (code === 'return true') {
          if (probeFails-- > 0) throw new Error('gateway busy')
          return true
        }
        return queue.shift()
      },
    }
    const report = await buildIntoEasyEda(ir, { bridge, retryBackoffMs: 0 })
    expect(calls.filter(c => c === 'return true')).toHaveLength(2)
    expect(calls.some(c => c.includes('getDocumentSource'))).toBe(true)
    expect(report.created).toBe(7)
  })

  it('reports chunk failures when a non-positive retry budget throws the last error', async () => {
    const { bridge, calls } = scriptedBridge([prepareOk])
    const report = await buildIntoEasyEda(ir, { bridge, retries: -1 })
    // prepare + drain probe + read-back + oracle; no chunk ever reaches execute.
    expect(calls).toHaveLength(4)
    const failed = report.findings.filter(f => f.message.includes('failed after retries'))
    // One finding per irId in each failed chunk: 1 part + 4 markers + 2 wires.
    expect(failed).toHaveLength(7)
    expect(failed.some(f => f.message.includes('(undefined)'))).toBe(true)
    expect(report.findings.find(f => f.code === 'SCHEMATIC_BUILD_ABORTED')).toBeDefined()
  })
})

describe('buildIntoEasyEda findings', () => {
  it('maps script failures to stable finding codes and severities', async () => {
    const { bridge } = scriptedBridge(standardQueue({
      prepare: {
        status: 'OK',
        failures: [
          { code: 'PAGE_CREATE_FAILED', sheetIndex: 1 },
          { code: 'PAGE_ACTIVATE_FAILED', sheetIndex: 1 },
        ],
        pageUuids: ['p1'],
      },
      partChunk: {
        status: 'OK',
        failures: [
          { code: 'NO_DEVICE', irId: 'c1', sheetIndex: 0 },
          { code: 'DEVICE_NOT_FOUND', irId: 'c1', sheetIndex: 0 },
        ],
        created: 0,
      },
      markerChunk: {
        status: 'OK',
        failures: [
          { code: 'CREATE_THROWN', irId: 'nf1', sheetIndex: 0, detail: 'kaboom' },
          { code: 'UNSUPPORTED_KIND', irId: 'ne1', sheetIndex: 0, kind: 'nonelec' },
        ],
        created: 3,
      },
      wireChunk: {
        status: 'OK',
        failures: [
          { code: 'MISSING_NET', irId: 'w1', sheetIndex: 0 },
          { code: 'CREATE_FAILED', irId: 'w2', sheetIndex: 0 },
        ],
        created: 0,
      },
    }))
    const report = await buildIntoEasyEda(ir, { bridge, advisoryDrc: false })
    const byCode = new Map(report.findings.map(f => [f.code, f]))
    for (const code of [
      'SCHEMATIC_BUILD_NO_DEVICE',
      'SCHEMATIC_BUILD_DEVICE_NOT_FOUND',
      'SCHEMATIC_BUILD_MISSING_NET',
      'SCHEMATIC_BUILD_PRIMITIVE_FAILED',
      'SCHEMATIC_BUILD_PAGE_CREATE',
      'SCHEMATIC_BUILD_PAGE_ACTIVATE',
    ]) {
      expect(byCode.get(code)?.severity).toBe('error')
    }
    for (const code of ['SCHEMATIC_BUILD_UNSUPPORTED_KIND', 'SCHEMATIC_BUILD_UNSUPPORTED_BUSENTRY', 'SCHEMATIC_BUILD_UNSUPPORTED_ATTR']) {
      expect(byCode.get(code)?.severity).toBe('warning')
    }
    expect(byCode.get('SCHEMATIC_BUILD_NO_DEVICE')?.locator?.designator).toBe('U1')
    expect(report.findings.find(f => f.message.includes('kaboom'))).toBeDefined()
    expect(report.findings.find(f => f.message.includes('no live placement path'))).toBeDefined()
  })

  it('renders fallback text for failures lacking ids, detail, or known codes', async () => {
    const { bridge } = scriptedBridge(standardQueue({
      wireChunk: {
        status: 'OK',
        failures: [
          { code: 'CREATE_THROWN', irId: 'w1', sheetIndex: 0 },
          { code: 'MYSTERY', sheetIndex: 3 },
          { code: 'MYSTERY2' },
        ],
        created: 0,
      },
      markerChunk: { status: 'OK', failures: [{ code: 'UNSUPPORTED_KIND', irId: 'ne1', sheetIndex: 0 }], created: 3 },
    }))
    const report = await buildIntoEasyEda(ir, { bridge })
    const messages = report.findings.map(f => f.message)
    expect(messages.some(m => m === 'primitive "w1": the client create call threw')).toBe(true)
    expect(messages.some(m => m.includes('kind "?"'))).toBe(true)
    expect(messages.some(m => m === 'primitive "sheet 3": build failed')).toBe(true)
    expect(messages.some(m => m === 'primitive "sheet ?": build failed')).toBe(true)
  })

  it('reports a script-level CHUNK_FAILED without a detail suffix', async () => {
    const { bridge } = scriptedBridge(standardQueue({
      markerChunk: {
        status: 'OK',
        failures: [{ code: 'CHUNK_FAILED', irId: 'nf1', sheetIndex: 0 }],
        created: 3,
      },
    }))
    const report = await buildIntoEasyEda(ir, { bridge })
    const finding = report.findings.find(f => f.message.includes('failed after retries'))
    expect(finding?.message.endsWith('after retries')).toBe(true)
  })

  it('defaults missing positions and wire dots in the payload', async () => {
    const sparse: SchematicIr = {
      sheets: [{
        components: [{ id: 'cx', kind: 'part', deviceUuid: 'd', pins: [] }],
        wires: [{ id: 'wx', kind: 'wire' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    const { bridge, calls } = scriptedBridge([{ status: 'NO_PROJECT', failures: [], pageUuids: [] }])
    await expect(buildIntoEasyEda(sparse, { bridge })).rejects.toThrow()
    const payload = JSON.parse(calls[0]!.match(/const doc = (.*);/)?.[1] ?? '{}') as {
      sheets: { components: { x: number; y: number }[]; wires: { dots: number[][] }[] }[]
    }
    expect(payload.sheets[0]!.components[0]).toMatchObject({ x: 0, y: 0 })
    expect(payload.sheets[0]!.wires[0]!.dots).toEqual([])
  })

  it('skips sheets whose page uuid the prepare stage did not return', async () => {
    const twoSheets: SchematicIr = {
      sheets: [
        ir.sheets[0]!,
        { ...ir.sheets[0]!, components: ir.sheets[0]!.components.map(c => ({ ...c, id: `${c.id}b` })) },
      ],
    }
    const { bridge, calls } = scriptedBridge([
      { status: 'OK', failures: [], pageUuids: ['page-1'] },
      chunkOk(1), chunkOk(4), chunkOk(2),
      [null],
      { counts: [{ components: 5, wires: 2 }], nets: ['SIG', 'A[1:2]', 'GND'], drc: [] },
    ])
    const report = await buildIntoEasyEda(twoSheets, { bridge })
    expect(report.pageUuids).toEqual(['page-1'])
    expect(calls.every(c => !c.includes('page-2'))).toBe(true)
  })

  it('omits the payload net field for wires that carry none', async () => {
    const bare: SchematicIr = {
      sheets: [{ ...ir.sheets[0]!, wires: [{ id: 'w0', kind: 'wire', dots: [[0, 0, 1, 0]] }] }],
    }
    const { bridge, calls } = scriptedBridge([{ status: 'NO_PROJECT', failures: [], pageUuids: [] }])
    await expect(buildIntoEasyEda(bare, { bridge })).rejects.toThrow()
    const payload = JSON.parse(calls[0]!.match(/const doc = (.*);/)?.[1] ?? '{}') as { sheets: { wires: { id: string; net?: string }[] }[] }
    expect(payload.sheets[0]!.wires[0]).toEqual({ irId: 'w0', kind: 'wire', dots: [[0, 0, 1, 0]] })
  })
})

describe('buildIntoEasyEda read-back diff', () => {
  const source =
    '{"type":"DOCHEAD"}||{"docType":"SCH_PAGE","uuid":"p1","client":"dsh"}|\n' +
    '{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"U1"}|\n' +
    '{"type":"ATTR","id":"a2","ticket":2}||{"key":"NET","value":"SIG"}|\n' +
    'garbage-line-without-separator\n' +
    '{"type":"ATTR","id":"a3","ticket":3}||{bad json\n'

  it('emits no round-trip findings when designators and nets read back', async () => {
    const withNet: SchematicIr = {
      sheets: [{ ...ir.sheets[0]!, wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 1, 0]], net: 'SIG' }] }],
    }
    const singleWire = { counts: [{ components: 5, wires: 1 }], nets: ['SIG', 'GND'], drc: [] }
    const { bridge } = scriptedBridge(standardQueue({ readback: [source], oracle: singleWire }))
    const report = await buildIntoEasyEda(withNet, { bridge })
    expect(report.findings.filter(f => f.code.startsWith('SCHEMATIC_ROUNDTRIP'))).toEqual([])
  })

  it('flags missing designators and nets as round-trip warnings', async () => {
    const { bridge } = scriptedBridge(standardQueue({ readback: [source] }))
    const report = await buildIntoEasyEda(ir, { bridge })
    const codes = report.findings.map(f => f.code)
    expect(codes).toContain('SCHEMATIC_ROUNDTRIP_NET')
    const net = report.findings.find(f => f.code === 'SCHEMATIC_ROUNDTRIP_NET')
    expect(net?.severity).toBe('warning')
    expect(net?.locator?.net).toBe('A[1:2]')
  })

  it('reports SCHEMATIC_ROUNDTRIP_UNAVAILABLE for unreadable pages', async () => {
    const { bridge } = scriptedBridge(standardQueue())
    const report = await buildIntoEasyEda(ir, { bridge })
    expect(report.findings.map(f => f.code)).toContain('SCHEMATIC_ROUNDTRIP_UNAVAILABLE')
  })

  it('reports SCHEMATIC_ROUNDTRIP_UNAVAILABLE when sources are not an array', async () => {
    const { bridge } = scriptedBridge(standardQueue({ readback: 'oops' }))
    const report = await buildIntoEasyEda(ir, { bridge })
    expect(report.findings.map(f => f.code)).toContain('SCHEMATIC_ROUNDTRIP_UNAVAILABLE')
  })

  it('diffs the pin→net map structurally and errors on dropped wire geometry', async () => {
    const sheet = ir.sheets[0]!
    const head = sheet.components[0]!
    const wired: SchematicIr = {
      sheets: [{
        ...sheet,
        components: [
          { ...head, pins: [{ ...head.pins[0]!, endpoint: { x: 550, y: 500 } }] },
          ...sheet.components.slice(1),
        ],
        wires: [{ id: 'w1', kind: 'wire', dots: [[500, 500, 600, 500]], net: 'SIG' }],
      }],
    }
    const oracle = { counts: [{ components: 5, wires: 1 }], nets: ['SIG', 'GND'], drc: [] }
    const { bridge } = scriptedBridge(standardQueue({ readback: [source], oracle }))
    const report = await buildIntoEasyEda(wired, { bridge })
    const dropped = report.findings.filter(f => f.code === 'SCHEMATIC_NETLIST_DROPPED')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.severity).toBe('error')
    expect(dropped[0]?.locator?.net).toBe('SIG')
  })

  it('degrades a read-back bridge failure to SCHEMATIC_ROUNDTRIP_UNAVAILABLE, not a thrown build', async () => {
    const { bridge } = scriptedBridge(standardQueue({ readback: { reject: new SchematicError('timed out', 'SCHEMATIC_BRIDGE_TIMEOUT') } }))
    const report = await buildIntoEasyEda(ir, { bridge })
    expect(report.created).toBe(7)
    expect(report.pageUuids).toEqual(['page-1'])
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_ROUNDTRIP_UNAVAILABLE')
    expect(finding?.message).toContain('timed out')
  })

  it('reports SCHEMATIC_ROUNDTRIP_UNAVAILABLE without detail when the read deadline already lapsed', async () => {
    const { bridge } = scriptedBridge(standardQueue())
    const report = await buildIntoEasyEda(ir, { bridge, timeoutMs: 0 })
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_ROUNDTRIP_UNAVAILABLE')
    expect(finding?.message).toBe('document sources could not be read back for verification')
  })

  it('tolerates read-back entries beyond the built page list', async () => {
    const { bridge } = scriptedBridge([
      { status: 'OK', failures: [], pageUuids: ['page-1', 'page-x'] },
      chunkOk(1), chunkOk(4), chunkOk(2),
      [null, null, null],
      oracleOk,
    ])
    const report = await buildIntoEasyEda(ir, { bridge })
    expect(report.pageUuids).toEqual(['page-1', 'page-x'])
    expect(report.findings.filter(f => f.code === 'SCHEMATIC_ROUNDTRIP_UNAVAILABLE')).toHaveLength(1)
  })

  it('skips ATTR records whose key or value is not a string', async () => {
    const weird = '{"type":"ATTR","id":"a9","ticket":1}||{"key":"K","value":7}|'
    const { bridge } = scriptedBridge(standardQueue({ readback: [weird] }))
    const report = await buildIntoEasyEda(ir, { bridge })
    expect(report.findings.map(f => f.code)).toEqual(expect.arrayContaining(['SCHEMATIC_ROUNDTRIP_DESIGNATOR', 'SCHEMATIC_ROUNDTRIP_NET']))
  })

  it('reconciles pin endpoints against symbolPins when provided', async () => {
    // c1: position (100,200) rotation 90, pin 3 endpoint (110,200). Symbol pin
    // 3 at (0,10) transforms to (-10,0) — the real pin sits at (90,200), so
    // the declared endpoint misses it.
    const boundIr: SchematicIr = {
      sheets: [{
        ...ir.sheets[0]!,
        components: [{ ...ir.sheets[0]!.components[0]!, symbolUuid: 'sym-u' }, ...ir.sheets[0]!.components.slice(1)],
      }],
    }
    const symbolPins = new Map([['sym-u', [{ number: '3', x: 0, y: 10 }]]])
    const { bridge } = scriptedBridge(standardQueue({ readback: [source] }))
    const report = await buildIntoEasyEda(boundIr, { bridge, symbolPins })
    const offPin = report.findings.filter(f => f.code === 'WIRE_NOT_ON_PIN')
    expect(offPin).toHaveLength(1)
    expect(offPin[0]?.severity).toBe('error')
    expect(offPin[0]?.locator).toMatchObject({ componentId: 'c1', pinNumber: '3' })
    // Without the geometry snapshot the same defect stays invisible.
    const blind = scriptedBridge(standardQueue({ readback: [source] }))
    const blindReport = await buildIntoEasyEda(boundIr, { bridge: blind.bridge })
    expect(blindReport.findings.filter(f => f.code === 'WIRE_NOT_ON_PIN')).toEqual([])
  })
})

describe('buildIntoEasyEda client oracle', () => {
  it('errors on count mismatches', async () => {
    const { bridge } = scriptedBridge(standardQueue({ oracle: { counts: [{ components: 4, wires: 2 }], nets: ['SIG', 'A[1:2]', 'GND'], drc: [] } }))
    const report = await buildIntoEasyEda(ir, { bridge })
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_EDA_COUNT_MISMATCH')
    expect(finding?.severity).toBe('error')
    expect(finding?.message).toContain('expected 5')
  })

  it('errors on missing client nets', async () => {
    const { bridge } = scriptedBridge(standardQueue({ oracle: { counts: [{ components: 5, wires: 2 }], nets: ['SIG'], drc: [] } }))
    const report = await buildIntoEasyEda(ir, { bridge })
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_EDA_NET_MISMATCH')
    expect(finding?.severity).toBe('error')
    expect(finding?.locator?.net).toBe('A[1:2]')
  })

  it('warns when the client netlist cannot be read', async () => {
    const { bridge } = scriptedBridge(standardQueue({ oracle: { counts: [{ components: 5, wires: 2 }], netsError: 'nope', drc: [] } }))
    const report = await buildIntoEasyEda(ir, { bridge })
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_EDA_NETLIST_UNAVAILABLE')
    expect(finding?.severity).toBe('warning')
    expect(finding?.message).toContain('nope')
  })

  it('reconciles per-net pads so a mirrored attachment cannot pass on names alone', async () => {
    // Same design as the y-sign bug: the client wires each net to the other
    // pin of the same part, which leaves every net *name* intact.
    const mapped: SchematicIr = {
      sheets: [{
        components: [{
          id: 'c1', kind: 'part', designator: 'U1', position: { x: 100, y: 200 },
          pins: [
            { id: 'p1', name: 'D', number: '4', electric: 'BI', net: 'RAIL', endpoint: { x: 110, y: 200 } },
            { id: 'p2', name: 'S', number: '3', electric: 'BI', net: 'VIN', endpoint: { x: 90, y: 200 } },
          ],
        }],
        wires: [
          { id: 'w1', kind: 'wire', dots: [[0, 0, 100, 0]], net: 'RAIL' },
          { id: 'w2', kind: 'wire', dots: [[0, 10, 100, 10]], net: 'VIN' },
        ],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    // No markers in this IR, so the build is prepare, part, wire, read-back, oracle.
    const queue = (oracle: unknown): unknown[] => [prepareOk, chunkOk(1), chunkOk(2), [null], oracle]
    const counts = [{ components: 1, wires: 2 }]

    const matching = scriptedBridge(queue({ counts, nets: ['RAIL', 'VIN'], netPads: { RAIL: ['U1-4'], VIN: ['U1-3'] }, drc: [] }))
    const clean = await buildIntoEasyEda(mapped, { bridge: matching.bridge })
    expect(clean.findings.filter(f => f.code === 'SCHEMATIC_EDA_NET_PAD_MISMATCH')).toHaveLength(0)

    const mirrored = scriptedBridge(queue({ counts, nets: ['RAIL', 'VIN'], netPads: { RAIL: ['U1-3'], VIN: ['U1-4'] }, drc: [] }))
    const report = await buildIntoEasyEda(mapped, { bridge: mirrored.bridge })
    const pads = report.findings.filter(f => f.code === 'SCHEMATIC_EDA_NET_PAD_MISMATCH')
    expect(pads).toHaveLength(2)
    expect(pads[0]?.severity).toBe('error')
    expect(pads[0]?.locator?.net).toBe('RAIL')
    expect(pads[0]?.message).toContain('U1-4')
    expect(pads[0]?.message).toContain('U1-3')
  })

  it('ignores pads that belong to another page of the same project', async () => {
    const mapped: SchematicIr = {
      sheets: [{
        components: [{
          id: 'c1', kind: 'part', designator: 'U1', position: { x: 100, y: 200 },
          pins: [{ id: 'p1', name: 'D', number: '4', electric: 'BI', net: 'RAIL', endpoint: { x: 110, y: 200 } }],
        }],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 100, 0]], net: 'RAIL' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    // The client netlist is project-wide: R7 lives on another page.
    const { bridge } = scriptedBridge([
      prepareOk, chunkOk(1), chunkOk(1), [null],
      { counts: [{ components: 1, wires: 1 }], nets: ['RAIL'], netPads: { RAIL: ['U1-4', 'R7-1'] }, drc: [] },
    ])
    const report = await buildIntoEasyEda(mapped, { bridge })
    expect(report.findings.filter(f => f.code === 'SCHEMATIC_EDA_NET_PAD_MISMATCH')).toHaveLength(0)
  })

  it('skips pad rows and pins that cannot join the designator-pin comparison', async () => {
    const mapped: SchematicIr = {
      sheets: [{
        components: [
          {
            id: 'c1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 },
            pins: [
              { id: 'p1', name: 'D', number: '4', electric: 'BI', net: 'RAIL', endpoint: { x: 0, y: 0 } },
              { id: 'p2', name: 'S', number: '5', electric: 'BI', net: 'VIN', endpoint: { x: 0, y: 0 } },
              { id: 'p3', name: 'NC', number: '6', electric: 'BI', endpoint: { x: 0, y: 0 } },
              { id: 'p4', name: 'X', electric: 'BI', net: 'RAIL', endpoint: { x: 0, y: 0 } },
            ],
          },
          // No designator: its pins can never form a DESIGNATOR-PIN pad.
          { id: 'c2', kind: 'part', pins: [{ id: 'p5', name: 'Y', number: '1', electric: 'BI', net: 'RAIL', endpoint: { x: 0, y: 0 } }] },
          { id: 'nf', kind: 'netflag', netName: 'GND', pins: [] },
        ],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'RAIL' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    const { bridge } = scriptedBridge([
      prepareOk, chunkOk(1), chunkOk(1), chunkOk(1), chunkOk(1), [null],
      {
        counts: [{ components: 3, wires: 1 }],
        nets: ['RAIL'],
        // Non-string pad rows drop; VIN's payload is not a pad array at all.
        netPads: { RAIL: ['U1-4', 7], VIN: 'oops' },
        drc: [],
      },
    ])
    const report = await buildIntoEasyEda(mapped, { bridge })
    expect(report.findings.filter(f => f.code === 'SCHEMATIC_EDA_NET_PAD_MISMATCH')).toHaveLength(0)
  })

  it('treats a zero-wire snapshot as missing evidence, not as a wrong netlist', async () => {
    const mapped: SchematicIr = {
      sheets: [{
        components: [{
          id: 'c1', kind: 'part', designator: 'U1', position: { x: 100, y: 200 },
          pins: [{ id: 'p1', name: 'D', number: '4', electric: 'BI', net: 'RAIL', endpoint: { x: 110, y: 200 } }],
        }],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 100, 0]], net: 'RAIL' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    // What the client answers when the oracle runs before it has rebuilt
    // connectivity: the IR's 1 wire is invisible, so nothing else is evidence.
    const { bridge } = scriptedBridge([
      prepareOk, chunkOk(1), chunkOk(1), [null],
      { counts: [{ components: 1, wires: 0 }], nets: [], netPads: {}, drc: [] },
    ])
    const report = await buildIntoEasyEda(mapped, { bridge })
    expect(report.findings.filter(f => f.code === 'SCHEMATIC_EDA_COUNT_MISMATCH')).toHaveLength(0)
    expect(report.findings.filter(f => f.code === 'SCHEMATIC_EDA_NET_MISMATCH')).toHaveLength(0)
    expect(report.findings.filter(f => f.code === 'SCHEMATIC_EDA_NET_PAD_MISMATCH')).toHaveLength(0)
    const missing = report.findings.find(f => f.code === 'SCHEMATIC_EDA_ORACLE_UNAVAILABLE')
    expect(missing?.severity).toBe('warning')
    expect(missing?.message).toContain('0 wire')
  })

  it('still errors on a zero-wire snapshot when placement itself was not confirmed', async () => {
    const mapped: SchematicIr = {
      sheets: [{
        components: [{
          id: 'c1', kind: 'part', designator: 'U1', position: { x: 100, y: 200 },
          pins: [{ id: 'p1', name: 'D', number: '4', electric: 'BI', net: 'RAIL', endpoint: { x: 110, y: 200 } }],
        }],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 100, 0]], net: 'RAIL' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    // The placement stage created nothing (2 expected), so an empty page is a
    // real failure rather than a snapshot taken too early.
    const { bridge } = scriptedBridge([
      prepareOk, chunkOk(0), chunkOk(0), [null],
      { counts: [{ components: 1, wires: 0 }], nets: [], netPads: {}, drc: [] },
    ])
    const report = await buildIntoEasyEda(mapped, { bridge })
    const mismatch = report.findings.find(f => f.code === 'SCHEMATIC_EDA_COUNT_MISMATCH')
    expect(mismatch?.severity).toBe('error')
    expect(report.findings.some(f => f.code === 'SCHEMATIC_EDA_ORACLE_UNAVAILABLE')).toBe(false)
  })

  it('warns when the whole oracle call fails', async () => {
    const { bridge } = scriptedBridge(standardQueue({ oracle: { reject: new Error('wedged') } }))
    const report = await buildIntoEasyEda(ir, { bridge })
    expect(report.findings.map(f => f.code)).toContain('SCHEMATIC_EDA_ORACLE_UNAVAILABLE')
  })

  it('classifies DRC detail by rule severity', async () => {
    const drc = [
      { type: 'fatalError', rule: '', primitives: [] },
      { type: 'error', rule: 'CHECKFLOATPIN', primitives: [{ designator: 'R1' }] },
      { type: 'warn', rule: 'SHOWFLOATING', primitives: [] },
      { type: 'warn', rule: 'SOMETHING_ELSE' },
    ]
    const { bridge } = scriptedBridge(standardQueue({ oracle: { ...oracleOk, drc } }))
    const report = await buildIntoEasyEda(ir, { bridge, advisoryDrc: true })
    const byCode = new Map(report.findings.map(f => [f.code, f]))
    expect(byCode.get('SCHEMATIC_EDA_ABNORMAL_DATA')?.severity).toBe('error')
    expect(byCode.get('SCHEMATIC_EDA_FLOATING_PIN')?.severity).toBe('error')
    expect(byCode.get('SCHEMATIC_EDA_FLOATING_NET')?.severity).toBe('warning')
    expect(byCode.get('SCHEMATIC_EDA_DRC')?.severity).toBe('warning')
  })

  it('degrades a thrown DRC call to SCHEMATIC_EDA_DRC_UNAVAILABLE', async () => {
    const { bridge } = scriptedBridge(standardQueue({ oracle: { counts: [{ components: 5, wires: 2 }], nets: ['SIG', 'A[1:2]', 'GND'], drcError: 'beta moved' } }))
    const report = await buildIntoEasyEda(ir, { bridge, advisoryDrc: true })
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_EDA_DRC_UNAVAILABLE')
    expect(finding?.severity).toBe('warning')
    expect(finding?.message).toContain('beta moved')
  })

  it('exempts pins the IR declares no-connect from the floating-pin error', async () => {
    const mapped: SchematicIr = {
      sheets: [{
        components: [{
          id: 'c1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 },
          pins: [
            { id: 'p1', name: 'OUT', number: '3', electric: 'OUTPUT', net: 'SIG', endpoint: { x: 10, y: 0 } },
            { id: 'p2', name: 'NC', number: '4', electric: 'BI', noConnect: true, endpoint: { x: -10, y: 0 } },
          ],
        }],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    const queue = (drc: unknown): unknown[] => [
      prepareOk, chunkOk(1), chunkOk(1), [null],
      { counts: [{ components: 1, wires: 1 }], nets: ['SIG'], drc },
    ]
    const declared = scriptedBridge(queue([{ type: 'warn', rule: 'CHECKFLOATPIN', primitives: [{ designator: 'U1', name: '4' }] }]))
    const clean = await buildIntoEasyEda(mapped, { bridge: declared.bridge, advisoryDrc: true })
    expect(clean.findings.filter(f => f.code === 'SCHEMATIC_EDA_FLOATING_PIN')).toHaveLength(0)

    const real = scriptedBridge(queue([{
      type: 'warn',
      rule: 'CHECKFLOATPIN',
      primitives: [{ designator: 'U1', name: '3' }, { designator: 'U1', name: '4' }],
    }]))
    const report = await buildIntoEasyEda(mapped, { bridge: real.bridge, advisoryDrc: true })
    const floats = report.findings.filter(f => f.code === 'SCHEMATIC_EDA_FLOATING_PIN')
    expect(floats).toHaveLength(1)
    expect(floats[0]?.message).toContain('"name":"3"')
    expect(floats[0]?.message).not.toContain('"name":"4"')
  })

  it('keeps the raw DRC text when primitives are absent or unrecognizable', async () => {
    const { bridge } = scriptedBridge(standardQueue({
      oracle: {
        ...oracleOk,
        drc: [
          { type: 'warn', rule: 'CHECKFLOATPIN' },
          { type: 'warn', rule: 'CHECKFLOATPIN', primitives: ['junk', { designator: 'U1' }] },
        ],
      },
    }))
    const report = await buildIntoEasyEda(ir, { bridge, advisoryDrc: true })
    const floats = report.findings.filter(f => f.code === 'SCHEMATIC_EDA_FLOATING_PIN')
    expect(floats).toHaveLength(2)
    expect(floats[0]?.message).toContain('CHECKFLOATPIN')
    expect(floats[1]?.message).toContain('"designator":"U1"')
  })

  it('labels unreadable count entries and skips counts beyond built pages', async () => {
    const { bridge } = scriptedBridge(standardQueue({
      oracle: { counts: ['oops', 'extra'], nets: ['SIG', 'A[1:2]', 'GND'], drc: [] },
    }))
    const report = await buildIntoEasyEda(ir, { bridge })
    const mismatch = report.findings.find(f => f.code === 'SCHEMATIC_EDA_COUNT_MISMATCH')
    expect(mismatch?.message).toContain('unreadable')
    expect(report.findings.filter(f => f.code === 'SCHEMATIC_EDA_COUNT_MISMATCH')).toHaveLength(1)
  })

  it('warns on missing counts, missing nets, and non-array DRC detail', async () => {
    const { bridge } = scriptedBridge(standardQueue({ oracle: { drc: 'nope' } }))
    const report = await buildIntoEasyEda(ir, { bridge, advisoryDrc: true })
    expect(report.findings.some(f => f.code === 'SCHEMATIC_EDA_COUNT_MISMATCH')).toBe(false)
    const nets = report.findings.find(f => f.code === 'SCHEMATIC_EDA_NETLIST_UNAVAILABLE')
    expect(nets?.severity).toBe('warning')
    expect(nets?.message.endsWith('reconciliation')).toBe(true)
    const drc = report.findings.find(f => f.code === 'SCHEMATIC_EDA_DRC_UNAVAILABLE')
    expect(drc?.message).toContain('unexpected result')
  })

  it('classifies non-record DRC entries as abnormal data', async () => {
    const { bridge } = scriptedBridge(standardQueue({
      oracle: { ...oracleOk, drc: ['raw-text', { type: 'warn', primitives: [] }] },
    }))
    const report = await buildIntoEasyEda(ir, { bridge, advisoryDrc: true })
    const abnormal = report.findings.filter(f => f.code === 'SCHEMATIC_EDA_ABNORMAL_DATA')
    expect(abnormal).toHaveLength(2)
    expect(abnormal[0]?.message).toContain('raw-text')
  })

  it('skips the DRC call when advisoryDrc is off', async () => {
    const { bridge, calls } = scriptedBridge(standardQueue())
    await buildIntoEasyEda(ir, { bridge, advisoryDrc: false })
    expect(calls[6]).toContain('if (false)')
  })
})

describe('EasyEdaSchematicEngine.build', () => {
  const engine = new EasyEdaSchematicEngine({
    clientId: 't', bridgeHost: '127.0.0.1', bridgeTimeoutMs: 100,
    bridgeQueryTimeoutMs: 100, bridgeTimeoutStreakLimit: 3, bridgeCircuitCooldownMs: 100,
    advisoryDrc: true, libraryUuid: 'lib-1',
  })

  it('builds through an injected bridge and returns the report', async () => {
    const { bridge } = scriptedBridge(standardQueue())
    const report = await engine.build(ir, { bridge })
    expect(report.created).toBe(7)
    expect(report.pageUuids).toEqual(['page-1'])
  })

  it('discovers the bridge itself when none is injected', async () => {
    const seen: string[] = []
    const fetchFn = (async (input: unknown) => {
      const url = String(input)
      seen.push(url)
      if (url.endsWith('/health')) return new Response(JSON.stringify({ service: 'easyeda-bridge', edaConnected: true }), { status: 200 })
      return new Response(JSON.stringify({ result: { status: 'NO_PROJECT', failures: [], pageUuids: [] } }), { status: 200 })
    }) as typeof fetch
    await expect(engine.build(ir, { fetchFn })).rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_BUILD_NO_PROJECT' }))
    expect(seen.some(url => url.endsWith('/health'))).toBe(true)
  })

  it('honours the per-call advisoryDrc override', async () => {
    const { bridge, calls } = scriptedBridge(standardQueue())
    await engine.build(ir, { bridge, advisoryDrc: false })
    expect(calls).toHaveLength(7)
    expect(calls[6]).toContain('if (false)')
  })
})

describe('renderImportScript', () => {
  it('embeds a store-method zip writer and the BETA import call', () => {
    const pkg = serializeEasyEdaProject(ir, { title: 'T' })
    const code = renderImportScript(pkg, 'T')
    for (const token of [
      '0x04034b50',
      '0x02014b50',
      '0x06054b50',
      'crcTable',
      "'project2.json'",
      "'dsh-import.epru'",
      'dmt_Team.getAllTeamsInfo',
      "importProjectByProjectFile(file, 'JLCEDA Pro'",
      "'New Project'",
      'dmt_Project.getAllProjectsUuid',
      'dmt_Project.getProjectInfo',
    ]) {
      expect(code).toContain(token)
    }
    expect(code).toContain(JSON.stringify(pkg.epru))
    // Duplicate project names are resolved by suffixing before import.
    expect(code).toContain("+ ' v' + (attempt + 1)")
    // The script returns right after the import resolves; opening
    // confirmation and page read-back run in the separate request.
    expect(code).not.toContain('openProject')
    expect(code).not.toContain('getAllSchematicPagesInfo')
  })

  it('scopes the read-back stage to the archive page uuids', () => {
    const pkg = serializeEasyEdaProject(ir, { title: 'T' })
    const code = renderImportReadbackScript(pkg.pageUuids, 'uuid-1', 'T')
    for (const token of [
      'dmt_Project.getCurrentProjectInfo',
      'dmt_Project.openProject',
      'getSplitScreenTree',
      'dmt_Schematic.getAllSchematicPagesInfo',
      'dmt_Schematic.getCurrentSchematicPageInfo',
      'dmt_EditorControl.openDocument',
      'sys_FileManager.getDocumentSource',
      "'OPEN_FAILED'",
    ]) {
      expect(code).toContain(token)
    }
    expect(code).toContain(JSON.stringify(pkg.pageUuids))
    expect(code).toContain('active.uuid !== uuid')
  })

  it('enables the tab-close fallback only under allowTabClose', () => {
    const pkg = serializeEasyEdaProject(ir, { title: 'T' })
    const guarded = renderImportReadbackScript(pkg.pageUuids, 'uuid-1', 'T', false)
    const allowed = renderImportReadbackScript(pkg.pageUuids, 'uuid-1', 'T', true)
    expect(guarded).toContain('if (false)')
    expect(guarded).not.toContain('if (true)')
    expect(allowed).toContain('if (true)')
    expect(allowed).toContain('closeDocument')
  })
})

describe('collectProjectLibrary + embedded import', () => {
  const boundIr: SchematicIr = {
    sheets: [{
      components: [{
        id: 'c1', kind: 'part', designator: 'R1', position: { x: 10, y: 20 },
        deviceUuid: 'dev-1', deviceLibraryUuid: 'sys',
        symbolUuid: 'sym-1', symbolLibraryUuid: 'sys',
        footprintUuid: 'fp-1', footprintLibraryUuid: 'sys',
        pins: [],
      }],
      wires: [], busEntries: [], junctions: [], attrs: [],
    }],
  }
  const libDocs = {
    devices: {
      'dev-1': {
        info: {
          name: 'R0603', classification: ['电阻'],
          association: { symbolUuid: 'sym-1', footprintUuid: 'fp-1', images: [] },
          property: { otherProperty: { Symbol: 'sym-1', Footprint: 'fp-1', Value: '10k' } },
        },
        scope: 'sys',
      },
    },
    symbols: {
      'sym-1': {
        info: { name: 'R0603', description: 'res', classification: [], subPartNames: ['R0603.1'] },
        source: '{"type":"DOCHEAD","ticket":1}||{"docType":"SYMBOL","client":"lib","uuid":"sym-1","updateTime":1,"version":"1","user":{}}|\n' +
          '{"type":"PART","ticket":2,"id":"R0603.1"}||{"BBOX":[-10,-4,10,4]}|\n',
        scope: 'sys',
      },
    },
    footprints: {
      'fp-1': {
        info: { name: 'R0603', description: '', classification: [] },
        source: '{"type":"DOCHEAD","ticket":1}||{"docType":"FOOTPRINT","client":"lib","uuid":"fp-1","updateTime":1,"version":"1","user":{}}|\n',
        scope: 'sys',
      },
    },
    errors: [],
  }

  it('localizes fetched docs with META source and project-local uuids', async () => {
    const { bridge } = scriptedBridge([libDocs])
    const { library, findings } = await collectProjectLibrary(boundIr, bridge)
    expect(findings).toEqual([])
    expect(library.symbols).toHaveLength(1)
    const sym = library.symbols[0]
    expect(sym?.sourceUuid).toBe('sym-1')
    expect(sym?.localUuid).not.toBe('sym-1')
    expect(sym?.source).toContain(`"uuid":"${sym?.localUuid}"`)
    expect(sym?.source).not.toContain('"uuid":"sym-1"')
    expect(sym?.source).toContain('"docType":2')
    expect(sym?.source).toContain('"source":"sym-1|sys"')
    expect(sym?.partId).toBe('R0603.1')
    const dev = library.devices[0]
    expect(dev?.source).toContain('"docType":"DEVICE"')
    expect(dev?.source).toContain('"source":"dev-1|sys"')
    expect(dev?.source).toContain(`"Symbol":"${sym?.localUuid}"`)
    expect(dev?.source).toContain(`"Footprint":"${library.footprints[0]?.localUuid}"`)
    expect(dev?.source).toContain('SymbolName')
  })

  it('accepts the nested-object association form for symbol and footprint uuids', async () => {
    const nestedLibDocs = {
      ...libDocs,
      devices: {
        'dev-1': {
          info: {
            name: 'R0603', classification: ['电阻'],
            association: { symbol: { uuid: 'sym-1' }, footprint: { uuid: 'fp-1' }, images: [] },
            property: { otherProperty: { Symbol: 'sym-1', Footprint: 'fp-1', Value: '10k' } },
          },
          scope: 'sys',
        },
      },
    }
    const { bridge } = scriptedBridge([nestedLibDocs])
    const { library, findings } = await collectProjectLibrary(boundIr, bridge)
    expect(findings).toEqual([])
    const dev = library.devices[0]
    expect(dev?.source).toContain(`"Symbol":"${library.symbols[0]?.localUuid}"`)
    expect(dev?.source).toContain(`"Footprint":"${library.footprints[0]?.localUuid}"`)
  })

  it('rewrites component bindings to local uuids and fills partId', async () => {
    const { bridge } = scriptedBridge([libDocs])
    const { library } = await collectProjectLibrary(boundIr, bridge)
    const pkg = serializeEasyEdaProject(boundIr, { library })
    const docTypes = [...pkg.epru.matchAll(/"docType":"([A-Z_]+)"/g)].map(m => m[1])
    expect(docTypes).toEqual(expect.arrayContaining(['CONFIG', 'SCH', 'DEVICE', 'SYMBOL', 'FOOTPRINT', 'SCH_PAGE']))
    const comp = pkg.epru.split('\n').find(l => l.startsWith('{"type":"COMPONENT"'))
    expect(comp).toContain('"partId":"R0603.1"')
    const symAttr = pkg.epru.split('\n').find(l => l.includes('"key":"Symbol"'))
    expect(symAttr).toContain(`"value":"${library.symbols[0]?.localUuid}"`)
    const devAttr = pkg.epru.split('\n').find(l => l.includes('"key":"Device"'))
    expect(devAttr).toContain(`"value":"${library.devices[0]?.localUuid}"`)
    const fpAttr = pkg.epru.split('\n').find(l => l.includes('"key":"Footprint"'))
    expect(fpAttr).toContain(`"value":"${library.footprints[0]?.localUuid}"`)
  })

  it('surfaces per-binding fetch failures as LIBDOC findings', async () => {
    const { bridge } = scriptedBridge([{ devices: {}, symbols: {}, footprints: {}, errors: [{ kind: 'symbol', uuid: 'sym-1' }] }])
    const { findings } = await collectProjectLibrary(boundIr, bridge)
    expect(findings[0]?.code).toBe('SCHEMATIC_IMPORT_LIBDOC')
    expect(findings[0]?.severity).toBe('warning')
    expect(findings[0]?.message).toContain('sym-1')
  })

  it('emits Symbol/Device attrs on flag components resolved by net name', async () => {
    const flagIr: SchematicIr = {
      sheets: [{
        components: [{ id: 'f1', kind: 'netflag', netName: 'GND', position: { x: 0, y: 0 }, pins: [] }],
        wires: [], busEntries: [], junctions: [], attrs: [],
      }],
    }
    const flagSym = '{"type":"DOCHEAD","ticket":1}||{"docType":"SYMBOL","client":"lib","uuid":"fsym-1","user":{}}|\n' +
      '{"type":"PART","ticket":2,"id":"pid-flag"}||{"BBOX":[-10,0,10,-19]}|\n'
    const { bridge } = scriptedBridge([{
      devices: { 'fdev-1': { info: { name: 'Ground-GND', classification: [], association: { symbolUuid: 'fsym-1' }, property: { otherProperty: {} } }, scope: 'sys' } },
      symbols: { 'fsym-1': { info: { name: 'Ground-GND' }, source: flagSym, scope: 'sys' } },
      footprints: {},
      flags: { f1: { device: 'fdev-1', symbol: 'fsym-1' } },
      errors: [],
    }, {
      status: 'OK', projectUuid: 'p1', pageUuids: ['pg'], sources: [],
    }])
    const { library } = await collectProjectLibrary(flagIr, bridge)
    expect(library.flags?.get('f1')?.symbol.source).toContain('pid-flag')
  })

  it('serializes flag Symbol/Device attrs through the flags map', async () => {
    const flagIr: SchematicIr = {
      sheets: [{
        components: [{ id: 'f1', kind: 'netflag', netName: 'GND', position: { x: 0, y: 0 }, pins: [] }],
        wires: [], busEntries: [], junctions: [], attrs: [],
      }],
    }
    const flagSymDoc = { sourceUuid: 'fsym-1', localUuid: 'ls1', source: 'x', partId: 'pid-flag' }
    const flagDevDoc = { sourceUuid: 'fdev-1', localUuid: 'ld1', source: 'x' }
    const pkg = serializeEasyEdaProject(flagIr, {
      library: { devices: [flagDevDoc], symbols: [flagSymDoc], footprints: [], flags: new Map([['f1', { device: flagDevDoc, symbol: flagSymDoc }]]) },
    })
    const comp = pkg.epru.split('\n').find(l => l.startsWith('{"type":"COMPONENT"'))
    expect(comp).toContain('"partId":"pid-flag"')
    const attrs = pkg.epru.split('\n').filter(l => l.includes('"parentId":"f1"'))
    expect(attrs.find(l => l.includes('"key":"Symbol"'))).toContain('"value":"ls1"')
    expect(attrs.find(l => l.includes('"key":"Device"'))).toContain('"value":"ld1"')
  })

  it('dedupes wanted bindings, scopes flag queries by net name, and skips unflaggable kinds', async () => {
    const dedup: SchematicIr = {
      sheets: [{
        components: [
          {
            id: 'r1', kind: 'part', designator: 'R1', pins: [],
            deviceUuid: 'dev-1', deviceLibraryUuid: 'sys',
            symbolUuid: 'sym-1', symbolLibraryUuid: 'sys',
            footprintUuid: 'fp-1', footprintLibraryUuid: 'sys',
          },
          // Same bindings without scopes: the first declaration wins.
          { id: 'r2', kind: 'part', designator: 'R2', deviceUuid: 'dev-1', symbolUuid: 'sym-1', footprintUuid: 'fp-1', pins: [] },
          // Declared bindings without a scope fall back to ''.
          { id: 'r3', kind: 'part', designator: 'R3', deviceUuid: 'dev-x', symbolUuid: 'sym-x', footprintUuid: 'fp-x', pins: [] },
          { id: 'np', kind: 'netport', netName: 'SIG', pins: [] },
          { id: 'pg', kind: 'netflag', netName: 'VCC', pins: [] },
          { id: 'nk', kind: 'nonelec', netName: 'X', pins: [] },
        ],
        wires: [], busEntries: [], junctions: [], attrs: [],
      }],
    }
    const { bridge, calls } = scriptedBridge([{}])
    const { library, findings } = await collectProjectLibrary(dedup, bridge)
    const code = calls[0]!
    expect(code).toContain('"devices":{"dev-1":"sys","dev-x":""')
    expect(code).toContain('"symbols":{"sym-1":"sys","sym-x":""')
    expect(code).toContain('"queries":["Netport"]')
    expect(code).toContain('"queries":["Power-VCC","Power-VCC"]')
    expect(library.devices).toHaveLength(0)
    expect(findings).toEqual([])
  })

  it('localizes sparse docs and skips flag bindings whose docs never resolved', async () => {
    const symSrc = '{"type":"DOCHEAD","ticket":1}||{"docType":"SYMBOL","uuid":"orig-s","user":{}}|\n' +
      '{"type":"PART","ticket":2,"id":"P.1"}||{"BBOX":[]}|'
    const fpSrc = '{"type":"DOCHEAD","ticket":1}||{"docType":"FOOTPRINT","uuid":"orig-f","user":{}}|'
    const sparseIr: SchematicIr = {
      sheets: [{
        components: [
          { id: 'a', kind: 'part', deviceUuid: 'dev-bare', symbolUuid: 'sym-bare', footprintUuid: 'fp-bare', pins: [] },
          { id: 'b', kind: 'part', deviceUuid: 'dev-rich', pins: [] },
          { id: 'f-bad', kind: 'netflag', netName: 'GND', pins: [] },
          { id: 'f-miss', kind: 'netflag', netName: '5V', pins: [] },
          { id: 'f-none', kind: 'netflag', netName: '12V', pins: [] },
        ],
        wires: [], busEntries: [], junctions: [], attrs: [],
      }],
    }
    const { bridge } = scriptedBridge([{
      devices: {
        // No scope: the 3D Model rewrite still appends the (empty) scope.
        'dev-bare': { info: { property: { otherProperty: { '3D Model': 'flat.step' } } } },
        'dev-noinfo': {},
        'dev-rich': {
          info: {
            name: 'X', classification: ['t'],
            association: { symbolUuid: 'sym-ok', footprintUuid: 'fp-ok', images: ['i.png'] },
            property: { otherProperty: { '3D Model': 'm|sys' } },
          },
          scope: 'sys',
        },
      },
      symbols: {
        'sym-ok': { info: { name: 'S', type: 18 }, source: symSrc, scope: 'sys' },
        'sym-bare': { info: {}, source: symSrc },
        'sym-empty': { info: {}, source: '' },
        'sym-nosrc': { info: { name: 'N' } },
      },
      footprints: {
        'fp-ok': { info: { name: 'F' }, source: fpSrc, scope: 'sys' },
        'fp-bare': { info: {}, source: fpSrc },
        'fp-nosrc': { info: {} },
      },
      flags: {
        'f-bad': { device: 'dev-bare' },
        'f-miss': { device: 'dev-rich', symbol: 'gone' },
        'f-none': {},
      },
      errors: [{}],
    }])
    const { library, findings } = await collectProjectLibrary(sparseIr, bridge)
    const bare = library.devices.find(d => d.sourceUuid === 'dev-bare')!
    // No resolvable association means no Symbol/Footprint attributes.
    expect(bare.source).not.toContain('SymbolName')
    expect(bare.source).not.toContain('FootprintName')
    expect(bare.source).toContain('"source":"dev-bare|"')
    expect(bare.source).toContain('"3D Model":"flat.step|"')
    const rich = library.devices.find(d => d.sourceUuid === 'dev-rich')!
    const sym = library.symbols.find(s => s.sourceUuid === 'sym-ok')!
    const fp = library.footprints.find(f => f.sourceUuid === 'fp-ok')!
    expect(rich.source).toContain(`"Symbol":"${sym.localUuid}"`)
    expect(rich.source).toContain(`"Footprint":"${fp.localUuid}"`)
    // A piped 3D model reference already carries its scope and is not rewritten.
    expect(rich.source).toContain('"3D Model":"m|sys"')
    // Sparse symbol docs keep their defaults; empty sources localize to ''.
    expect(library.symbols.find(s => s.sourceUuid === 'sym-bare')?.source).toContain('"docType":2')
    expect(library.symbols.find(s => s.sourceUuid === 'sym-empty')?.source).toBe('')
    expect(library.symbols.find(s => s.sourceUuid === 'sym-nosrc')).toBeUndefined()
    expect(library.footprints.find(s => s.sourceUuid === 'fp-nosrc')).toBeUndefined()
    // Every flag binding misses at least one side, so nothing resolves.
    expect(library.flags?.size).toBe(0)
    const finding = findings.find(f => f.code === 'SCHEMATIC_IMPORT_LIBDOC')
    expect(finding?.message).toContain('library document ?')
  })

  it('emits empty binding attr values when a flag doc lacks a local uuid', async () => {
    const flagIr: SchematicIr = {
      sheets: [{
        components: [{ id: 'f1', kind: 'netflag', netName: 'GND', pins: [] }],
        wires: [], busEntries: [], junctions: [], attrs: [],
      }],
    }
    // A doc with no localUuid can only come from a malformed upstream fetch.
    const malformed = { sourceUuid: 'x', source: 'x' } as EasyEdaEmbeddedDoc
    const pkg = serializeEasyEdaProject(flagIr, {
      library: { devices: [], symbols: [], footprints: [], flags: new Map([['f1', { device: malformed, symbol: malformed }]]) },
    })
    const attrs = pkg.epru.split('\n').filter(l => l.includes('"parentId":"f1"'))
    expect(attrs.find(l => l.includes('"key":"Device"'))).toContain('"value":""')
    expect(attrs.find(l => l.includes('"key":"Symbol"'))).toContain('"value":""')
  })

  it('embeds collected docs in the import script and reports collection failures', async () => {
    const { bridge, calls } = scriptedBridge([libDocs,
      { status: 'OK', projectUuid: 'proj-1' },
      { pageUuids: ['pg-1'], sources: ['{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"R1"}|'] },
    ])
    const report = await importIntoEasyEda(boundIr, { bridge })
    expect(report.findings).toEqual([])
    // Library collection, import, one drain probe, then page read-back.
    expect(calls).toHaveLength(4)
    expect(calls[0]).toContain('getDocumentSource')
    expect(calls[1]).toContain('SYMBOL')
    expect(calls[1]).toContain('DEVICE')
    expect(calls[2]).toBe('return true')
    let brokenCalls = 0
    const broken: EasyEdaBridge = {
      execute: () => brokenCalls++ === 0
        ? Promise.reject(new Error('bridge down'))
        : brokenCalls === 2
          ? Promise.resolve({ status: 'OK', projectUuid: 'p2' })
          : Promise.resolve({ pageUuids: [], sources: [] }),
    }
    const degraded = await importIntoEasyEda(boundIr, { bridge: broken })
    expect(degraded.findings.map(f => f.code)).toContain('SCHEMATIC_IMPORT_LIBDOC')
  })
})

describe('importIntoEasyEda', () => {
  const emptyLibrary = { devices: {}, symbols: {}, footprints: {}, errors: [] }
  const importedSource =
    '{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"U1"}|\n' +
    '{"type":"ATTR","id":"a2","ticket":2}||{"key":"NET","value":"SIG"}|\n' +
    '{"type":"ATTR","id":"a3","ticket":3}||{"key":"NET","value":"A[1:2]"}|\n' +
    '{"type":"ATTR","id":"a4","ticket":4}||{"key":"Name","value":"GND"}|'

  it('returns the imported project uuid, page uuids, and clean findings', async () => {
    const { bridge } = scriptedBridge([emptyLibrary,
      { status: 'OK', projectUuid: 'proj-1' },
      { pageUuids: ['pg-1'], sources: [importedSource] },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.projectUuid).toBe('proj-1')
    expect(report.pageUuids).toEqual(['pg-1'])
    expect(report.findings).toEqual([])
  })

  it('maps NO_TEAM and import rejection to typed errors', async () => {
    const { bridge: noTeam } = scriptedBridge([emptyLibrary, { status: 'NO_TEAM' }])
    await expect(importIntoEasyEda(ir, { bridge: noTeam }))
      .rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_IMPORT_NO_TEAM' }))
    const { bridge: rejected } = scriptedBridge([emptyLibrary, { status: 'IMPORT_REJECTED' }])
    await expect(importIntoEasyEda(ir, { bridge: rejected }))
      .rejects.toThrow(expect.objectContaining({ code: 'SCHEMATIC_IMPORT_REJECTED' }))
  })

  it('fails the report explicitly when the client refuses to open the imported project', async () => {
    const { bridge } = scriptedBridge([emptyLibrary,
      { status: 'OK', projectUuid: 'proj-x' },
      { status: 'OPEN_FAILED' },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.projectUuid).toBe('proj-x')
    expect(report.pageUuids).toEqual([])
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_IMPORT_OPEN_FAILED')
    expect(finding?.severity).toBe('error')
    expect(finding?.message).toContain('refused to open')
    expect(report.findings.every(f => !f.code.startsWith('SCHEMATIC_NETLIST'))).toBe(true)
  })

  it('points at allowTabClose when open tabs block the project switch', async () => {
    const { bridge } = scriptedBridge([emptyLibrary,
      { status: 'OK', projectUuid: 'proj-x' },
      { status: 'OPEN_FAILED', openTabs: 3 },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_IMPORT_OPEN_FAILED')
    expect(finding?.message).toContain('3 document tab(s)')
    expect(finding?.message).toContain('allowTabClose')
  })

  it('reports an unfinished client-side project open after the drain budget', async () => {
    const bridge: EasyEdaBridge = {
      execute: (code: string) => {
        if (code === 'return true') return Promise.reject(new Error('gateway busy'))
        return Promise.resolve({ status: 'OK', projectUuid: 'proj-slow' })
      },
    }
    const report = await importIntoEasyEda(ir, { bridge, timeoutMs: 100 })
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_IMPORT_OPEN_FAILED')
    expect(finding?.severity).toBe('error')
    expect(finding?.message).toContain('did not finish opening')
    expect(report.projectUuid).toBe('proj-slow')
  })

  it('drains the gateway queue before reading back after a busy probe', async () => {
    let probes = 0
    const queue = [emptyLibrary, { status: 'OK', projectUuid: 'proj-1' },
      { status: 'OK', projectUuid: 'proj-1', pageUuids: ['pg-1'], sources: [importedSource] }]
    const bridge: EasyEdaBridge = {
      execute: (code: string) => {
        if (code === 'return true') {
          probes += 1
          return probes === 1 ? Promise.reject(new Error('gateway busy')) : Promise.resolve(true)
        }
        return Promise.resolve(queue.shift())
      },
    }
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.projectUuid).toBe('proj-1')
    expect(report.pageUuids).toEqual(['pg-1'])
    expect(probes).toBe(2)
  })

  it('reports a same-name import as renamed', async () => {
    const { bridge } = scriptedBridge([emptyLibrary,
      { status: 'OK', projectUuid: 'proj-1', projectName: 'DSH Schematic v2' },
      { pageUuids: ['pg-1'], sources: [importedSource] },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    const renamed = report.findings.find(f => f.code === 'SCHEMATIC_IMPORT_RENAMED')
    expect(renamed?.severity).toBe('warning')
    expect(renamed?.message).toContain('DSH Schematic v2')
  })

  it('flags dropped pages as errors and missing names as warnings', async () => {
    const { bridge } = scriptedBridge([emptyLibrary,
      { status: 'OK', projectUuid: 'proj-1' },
      { pageUuids: [], sources: [] },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    const lost = report.findings.find(f => f.code === 'SCHEMATIC_IMPORT_PAGE_LOST')
    expect(lost?.severity).toBe('error')
    expect(lost?.message).toContain('0 of 1')
  })

  it('flags absent designators and nets in the read-back source', async () => {
    const { bridge } = scriptedBridge([emptyLibrary,
      { status: 'OK', projectUuid: 'proj-1' },
      { pageUuids: ['pg-1'], sources: ['{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"NOPE"}|'] },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    const codes = report.findings.map(f => f.code)
    expect(codes).toContain('SCHEMATIC_IMPORT_DESIGNATOR')
    expect(codes).toContain('SCHEMATIC_IMPORT_NET')
  })

  it('flags unreadable imported pages as warnings', async () => {
    const { bridge } = scriptedBridge([emptyLibrary,
      { status: 'OK', projectUuid: 'proj-1' },
      { pageUuids: ['pg-1'], sources: [null] },
    ])
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.findings.map(f => f.code)).toContain('SCHEMATIC_IMPORT_READBACK')
  })

  it('reconciles pin endpoints against symbolPins in the imported read-back', async () => {
    const boundIr: SchematicIr = {
      sheets: [{
        ...ir.sheets[0]!,
        components: [{ ...ir.sheets[0]!.components[0]!, symbolUuid: 'sym-u' }, ...ir.sheets[0]!.components.slice(1)],
      }],
    }
    const symbolPins = new Map([['sym-u', [{ number: '3', x: 0, y: 10 }]]])
    const { bridge } = scriptedBridge([emptyLibrary,
      { status: 'OK', projectUuid: 'proj-1' },
      { pageUuids: ['pg-1'], sources: [importedSource] },
    ])
    const report = await importIntoEasyEda(boundIr, { bridge, symbolPins })
    const offPin = report.findings.filter(f => f.code === 'WIRE_NOT_ON_PIN')
    expect(offPin).toHaveLength(1)
    expect(offPin[0]?.severity).toBe('error')
  })

  it('reports a non-Error library-collection failure verbatim', async () => {
    let calls = 0
    // A non-Error rejection is what `String(error)` renders into the finding.
    const nonError: unknown = 'bridge-wedged'
    const bridge: EasyEdaBridge = {
      execute: () => {
        const nth = calls++
        if (nth === 0) return Promise.resolve().then(() => { throw nonError })
        return Promise.resolve(nth === 1 ? { status: 'OK', projectUuid: 'p' } : { pageUuids: [], sources: [] })
      },
    }
    const report = await importIntoEasyEda(ir, { bridge })
    expect(report.findings[0]?.message).toContain('(bridge-wedged)')
  })
})

describe('EasyEdaSchematicEngine.importProject', () => {
  const engine = new EasyEdaSchematicEngine({
    clientId: 't', bridgeHost: '127.0.0.1', bridgeTimeoutMs: 100,
    bridgeQueryTimeoutMs: 100, bridgeTimeoutStreakLimit: 3, bridgeCircuitCooldownMs: 100,
    advisoryDrc: true, libraryUuid: 'lib-1',
  })

  it('imports through an injected bridge and returns the report', async () => {
    const { bridge, calls } = scriptedBridge([{ devices: {}, symbols: {}, footprints: {}, errors: [] },
      { status: 'OK', projectUuid: 'proj-9' },
      { pageUuids: ['pg-1'], sources: ['{"type":"ATTR","id":"a1","ticket":1}||{"key":"Designator","value":"U1"}|'] },
    ])
    const report = await engine.importProject(ir, { bridge, projectName: 'Demo' })
    expect(report.projectUuid).toBe('proj-9')
    expect(calls).toHaveLength(4)
    expect(calls[1]).toContain('projectName')
    expect(calls[1]).toContain('"Demo"')
    expect(calls[1]).toContain('\\"client\\":\\"t\\"')
  })
})

describe('EasyEdaSchematicEngine.verify', () => {
  const engine = new EasyEdaSchematicEngine({
    clientId: 't', bridgeHost: '127.0.0.1', bridgeTimeoutMs: 100,
    bridgeQueryTimeoutMs: 100, bridgeTimeoutStreakLimit: 3, bridgeCircuitCooldownMs: 100,
    advisoryDrc: false, libraryUuid: 'lib-1',
  })

  it('delegates to the live build path and returns its findings', async () => {
    const { bridge, calls } = scriptedBridge(standardQueue())
    const findings = await engine.verify(ir, { bridge })
    expect(calls).toHaveLength(7)
    expect(findings.map(f => f.code)).toContain('SCHEMATIC_ROUNDTRIP_UNAVAILABLE')
  })
})
