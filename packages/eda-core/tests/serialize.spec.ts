import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_NET_LABEL_FONT_SIZE, serializeEasyEdaDocument, serializeEasyEdaProject } from '@deepseek-ai/dsh-plugin-eda-core'
import { SCHEMATIC_PAGE_A3, layoutSchematic, validateSchematic } from '@deepseek-ai/dsh-plugin-eda-sch'
import type { SchematicIr } from '@deepseek-ai/dsh-plugin-eda-sch'

const ir: SchematicIr = {
  sheets: [{
    components: [{
      id: 'c1', kind: 'part', designator: 'U1', position: { x: 100, y: 200 },
      deviceUuid: 'dev-uuid', symbolUuid: 'sym-uuid', footprintUuid: 'fp-uuid',
      pins: [{ id: 'p1', name: 'OUT', number: '3', electric: 'OUTPUT', endpoint: { x: 110, y: 200 } }],
    }],
    wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 100, 0]], net: 'SIG' }],
    busEntries: [{ id: 'b1', busNet: 'A[1:2]', order: 0, point: { x: 50, y: 10 } }],
    junctions: [],
    attrs: [{ id: 'a1', parentId: 'w1', key: 'NET', value: 'SIG' }],
  }],
}

const linesOf = (source: string) => source.trimEnd().split('\n')

describe('serializeEasyEdaDocument', () => {
  it('emits a DOCHEAD-headed SCH_PAGE document', () => {
    const lines = linesOf(serializeEasyEdaDocument(ir, { docUuid: 'doc-1', clientId: 'test' }))
    expect(lines[0]).toBe('{"type":"DOCHEAD","ticket":1}||{"docType":"SCH_PAGE","client":"test","uuid":"doc-1","updateTime":1,"version":"1","user":{"uuid":"doc-1"}}|')
    expect(lines[1]).toMatch(/^\{"type":"CANVAS","ticket":\d+,"id":"CANVAS"\}\|\|\{"originX":0,"originY":0\}\|$/)
  })

  it('emits COMPONENT in persisted schema: x/y keys, page-height y mapping, attrs map', () => {
    const source = serializeEasyEdaDocument(ir)
    const line = source.split('\n').find(l => l.startsWith('{"type":"COMPONENT"'))
    expect(line).toContain('"id":"c1"')
    // IR y=200 on the A4 page (height 825) with a bottom-left, Y-up origin.
    expect(line).toContain('"x":100,"y":-625')
    expect(line).toContain('"rotation":0,"isMirror":false,"attrs":{"Footprints":"[]","Devices":"[]","DeviceName":null,"FootprintName":null')
    expect(line).not.toContain('positionX')
  })

  it('emits binding ATTRs with persisted key/value/x/y fields', () => {
    const attrs = linesOf(serializeEasyEdaDocument(ir)).filter(l => l.startsWith('{"type":"ATTR"'))
    const byKey = (key: string) => attrs.find(l => l.includes(`"key":${JSON.stringify(key)}`))
    expect(byKey('Device')).toContain('"value":"dev-uuid"')
    expect(byKey('Symbol')).toContain('"value":"sym-uuid"')
    expect(byKey('Footprint')).toContain('"value":"fp-uuid"')
    const designator = byKey('Designator')
    expect(designator).toContain('"value":"U1"')
    expect(designator).toContain('"parentId":"c1"')
    expect(designator).toContain('"valueVisible":true')
    expect(byKey('Device')).toContain('"valueVisible":null')
  })

  it('does not emit PIN records: sheet pins are symbol data', () => {
    const source = serializeEasyEdaDocument(ir)
    expect(source).not.toContain('"type":"PIN"')
    expect(source).not.toContain('"key":"NAME"')
  })

  it('emits a WIRE container plus per-segment LINE records and its NET attr', () => {
    const source = serializeEasyEdaDocument(ir)
    const wire = source.split('\n').find(l => l.startsWith('{"type":"WIRE"'))
    expect(wire).toContain('"id":"w1"')
    expect(wire).toContain('"locked":false')
    expect(wire).not.toContain('"dots"')
    const seg = source.split('\n').find(l => l.startsWith('{"type":"LINE"'))
    expect(seg).toContain('"lineGroup":"w1"')
    expect(seg).toContain('"startX":0,"startY":-825,"endX":100,"endY":-825')
    const netAttr = source.split('\n').find(l => l.includes('"key":"NET"'))
    expect(netAttr).toContain('"parentId":"w1"')
    expect(netAttr).toContain('"value":"SIG"')
  })

  it('splits polylines into one LINE per segment', () => {
    const bent: SchematicIr = {
      sheets: [{
        components: [],
        wires: [{ id: 'w', kind: 'wire', dots: [[0, 0, 10, 0, 10, 20]] }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    const segs = linesOf(serializeEasyEdaDocument(bent)).filter(l => l.startsWith('{"type":"LINE"'))
    expect(segs).toHaveLength(2)
    expect(segs[0]).toContain('"startX":0,"startY":-825,"endX":10,"endY":-825')
    expect(segs[1]).toContain('"startX":10,"startY":-825,"endX":10,"endY":-805')
  })

  it('emits BUS type for bus-kind wires', () => {
    const busIr: SchematicIr = {
      sheets: [{
        components: [],
        wires: [{ id: 'b', kind: 'bus', dots: [[0, 0, 5, 0]], net: 'A[1:2]' }],
        busEntries: ir.sheets[0]!.busEntries,
        junctions: [],
        attrs: [],
      }],
    }
    const source = serializeEasyEdaDocument(busIr)
    expect(source).toContain('{"type":"BUS","id":"b"')
    expect(source.split('\n').find(l => l.startsWith('{"type":"LINE"'))).toContain('"lineGroup":"b"')
  })

  it('emits one DOCHEAD per sheet in order', () => {
    const empty = { components: [], wires: [], busEntries: [], junctions: [], attrs: [] }
    const two: SchematicIr = { sheets: [empty, empty] }
    const lines = linesOf(serializeEasyEdaDocument(two))
    expect(lines.filter(l => l.startsWith('{"type":"DOCHEAD"'))).toHaveLength(2)
  })

  it('emits a page META binding when schematicUuid is given', () => {
    const source = serializeEasyEdaDocument(ir, { schematicUuid: 'sch-9', docUuid: 'doc-1' })
    expect(source).toContain('"type":"META","ticket":2,"id":"META"')
    expect(source).toContain('"schematic":"sch-9"')
    expect(source).toContain('"title":"P1"')
  })

  it('writes the sheet name into the page META title', () => {
    const named: SchematicIr = { sheets: [{ ...ir.sheets[0]!, name: 'POWER' }] }
    const source = serializeEasyEdaDocument(named, { schematicUuid: 'sch-9', docUuid: 'doc-1' })
    expect(source).toContain('"title":"POWER"')
    expect(source).not.toContain('"title":"P1"')
  })

  it('omits binding attrs when the IR leaves them undefined', () => {
    const sparse: SchematicIr = {
      sheets: [{
        components: [{
          id: 'c2', kind: 'netflag', position: { x: 0, y: 0 },
          pins: [{ id: 'p', electric: 'BI', endpoint: { x: 1, y: 1 } }],
        }],
        wires: [
          { id: 'w2', kind: 'wire', dots: [[0, 0, 5, 0]] },
          { id: 'w3', kind: 'wire', dots: [], net: 'X' },
        ],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    const source = serializeEasyEdaDocument(sparse)
    expect(source).not.toContain('"key":"Device"')
    expect(source).not.toContain('"key":"Designator"')
    const w2Attrs = source.split('\n').filter(l => l.includes('"parentId":"w2"'))
    expect(w2Attrs).toHaveLength(0)
    // w3 declares a net but has no geometry: a declaration-only row (what
    // pagination leaves behind for ATTR ownership) projects no WIRE and no NET
    // ATTR at the origin.
    expect(source.split('\n').some(l => l.includes('"id":"w3"'))).toBe(false)
    expect(source.split('\n').some(l => l.includes('"parentId":"w3"'))).toBe(false)
  })

  it('defaults absent geometry and optional component fields', () => {
    const sparse: SchematicIr = {
      sheets: [{
        components: [
          { id: 'c1', kind: 'part', partId: 'A', groupId: 'g', rotation: 90, mirror: true, pins: [] },
          { id: 'c2', kind: 'part', pins: [] },
        ],
        wires: [{ id: 'w1', kind: 'wire', net: 'N' }],
        busEntries: [], junctions: [],
        attrs: [{ id: 'a1', parentId: 'w1', key: 'Name', value: 'gone' }],
      }],
    }
    const lines = linesOf(serializeEasyEdaDocument(sparse))
    const c1 = lines.find(l => l.includes('"id":"c1"'))
    expect(c1).toContain('"partId":"A","groupId":"g"')
    expect(c1).toContain('"x":0,"y":-825')
    expect(c1).toContain('"rotation":90,"isMirror":true')
    const c2 = lines.find(l => l.includes('"id":"c2"'))
    expect(c2).toContain('"partId":"","groupId":""')
    expect(c2).toContain('"rotation":0,"isMirror":false')
    // A wire with no `dots` at all is geometry-less too: nothing to project, so
    // neither the WIRE record nor its NET ATTR is emitted (the pre-fix code put
    // a NET ATTR at the origin, which is a stray net label on the page).
    expect(lines.some(l => l.includes('"id":"w1"'))).toBe(false)
    expect(lines.some(l => l.includes('"parentId":"w1"'))).toBe(false)
    // An ATTR hanging off a geometry-less wire has nothing to describe either.
    expect(lines.some(l => l.includes('"id":"a1"'))).toBe(false)
  })
})

describe('serializeEasyEdaProject', () => {
  it('emits CONFIG, SCH, and one SCH_PAGE per sheet with schema-real keys', () => {
    const pkg = serializeEasyEdaProject(ir, { title: 'T' })
    const docTypes = [...pkg.epru.matchAll(/\{"type":"DOCHEAD","ticket":\d+\}\|\|\{"docType":"([A-Z_]+)"/g)].map(m => m[1])
    expect(docTypes).toEqual(['CONFIG', 'SCH', 'SCH_PAGE'])
    expect(pkg.epru).toContain('"type":"UNIVERSAL"')
    expect(pkg.epru).toContain('"title":"T"')
    const schMeta = pkg.epru.split('\n').find(l => l.startsWith('{"type":"META"') && l.includes('"board"'))
    expect(schMeta).toContain('"title":"T"')
    const pageMeta = pkg.epru.split('\n').find(l => l.includes('"schematic":"'))
    expect(pageMeta).toContain(pkg.schematicUuid)
    const configMeta = pkg.epru.split('\n').find(l => l.includes('"defaultSheet"'))
    expect(configMeta).toMatch(/"defaultSheet":"[0-9a-f]{32}"/)
  })

  it('returns the project2.json stub alongside the epru', () => {
    const pkg = serializeEasyEdaProject(ir, { title: 'T' })
    expect(JSON.parse(pkg.projectJson)).toEqual({ title: 'T', cbb_project: false })
  })
})

describe('module frames', () => {
  const framed: SchematicIr = {
    sheets: [{
      name: 'MAIN',
      blocks: [{ name: 'power', title: 'POWER SUPPLY' }],
      components: [
        {
          id: 'u1', kind: 'part', designator: 'U1', block: 'power', position: { x: 100, y: 200 },
          pins: [{ id: 'p1', name: 'IN', number: '1', electric: 'INPUT', endpoint: { x: 110, y: 200 } }],
        },
        { id: 'u2', kind: 'part', designator: 'U2', block: 'mcu', position: { x: 700, y: 200 }, pins: [] },
      ],
      wires: [], busEntries: [], junctions: [], attrs: [],
    }],
  }

  it('emits a dashed RECT and a bold TEXT per grouped module', () => {
    const lines = linesOf(serializeEasyEdaDocument(framed))
    const rects = lines.filter(l => l.startsWith('{"type":"RECT"'))
    const texts = lines.filter(l => l.startsWith('{"type":"TEXT"'))
    expect(rects).toHaveLength(2)
    expect(texts).toHaveLength(2)
    // power box: members at (100..110,200) → x=20,y=60,170×220 in IR space,
    // persisted as y - pageHeight (A4 = 825, bottom-left origin, Y up).
    expect(rects[0]).toContain('"dotX1":20,"dotY1":-765,"dotX2":190,"dotY2":-545')
    expect(rects[0]).toContain('"strokeStyle":1')
    expect(rects[0]).toContain('"fillStyle":0')
    expect(texts[0]).toContain('"value":"POWER SUPPLY"')
    expect(texts[0]).toContain('"x":40,"y":-755')
    expect(texts[0]).toContain('"align":"LEFT_TOP"')
    expect(texts[0]).toContain('"fontWeight":true')
    // Undeclared module falls back to its name as the title.
    expect(texts[1]).toContain('"value":"mcu"')
  })

  it('clamps frames to the page size the layout planned against', () => {
    // A block member near the A4 edge: its 80-unit frame pad crosses 1170x825.
    // The default call clamps the frame onto the A4 rectangle, the A3 call lets
    // it follow the member. Without the pageSize pass-through, A3 frames were cut.
    const edge: SchematicIr = {
      sheets: [{
        blocks: [{ name: 'io', title: 'IO' }],
        components: [{
          id: 'u1', kind: 'part', designator: 'U1', block: 'io',
          position: { x: 1100, y: 800 }, pins: [],
        }],
        wires: [], busEntries: [], junctions: [], attrs: [],
      }],
    }
    const a4 = serializeEasyEdaDocument(edge)
    expect(a4).toContain('"dotX2":1170')
    expect(a4).toContain('"dotY2":0')
    const a3 = serializeEasyEdaDocument(edge, { pageSize: SCHEMATIC_PAGE_A3 })
    expect(a3).toContain('"dotX2":1180')
    expect(a3).toContain('"dotY2":-290')
  })

  it('emits no frame records for an ungrouped sheet', () => {
    const source = serializeEasyEdaDocument(ir)
    expect(source).not.toContain('"type":"RECT"')
    expect(source).not.toContain('"type":"TEXT"')
  })

  const hierarchical: SchematicIr = {
    sheets: [{
      name: 'TOP',
      components: [
        {
          id: 'blk1', kind: 'block', designator: 'POWER', sheetIndex: 1,
          position: { x: 300, y: 300 },
          pins: [
            { id: 'p1', name: 'VIN', number: '1', electric: 'INPUT', endpoint: { x: 310, y: 340 } },
            { id: 'p2', name: 'VOUT', number: '2', electric: 'OUTPUT', endpoint: { x: 310, y: 380 } },
          ],
        },
      ],
      wires: [],
      busEntries: [],
      junctions: [],
      attrs: [],
    }, {
      name: 'POWER',
      components: [],
      wires: [],
      busEntries: [],
      junctions: [],
      attrs: [],
    }],
  }

  it('draws a hierarchy block as a sheet-symbol box without a COMPONENT record', () => {
    const lines = linesOf(serializeEasyEdaDocument(hierarchical))
    expect(lines.filter(l => l.startsWith('{"type":"COMPONENT"'))).toHaveLength(0)
    const rects = lines.filter(l => l.startsWith('{"type":"RECT"'))
    const texts = lines.filter(l => l.startsWith('{"type":"TEXT"'))
    expect(rects).toHaveLength(1)
    // Title plus one TEXT per interface pin.
    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain('"value":"POWER"')
    expect(texts.some(l => l.includes('"value":"VIN"'))).toBe(true)
    expect(texts.some(l => l.includes('"value":"VOUT"'))).toBe(true)
    // Two SCH_PAGE documents: TOP and the POWER child.
    expect(lines.filter(l => l.startsWith('{"type":"DOCHEAD"'))).toHaveLength(2)
  })
})

describe('layout golden', () => {
  it('serializes the committed laid IR byte-identically to the recorded source', () => {
    const laid = JSON.parse(readFileSync(new URL('./fixtures/layout-golden.json', import.meta.url), 'utf8')) as SchematicIr
    const expected = readFileSync(new URL('./fixtures/layout-golden.eeda', import.meta.url), 'utf8')
    expect(serializeEasyEdaDocument(laid, { docUuid: 'layoutgolden', clientId: 'test' })).toBe(expected)
  })
})

describe('paginated layout projection', () => {
  it('serializes every generated page with a unique title and no blocking geometry', () => {
    const components = Array.from({ length: 30 }, (_, i) => ({
      id: `u${i}`,
      kind: 'part' as const,
      designator: `U${i}`,
      deviceUuid: `dev-${i}`,
      block: ['power', 'mcu', 'io', 'clock', 'reset'][i % 5],
      pins: [
        { id: `in${i}`, name: 'IN', number: '1', electric: 'INPUT' as const, net: `N${i}` },
        { id: `out${i}`, name: 'OUT', number: '2', electric: 'OUTPUT' as const, net: `N${i + 1}` },
        { id: `v${i}`, name: 'VCC', number: '3', electric: 'INPUT' as const, net: 'VCC', powerName: 'VCC' },
        { id: `g${i}`, name: 'GND', number: '4', electric: 'INPUT' as const, net: 'GND', powerName: 'GND' },
      ],
    }))
    const laid = layoutSchematic({
      sheets: [{
        name: 'MAIN',
        blocks: ['power', 'mcu', 'io', 'clock', 'reset'].map(name => ({ name, title: name.toUpperCase() })),
        components,
        wires: [], busEntries: [], junctions: [], attrs: [],
      }],
    })
    expect(laid.sheets.length).toBeGreaterThan(1)
    expect(validateSchematic(laid).findings.filter(finding => finding.severity === 'error')).toEqual([])
    const pkg = serializeEasyEdaProject(laid)
    expect(pkg.pageUuids).toHaveLength(laid.sheets.length)
    const titles = pkg.epru.split('\n')
      .filter(line => line.startsWith('{"type":"META"') && line.includes('"schematic"'))
      .map(line => JSON.parse(line.slice(line.indexOf('||') + 2).replace(/\|$/, '')).title as string)
    expect(titles).toHaveLength(laid.sheets.length)
    expect(new Set(titles).size).toBe(titles.length)
  })
})

describe('net label size and visibility', () => {
  // A real 48-pin symbol (C23922) has a 10-unit minimum same-side pin pitch, so
  // the serializer ships net labels smaller than the client's 8-unit default,
  // and copies the client's own ATTR visibility so each net name renders once.
  const labelled: SchematicIr = {
    sheets: [{
      components: [
        { id: 'f1', kind: 'netflag', netName: 'GND', position: { x: 10, y: 20 }, pins: [] },
        { id: 'np1', kind: 'netport', netName: 'SIG', position: { x: 30, y: 40 }, pins: [] },
        { id: 'c1', kind: 'part', designator: 'U1', deviceUuid: 'dev-1', position: { x: 50, y: 60 }, pins: [] },
      ],
      wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
      busEntries: [], junctions: [], attrs: [],
    }],
  }
  const attrLine = (source: string, parentId: string, key: string): string | undefined => source.split('\n')
    .find(line => line.includes(`"parentId":"${parentId}"`) && line.includes(`"key":"${key}"`))
  const sizeFor = (source: string, parentId: string, key: string): string | undefined =>
    attrLine(source, parentId, key)?.match(/"fontSize":([^,]+)/)?.[1]
  const visFor = (source: string, parentId: string, key: string): string[] | undefined =>
    attrLine(source, parentId, key)?.match(/"keyVisible":([^,]+),"valueVisible":([^,]+)/)?.slice(1)

  it('ships the pinned default size on the attr the flag/port device draws', () => {
    // Pinned literally (not via the exported constant) so mutating the default
    // fails here rather than agreeing with itself.
    expect(DEFAULT_NET_LABEL_FONT_SIZE).toBe(6)
    const source = serializeEasyEdaDocument(labelled)
    expect(sizeFor(source, 'f1', 'Name')).toBe('6')
    expect(sizeFor(source, 'np1', 'Name')).toBe('6')
    expect(sizeFor(source, 'w1', 'NET')).toBe('6')
    // The hidden connectivity attr and the designator are chrome, not the label.
    expect(sizeFor(source, 'f1', 'Global Net Name')).toBe('null')
    expect(sizeFor(source, 'c1', 'Designator')).toBe('null')
  })

  it('copies the client visibility table so each net name renders exactly once', () => {
    const source = serializeEasyEdaDocument(labelled)
    // Values lifted from the client's own export (live-build-readback.eeda).
    expect(visFor(source, 'f1', 'Name')).toEqual(['null', 'true'])
    expect(visFor(source, 'f1', 'Global Net Name')).toEqual(['null', 'null'])
    expect(visFor(source, 'w1', 'NET')).toEqual(['false', 'true'])
    expect(visFor(source, 'c1', 'Designator')).toEqual(['null', 'true'])
    // Binding attrs stay invisible, exactly as before.
    expect(visFor(source, 'c1', 'Device')).toEqual(['null', 'null'])
  })

  it('honors an explicit size', () => {
    const source = serializeEasyEdaDocument(labelled, { netLabelFontSize: 5 })
    expect(sizeFor(source, 'f1', 'Name')).toBe('5')
    expect(sizeFor(source, 'w1', 'NET')).toBe('5')
    expect(sizeFor(source, 'np1', 'Name')).toBe('5')
  })

  it('keeps the client default when the size is null', () => {
    const source = serializeEasyEdaDocument(labelled, { netLabelFontSize: null })
    expect(sizeFor(source, 'f1', 'Name')).toBe('null')
    expect(sizeFor(source, 'w1', 'NET')).toBe('null')
    expect(sizeFor(source, 'np1', 'Name')).toBe('null')
  })

  it('threads the size through the project package', () => {
    const pkg = serializeEasyEdaProject(labelled, { netLabelFontSize: 7 })
    expect(sizeFor(pkg.epru, 'f1', 'Name')).toBe('7')
    expect(sizeFor(pkg.epru, 'w1', 'NET')).toBe('7')
  })
})
