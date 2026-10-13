import { describe, expect, it } from 'vitest'
import { parseSchematicIr } from '@deepseek-ai/dsh-plugin-eda-sch'

const irInvalid = (): unknown => expect.objectContaining({ code: 'SCHEMATIC_IR_INVALID' })

/** One minimal valid sheet document for parser tests. */
const minimal = {
  sheets: [{
    components: [{
      id: 'c1',
      kind: 'part',
      position: { x: 0, y: 0 },
      pins: [{ id: 'p1', name: 'A', number: '1', electric: 'INPUT', endpoint: { x: 10, y: 0 } }],
    }],
    wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
    busEntries: [],
    junctions: [{ point: { x: 5, y: 0 } }],
    attrs: [{ id: 'a1', parentId: 'w1', key: 'NET', value: 'SIG' }],
  }],
}

describe('parseSchematicIr', () => {
  it('parses a minimal valid document', () => {
    const ir = parseSchematicIr(minimal)
    expect(ir.sheets).toHaveLength(1)
    expect(ir.sheets[0]!.components[0]!.pins[0]!.electric).toBe('INPUT')
    expect(ir.sheets[0]!.wires[0]!.dots?.[0]).toEqual([0, 0, 10, 0])
  })

  it('parses per-binding library scopes', () => {
    const scoped = structuredClone(minimal)
    Object.assign(scoped.sheets[0]!.components[0]!, {
      deviceUuid: 'dev', deviceLibraryUuid: 'lib-dev',
      symbolUuid: 'sym', symbolLibraryUuid: 'lib-sym',
      footprintUuid: 'fp', footprintLibraryUuid: 'lib-fp',
    })
    const component = parseSchematicIr(scoped).sheets[0]!.components[0]!
    expect(component.deviceLibraryUuid).toBe('lib-dev')
    expect(component.symbolLibraryUuid).toBe('lib-sym')
    expect(component.footprintLibraryUuid).toBe('lib-fp')
  })

  it('rejects non-object documents', () => {
    expect(() => parseSchematicIr('x')).toThrow(irInvalid())
    expect(() => parseSchematicIr(null)).toThrow(irInvalid())
    expect(() => parseSchematicIr([])).toThrow(irInvalid())
  })

  it('rejects a missing or empty sheets array', () => {
    expect(() => parseSchematicIr({})).toThrow(irInvalid())
    expect(() => parseSchematicIr({ sheets: [] })).toThrow(irInvalid())
  })

  it('rejects components without pins array', () => {
    expect(() => parseSchematicIr({
      sheets: [{ components: [{ id: 'c', kind: 'part', position: { x: 0, y: 0 } }], wires: [], busEntries: [], junctions: [], attrs: [] }],
    })).toThrow(irInvalid())
  })

  it('rejects an unknown component kind and pin electric', () => {
    const badKind = structuredClone(minimal)
    badKind.sheets[0]!.components[0]!.kind = 'weird'
    expect(() => parseSchematicIr(badKind)).toThrow(irInvalid())
    const badElectric = structuredClone(minimal)
    badElectric.sheets[0]!.components[0]!.pins[0]!.electric = 'HI-Z'
    expect(() => parseSchematicIr(badElectric)).toThrow(irInvalid())
  })

  it('rejects malformed wire dots', () => {
    const odd = structuredClone(minimal)
    odd.sheets[0]!.wires[0]!.dots = [[0, 0, 10]]
    expect(() => parseSchematicIr(odd)).toThrow(irInvalid())
    const short = structuredClone(minimal)
    short.sheets[0]!.wires[0]!.dots = [[0, 0]]
    expect(() => parseSchematicIr(short)).toThrow(irInvalid())
    const nan = structuredClone(minimal)
    nan.sheets[0]!.wires[0]!.dots = [[0, Number.NaN, 10, 0]]
    expect(() => parseSchematicIr(nan)).toThrow(irInvalid())
  })

  it('rejects non-finite points and negative bus-entry order', () => {
    const badPoint = structuredClone(minimal)
    badPoint.sheets[0]!.junctions[0]!.point.x = Number.POSITIVE_INFINITY
    expect(() => parseSchematicIr(badPoint)).toThrow(irInvalid())
    const badOrder = {
      sheets: [{
        components: [], wires: [],
        busEntries: [{ id: 'b1', busNet: 'A[1:2]', order: -1, point: { x: 0, y: 0 } }],
        junctions: [], attrs: [],
      }],
    }
    expect(() => parseSchematicIr(badOrder)).toThrow(irInvalid())
  })

  it('reports the failing path in the message', () => {
    expect(() => parseSchematicIr({ sheets: [{ components: [42], wires: [], busEntries: [], junctions: [], attrs: [] }] }))
      .toThrow(/document\.sheets\[0\]\.components\[0\]/)
  })

  it('parses a fully populated document', () => {
    const ir = parseSchematicIr({
      sheets: [{
        components: [{
          id: 'c1', kind: 'netport', position: { x: 0, y: 0 },
          netName: 'SIG', rotation: 90, mirror: true, partId: 'A', groupId: 'g1',
          addIntoBom: false, addIntoPcb: false,
          deviceUuid: 'd', symbolUuid: 's', footprintUuid: 'f', designator: 'P1',
          pins: [{ id: 'p1', name: 'A', number: '1', electric: 'BI', endpoint: { x: 0, y: 0 }, noConnect: true, powerName: 'VCC', groupId: 'gp' }],
        }],
        wires: [{ id: 'w1', kind: 'bus', dots: [[0, 0, 5, 0], [5, 0, 5, 5]], net: 'A[1:2]', groupId: 'g2' }],
        busEntries: [{ id: 'b1', busNet: 'A[1:2]', order: 1, point: { x: 0, y: 0 }, groupId: 'g3' }],
        junctions: [{ point: { x: 1, y: 1 } }],
        attrs: [{ id: 'a1', parentId: 'w1', key: 'NET', value: 'SIG' }],
      }],
    })
    const sheet = ir.sheets[0]!
    expect(sheet.components[0]).toMatchObject({ kind: 'netport', netName: 'SIG', rotation: 90, mirror: true })
    expect(sheet.components[0]!.pins[0]).toMatchObject({ electric: 'BI', noConnect: true, powerName: 'VCC' })
    expect(sheet.busEntries[0]).toMatchObject({ busNet: 'A[1:2]', order: 1 })
    expect(sheet.wires[0]!.dots).toHaveLength(2)
  })

  it('rejects non-record sheets, members, and non-array collections', () => {
    const sheet = (over: Record<string, unknown>) => ({
      sheets: [{ components: [], wires: [], busEntries: [], junctions: [], attrs: [], ...over }],
    })
    expect(() => parseSchematicIr({ sheets: ['x'] })).toThrow(irInvalid())
    expect(() => parseSchematicIr(sheet({ components: {} }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(sheet({ wires: ['x'] }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(sheet({ busEntries: [7] }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(sheet({ junctions: [7] }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(sheet({ attrs: [7] }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(sheet({
      components: [{ id: 'c', kind: 'part', position: { x: 0, y: 0 }, pins: ['x'] }],
    }))).toThrow(irInvalid())
  })

  it('rejects wrong scalar field types', () => {
    const doc = (extra: Record<string, unknown>) => ({
      sheets: [{
        components: [{ id: 'c', kind: 'part', position: { x: 0, y: 0 }, pins: [], ...extra }],
        wires: [], busEntries: [], junctions: [], attrs: [],
      }],
    })
    expect(() => parseSchematicIr(doc({ id: 42 }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({ rotation: 'x' }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({ rotation: Number.NaN }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({ mirror: 'yes' }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({ netName: 7 }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({ position: 5 }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({ position: { x: 0, y: 'b' } }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({
      pins: [{ id: 'p', name: 7, electric: 'INPUT', endpoint: { x: 0, y: 0 } }],
    }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({
      pins: [{ id: 'p', name: 'n', number: 3, electric: 'INPUT', endpoint: { x: 0, y: 0 } }],
    }))).toThrow(irInvalid())
  })

  it('rejects non-integer bus-entry order and non-array wire dots', () => {
    const doc = (over: Record<string, unknown>) => ({
      sheets: [{ components: [], wires: [], busEntries: [], junctions: [], attrs: [], ...over }],
    })
    expect(() => parseSchematicIr(doc({
      busEntries: [{ id: 'b', busNet: 'A[1:2]', order: 1.5, point: { x: 0, y: 0 } }],
    }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({
      busEntries: [{ id: 'b', busNet: 'A[1:2]', order: 'x', point: { x: 0, y: 0 } }],
    }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({
      wires: [{ id: 'w', kind: 'wire', dots: 'x' }],
    }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({
      wires: [{ id: 'w', kind: 'wire', dots: ['x'] }],
    }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({
      wires: [{ id: 'w', kind: 'wire', dots: [[0, 0, 1, 0]], net: 7 }],
    }))).toThrow(irInvalid())
  })

  it('parses a logical document with geometry omitted for the layout stage', () => {
    const ir = parseSchematicIr({
      sheets: [{
        components: [{
          id: 'u1', kind: 'part', designator: 'U1', lcsc: 'C25804',
          pins: [{ id: 'p1', name: 'IN', number: '1', electric: 'INPUT', net: 'SIG' }],
        }],
        wires: [{ id: 'w1', kind: 'wire', net: 'SIG' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    })
    const component = ir.sheets[0]!.components[0]!
    expect(component.position).toBeUndefined()
    expect(component.pins[0]).toMatchObject({ net: 'SIG', endpoint: undefined })
    expect(ir.sheets[0]!.wires[0]!.dots).toEqual([])
  })

  it('rejects a non-string pin net and a non-point endpoint', () => {
    const doc = (pin: Record<string, unknown>) => ({
      sheets: [{
        components: [{ id: 'c', kind: 'part', pins: [pin] }],
        wires: [], busEntries: [], junctions: [], attrs: [],
      }],
    })
    expect(() => parseSchematicIr(doc({ id: 'p', electric: 'INPUT', net: 7 }))).toThrow(irInvalid())
    expect(() => parseSchematicIr(doc({ id: 'p', electric: 'INPUT', endpoint: 'x' }))).toThrow(irInvalid())
  })
})
