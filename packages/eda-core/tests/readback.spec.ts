import { describe, expect, it } from 'vitest'
import { serializeEasyEdaDocument, diffNetlists, parseDocumentSource, readBackAttrs, readBackNetRegions } from '@deepseek-ai/dsh-plugin-eda-core'
import type { SchematicIr, SchematicIrSheet } from '@deepseek-ai/dsh-plugin-eda-sch'

/** U1 drives SIG into U2 over one wire: the canonical clean document. */
const sheet = (over: Partial<SchematicIrSheet> = {}): SchematicIrSheet => ({
  components: [
    {
      id: 'u1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 },
      pins: [{ id: 'p1', name: 'O', number: '1', electric: 'OUTPUT', endpoint: { x: 0, y: 0 }, net: 'SIG' }],
    },
    {
      id: 'u2', kind: 'part', designator: 'U2', position: { x: 100, y: 0 },
      pins: [{ id: 'p1', name: 'I', number: '1', electric: 'INPUT', endpoint: { x: 100, y: 0 }, net: 'SIG' }],
    },
  ],
  wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 100, 0]], net: 'SIG' }],
  busEntries: [], junctions: [], attrs: [],
  ...over,
})

const source = (ir: SchematicIr): string => serializeEasyEdaDocument(ir, { docUuid: 'doc', clientId: 'test' })
const diff = (s: SchematicIrSheet, src: string) => diffNetlists(s, src, 0)
const codes = (s: SchematicIrSheet, src: string) => diff(s, src).map(f => f.code)

describe('diffNetlists', () => {
  it('reports no diff when the read-back netlist agrees with the IR', () => {
    const doc = sheet()
    const findings = diff(doc, source({ sheets: [doc] }))
    expect(findings.filter(f => f.code.startsWith('SCHEMATIC_NETLIST_'))).toEqual([])
  })

  it('reports SCHEMATIC_NETLIST_DROPPED when the wire geometry is absent', () => {
    const doc = sheet()
    const src = source({ sheets: [doc] }).split('\n')
      .filter(line => !line.startsWith('{"type":"LINE"')).join('\n')
    const findings = diff(doc, src).filter(f => f.code === 'SCHEMATIC_NETLIST_DROPPED')
    expect(findings).toHaveLength(2)
    expect(findings[0]?.severity).toBe('error')
    expect(findings[0]?.locator).toMatchObject({ pinId: 'p1', net: 'SIG' })
  })

  it('reports SCHEMATIC_NETLIST_WRONG_NET when the region carries a different name', () => {
    const doc = sheet()
    const src = source({ sheets: [doc] }).replace('"value":"SIG"', '"value":"OTHER"')
    const findings = diff(doc, src).filter(f => f.code === 'SCHEMATIC_NETLIST_WRONG_NET')
    expect(findings).toHaveLength(2)
    expect(findings[0]?.message).toContain('OTHER')
  })

  it('reports SCHEMATIC_NETLIST_MERGED when one region carries two names', () => {
    const doc = sheet({
      wires: [
        { id: 'w1', kind: 'wire', dots: [[0, 0, 100, 0]], net: 'SIG' },
        { id: 'w2', kind: 'wire', dots: [[0, 100, 100, 100]], net: 'AUX' },
      ],
    })
    // Bridge the two nets with an extra segment inside w1's group.
    const src = source({ sheets: [doc] }) +
      '{"type":"LINE","id":"leak","ticket":99}||{"lineGroup":"w1","startX":50,"startY":0,"endX":50,"endY":-100,"strokeColor":null,"strokeStyle":null,"fillColor":null,"strokeWidth":null,"fillStyle":null}|\n'
    const merged = diff(doc, src).filter(f => f.code === 'SCHEMATIC_NETLIST_MERGED')
    expect(merged).toHaveLength(1)
    expect(merged[0]?.locator?.net).toBe('AUX/SIG')
    // The AUX wire endpoints now sit on the merged region, so no pins were lost.
    expect(diff(doc, src).some(f => f.code === 'SCHEMATIC_NETLIST_DROPPED')).toBe(false)
  })

  it('resolves flag-carried nets through stub wires', () => {
    const flagged = sheet({
      components: [
        {
          id: 'u1', kind: 'part', designator: 'U1', position: { x: 50, y: 30 },
          pins: [{ id: 'p1', name: 'V', number: '8', electric: 'BI', endpoint: { x: 50, y: 10 }, net: 'VCC' }],
        },
        { id: 'f1', kind: 'netflag', netName: 'VCC', position: { x: 50, y: 50 }, pins: [] },
      ],
      wires: [{ id: 'w1', kind: 'wire', dots: [[50, 10, 50, 50]] }],
    })
    expect(codes(flagged, source({ sheets: [flagged] }))).toEqual([])
  })

  it('reports DROPPED when the flag is missing and leaves the stub unnamed', () => {
    const flagged = sheet({
      components: [
        {
          id: 'u1', kind: 'part', designator: 'U1', position: { x: 50, y: 30 },
          pins: [{ id: 'p1', name: 'V', number: '8', electric: 'BI', endpoint: { x: 50, y: 10 }, net: 'VCC' }],
        },
        { id: 'f1', kind: 'netflag', netName: 'VCC', position: { x: 50, y: 50 }, pins: [] },
      ],
      wires: [{ id: 'w1', kind: 'wire', dots: [[50, 10, 50, 50]] }],
    })
    const src = source({ sheets: [flagged] }).split('\n')
      .filter(line => !line.includes('"parentId":"f1"') && !line.includes('"id":"f1"')).join('\n')
    // The unnamed stub leaves the pin on an unnamed region: a dropped net.
    expect(codes(flagged, src)).toContain('SCHEMATIC_NETLIST_DROPPED')
  })

  it('treats a plain Name on a designator-less component as a flag and ignores symbol names', () => {
    const src = [
      '{"type":"DOCHEAD","ticket":1}||{"docType":"SCH_PAGE","client":"t","uuid":"d","updateTime":1,"version":"1","user":{"uuid":"d"}}|',
      '{"type":"COMPONENT","id":"f1","ticket":2}||{"x":50,"y":-50,"rotation":0,"isMirror":false,"attrs":{}}|',
      '{"type":"ATTR","id":"a1","ticket":3}||{"parentId":"f1","key":"Name","value":"VCC","x":50,"y":-50}|',
      '{"type":"COMPONENT","id":"sym","ticket":4}||{"x":0,"y":0,"rotation":0,"isMirror":false,"attrs":{}}|',
      '{"type":"ATTR","id":"a2","ticket":5}||{"parentId":"sym","key":"Name","value":"={Manufacturer Part}","x":0,"y":0}|',
      '{"type":"ATTR","id":"a3","ticket":6}||{"parentId":"sym","key":"Designator","value":"U9","x":0,"y":0}|',
    ].join('\n') + '\n'
    const regions = readBackNetRegions(src)
    expect(regions).toHaveLength(1)
    expect([...regions[0]!.names]).toEqual(['VCC'])
  })

  it('skips pins with no expected net and skips records it cannot parse', () => {
    const doc = sheet({
      components: [{
        id: 'u1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 },
        pins: [{ id: 'p1', name: 'N', number: '1', electric: 'INPUT', endpoint: { x: 0, y: 0 } }],
      }],
      wires: [],
    })
    const src = '{"type":"ATTR","ticket":1}||{not json}|\ngarbage line\n\n'
    expect(codes(doc, src)).toEqual([])
  })

  it('unions regions across a strict mid-segment crossing', () => {
    const src = [
      '{"type":"WIRE","id":"w1","ticket":1}||{}|',
      '{"type":"ATTR","id":"a1","ticket":2}||{"parentId":"w1","key":"NET","value":"SIG"}|',
      '{"type":"LINE","id":"l1","ticket":3}||{"lineGroup":"w1","startX":50,"startY":0,"endX":50,"endY":100}|',
      '{"type":"WIRE","id":"w2","ticket":4}||{}|',
      '{"type":"ATTR","id":"a2","ticket":5}||{"parentId":"w2","key":"NET","value":"AUX"}|',
      '{"type":"LINE","id":"l2","ticket":6}||{"lineGroup":"w2","startX":0,"startY":50,"endX":100,"endY":50}|',
      '{"type":"WIRE","id":"w3","ticket":7}||{}|',
      '{"type":"ATTR","id":"a3","ticket":8}||{"parentId":"w3","key":"NET","value":"C"}|',
      '{"type":"LINE","id":"l3","ticket":9}||{"lineGroup":"w3","startX":300,"startY":350,"endX":400,"endY":350}|',
      '{"type":"WIRE","id":"w4","ticket":10}||{}|',
      '{"type":"ATTR","id":"a4","ticket":11}||{"parentId":"w4","key":"NET","value":"D"}|',
      '{"type":"LINE","id":"l4","ticket":12}||{"lineGroup":"w4","startX":350,"startY":300,"endX":350,"endY":400}|',
      '{"type":"WIRE","id":"w5","ticket":13}||{}|',
      '{"type":"ATTR","id":"a5","ticket":14}||{"parentId":"w5","key":"NET","value":"E"}|',
      '{"type":"LINE","id":"l5","ticket":15}||{"lineGroup":"w5","startX":550,"startY":500,"endX":550,"endY":600}|',
      '{"type":"WIRE","id":"w6","ticket":16}||{}|',
      '{"type":"ATTR","id":"a6","ticket":17}||{"parentId":"w6","key":"NET","value":"F"}|',
      '{"type":"LINE","id":"l6","ticket":18}||{"lineGroup":"w6","startX":600,"startY":550,"endX":500,"endY":550}|',
    ].join('\n') + '\n'
    const named = readBackNetRegions(src).map(region => [...region.names].sort().join('/')).sort()
    expect(named).toEqual(['AUX/SIG', 'C/D', 'E/F'])
  })

  it('treats a zero-length segment as a point for flag contact', () => {
    const src = [
      '{"type":"WIRE","id":"w1","ticket":1}||{}|',
      '{"type":"ATTR","id":"a1","ticket":2}||{"parentId":"w1","key":"NET","value":"SIG"}|',
      '{"type":"LINE","id":"l1","ticket":3}||{"lineGroup":"w1","startX":0,"startY":0,"endX":0,"endY":0}|',
      '{"type":"COMPONENT","id":"f1","ticket":4}||{"x":0,"y":0,"rotation":0,"isMirror":false,"attrs":{}}|',
      '{"type":"ATTR","id":"a2","ticket":5}||{"parentId":"f1","key":"Name","value":"SIG"}|',
      '{"type":"COMPONENT","id":"f2","ticket":6}||{"x":0,"y":50,"rotation":0,"isMirror":false,"attrs":{}}|',
      '{"type":"ATTR","id":"a3","ticket":7}||{"parentId":"f2","key":"Name","value":"OTHER"}|',
      '{"type":"COMPONENT","id":"f3","ticket":8}||{"x":50,"y":0,"rotation":0,"isMirror":false,"attrs":{}}|',
      '{"type":"ATTR","id":"a4","ticket":9}||{"parentId":"f3","key":"Name","value":"THIRD"}|',
    ].join('\n') + '\n'
    const named = readBackNetRegions(src).map(region => [...region.names].sort().join('/')).sort()
    expect(named).toEqual(['OTHER', 'SIG', 'THIRD'])
  })

  it('skips records with non-object bodies and id-less WIRE/COMPONENT records', () => {
    const src = [
      '{"type":"WIRE","ticket":1}||{}|',
      '{"type":"WIRE","id":"w9","ticket":2}||"plain"|',
      '{"type":"COMPONENT","ticket":3}||{"x":1,"y":2,"rotation":0,"isMirror":false,"attrs":{}}|',
    ].join('\n') + '\n'
    const regions = readBackNetRegions(src)
    // The id-less WIRE node survives with no id, names, or geometry.
    expect(regions).toHaveLength(1)
    expect(regions[0]?.names.size).toBe(0)
  })

  it('does not treat a named part with a Designator as a flag', () => {
    const src = [
      '{"type":"COMPONENT","id":"c1","ticket":1}||{"x":0,"y":0,"rotation":0,"isMirror":false,"attrs":{}}|',
      '{"type":"ATTR","id":"a1","ticket":2}||{"parentId":"c1","key":"Name","value":"RES"}|',
      '{"type":"ATTR","id":"a2","ticket":3}||{"parentId":"c1","key":"Designator","value":"R1"}|',
    ].join('\n') + '\n'
    expect(readBackNetRegions(src)).toEqual([])
  })

  it('skips IR wires without dots and pins without endpoints', () => {
    const doc = sheet({
      components: [{
        id: 'u1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 },
        pins: [{ id: 'p1', name: 'N', number: '1', electric: 'INPUT' }],
      }],
      wires: [{ id: 'w1', kind: 'wire', net: 'SIG' }],
    })
    expect(codes(doc, '')).toEqual([])
  })

  it('skips LINE records without geometry or a wire group and nameless components', () => {
    const src = [
      '{"type":"LINE","id":"l1","ticket":1}||{"lineGroup":"ghost","startX":0,"startY":0,"endX":1,"endY":1}|',
      '{"type":"LINE","id":"l2","ticket":2}||{"lineGroup":"w1","startX":0,"startY":0,"endX":1}|',
      '{"type":"COMPONENT","id":"c1","ticket":3}||{"rotation":0,"isMirror":false,"attrs":{}}|',
      '{"type":"COMPONENT","id":"c2","ticket":4}||{"x":5,"y":5,"rotation":0,"isMirror":false,"attrs":{}}|',
    ].join('\n') + '\n'
    expect(readBackNetRegions(src)).toEqual([])
  })

  describe('symbol-pin reconciliation', () => {
    // sym-u: pin 1 at (-20, 10), pin 2 at (-20, -10) in sheet space.
    const symbolPins = new Map([['sym-u', [
      { number: '1', x: -20, y: 10 },
      { number: '2', x: -20, y: -10 },
    ]]])
    const bound = (endpoint: { x: number; y: number }, over: Partial<SchematicIrSheet['components'][number]> = {}): SchematicIrSheet => ({
      components: [{
        id: 'u1', kind: 'part', designator: 'U1', symbolUuid: 'sym-u', position: { x: 0, y: 0 },
        pins: [{ id: 'p1', name: '1', number: '1', electric: 'BI', endpoint, net: 'SIG' }],
        ...over,
      }],
      // The wire follows the endpoint wherever it sits, so the name-level
      // diff stays clean and only the pin-geometry check can see the defect.
      wires: [{ id: 'w1', kind: 'wire', dots: [[endpoint.x, endpoint.y, 100, endpoint.y]], net: 'SIG' }],
      busEntries: [], junctions: [], attrs: [],
    })
    const diffWith = (s: SchematicIrSheet, src: string) => diffNetlists(s, src, 0, symbolPins)

    it('accepts endpoints that land on the bound symbol pin', () => {
      const doc = bound({ x: -20, y: 10 })
      expect(diffWith(doc, source({ sheets: [doc] }))).toEqual([])
    })

    it('reports WIRE_NOT_ON_PIN when the endpoint sits on the mirrored sibling', () => {
      const doc = bound({ x: -20, y: -10 })
      const findings = diffWith(doc, source({ sheets: [doc] }))
      const offPin = findings.filter(f => f.code === 'WIRE_NOT_ON_PIN')
      expect(offPin).toHaveLength(1)
      expect(offPin[0]?.severity).toBe('error')
      expect(offPin[0]?.message).toContain('(-20, 10)')
      expect(offPin[0]?.locator).toMatchObject({ pinId: 'p1', pinNumber: '1' })
      // The wire legitimately reaches the wrong point, so the name-level
      // netlist diff on its own reports nothing.
      expect(findings.filter(f => f.code.startsWith('SCHEMATIC_NETLIST_'))).toEqual([])
    })

    it('accepts endpoints on the pin under rotation and mirror', () => {
      // rotation 90: offset (-20,10) -> (-10,-20); mirror+0: (20,10).
      const rotated = bound({ x: -10, y: -20 }, { rotation: 90 })
      expect(diffWith(rotated, source({ sheets: [rotated] }))).toEqual([])
      const mirrored = bound({ x: 20, y: 10 }, { mirror: true })
      expect(diffWith(mirrored, source({ sheets: [mirrored] }))).toEqual([])
    })

    it('flags a mirrored endpoint even under component rotation', () => {
      const doc = bound({ x: -10, y: 20 }, { rotation: 90 }) // (-20,-10) rotated, not pin 1's (-10,-20)
      const findings = diffWith(doc, source({ sheets: [doc] }))
      expect(findings.filter(f => f.code === 'WIRE_NOT_ON_PIN')).toHaveLength(1)
    })

    it('names the component id when it carries no designator', () => {
      const doc = bound({ x: -20, y: -10 }, { designator: undefined })
      const finding = diffWith(doc, source({ sheets: [doc] })).find(f => f.code === 'WIRE_NOT_ON_PIN')
      expect(finding?.message).toContain('of u1')
    })

    it('skips the check when symbolPins or the join keys are absent', () => {
      // No symbolPins argument at all: arbitrary endpoints stay unremarked.
      const doc = bound({ x: 999, y: 999 })
      expect(codes(doc, source({ sheets: [doc] }))).not.toContain('WIRE_NOT_ON_PIN')
      // symbolPins present but the component carries no symbol binding.
      const unbound = bound({ x: 999, y: 999 }, { symbolUuid: undefined })
      expect(diffWith(unbound, source({ sheets: [unbound] })).filter(f => f.code === 'WIRE_NOT_ON_PIN')).toEqual([])
      // Bound symbol absent from the snapshot.
      const missing = bound({ x: 999, y: 999 }, { symbolUuid: 'sym-elsewhere' })
      expect(diffWith(missing, source({ sheets: [missing] })).filter(f => f.code === 'WIRE_NOT_ON_PIN')).toEqual([])
      // Pin number not in the symbol's pin list.
      const noNumber: SchematicIrSheet = {
        ...doc,
        components: [{
          ...doc.components[0]!,
          pins: [{ id: 'p9', name: '9', number: '9', electric: 'BI', endpoint: { x: 999, y: 999 }, net: 'SIG' }],
        }],
      }
      expect(diffWith(noNumber, source({ sheets: [noNumber] })).filter(f => f.code === 'WIRE_NOT_ON_PIN')).toEqual([])
      // Pin without a number cannot join the symbol's pin list.
      const unnumbered: SchematicIrSheet = {
        ...doc,
        components: [{
          ...doc.components[0]!,
          pins: [{ id: 'p0', name: 'N', electric: 'BI', endpoint: { x: 999, y: 999 }, net: 'SIG' }],
        }],
      }
      expect(diffWith(unnumbered, source({ sheets: [unnumbered] })).filter(f => f.code === 'WIRE_NOT_ON_PIN')).toEqual([])
      // No position at all.
      const noPosition = bound({ x: 999, y: 999 }, { position: undefined })
      expect(diffWith(noPosition, source({ sheets: [noPosition] })).filter(f => f.code === 'WIRE_NOT_ON_PIN')).toEqual([])
    })
  })
})

describe('parseDocumentSource/readBackAttrs', () => {
  it('parses head|body records and skips malformed lines', () => {
    const records = parseDocumentSource('{"type":"DOCHEAD"}||{"docType":"SCH_PAGE"}|\nbad\n')
    expect(records).toHaveLength(1)
    expect(records[0]?.type).toBe('DOCHEAD')
  })

  it('groups ATTR values by key', () => {
    const src = [
      '{"type":"ATTR","id":"a1","ticket":1}||{"parentId":"w1","key":"NET","value":"SIG"}|',
      '{"type":"ATTR","id":"a2","ticket":2}||{"parentId":"w2","key":"NET","value":"GND"}|',
      '{"type":"ATTR","id":"a3","ticket":3}||{"key":1,"value":"x"}|',
    ].join('\n')
    const attrs = readBackAttrs(parseDocumentSource(src))
    expect(attrs.get('NET')).toEqual(['SIG', 'GND'])
  })
})
