import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { serializeEasyEdaDocument, serializeEasyEdaProject } from '@deepseek-ai/dsh-plugin-eda-easyeda'
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

  it('emits COMPONENT in persisted schema: x/y keys, negated y, attrs map', () => {
    const source = serializeEasyEdaDocument(ir)
    const line = source.split('\n').find(l => l.startsWith('{"type":"COMPONENT"'))
    expect(line).toContain('"id":"c1"')
    expect(line).toContain('"x":100,"y":-200')
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
    expect(seg).toContain('"startX":0,"startY":0,"endX":100,"endY":0')
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
    expect(segs[0]).toContain('"startX":0,"startY":0,"endX":10,"endY":0')
    expect(segs[1]).toContain('"startX":10,"startY":0,"endX":10,"endY":-20')
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
    const w3Net = source.split('\n').find(l => l.includes('"parentId":"w3"'))
    expect(w3Net).toContain('"value":"X"')
  })

  it('defaults absent geometry and optional component fields', () => {
    const sparse: SchematicIr = {
      sheets: [{
        components: [
          { id: 'c1', kind: 'part', partId: 'A', groupId: 'g', rotation: 90, mirror: true, pins: [] },
          { id: 'c2', kind: 'part', pins: [] },
        ],
        wires: [{ id: 'w1', kind: 'wire', net: 'N' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    const lines = linesOf(serializeEasyEdaDocument(sparse))
    const c1 = lines.find(l => l.includes('"id":"c1"'))
    expect(c1).toContain('"partId":"A","groupId":"g"')
    expect(c1).toContain('"x":0,"y":0')
    expect(c1).toContain('"rotation":90,"isMirror":true')
    const c2 = lines.find(l => l.includes('"id":"c2"'))
    expect(c2).toContain('"partId":"","groupId":""')
    expect(c2).toContain('"rotation":0,"isMirror":false')
    const net = lines.find(l => l.includes('"parentId":"w1"'))
    expect(net).toContain('"value":"N"')
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

describe('layout golden', () => {
  it('serializes the committed laid IR byte-identically to the recorded source', () => {
    const laid = JSON.parse(readFileSync(new URL('./fixtures/layout-golden.json', import.meta.url), 'utf8')) as SchematicIr
    const expected = readFileSync(new URL('./fixtures/layout-golden.eeda', import.meta.url), 'utf8')
    expect(serializeEasyEdaDocument(laid, { docUuid: 'layoutgolden', clientId: 'test' })).toBe(expected)
  })
})
