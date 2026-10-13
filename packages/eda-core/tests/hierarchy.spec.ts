import { describe, expect, it } from 'vitest'
import { computeSheetSymbolBoxes } from '@deepseek-ai/dsh-plugin-eda-core'
import type { SchematicIrComponent, SchematicIrSheet } from '@deepseek-ai/dsh-plugin-eda-sch'

const block = (overrides: Partial<SchematicIrComponent> = {}): SchematicIrComponent => ({
  id: 'blk1',
  kind: 'block',
  pins: [],
  ...overrides,
})

const sheet = (components: SchematicIrComponent[]): SchematicIrSheet => ({
  components, wires: [], busEntries: [], junctions: [], attrs: [],
})

describe('computeSheetSymbolBoxes', () => {
  it('skips non-block components and titles by designator', () => {
    const boxes = computeSheetSymbolBoxes(sheet([
      { id: 'u1', kind: 'part', pins: [] },
      block({ designator: 'POWER', position: { x: 100, y: 100 } }),
    ]))
    expect(boxes).toHaveLength(1)
    expect(boxes[0]!.componentId).toBe('blk1')
    expect(boxes[0]!.title).toBe('POWER')
  })

  it('falls back through netName and id for the title', () => {
    expect(computeSheetSymbolBoxes(sheet([block({ netName: 'PWR' })]))[0]!.title).toBe('PWR')
    expect(computeSheetSymbolBoxes(sheet([block()]))[0]!.title).toBe('blk1')
  })

  it('spans pin endpoints on the box edges with a title headroom above', () => {
    const [box] = computeSheetSymbolBoxes(sheet([block({
      pins: [
        { id: 'p1', name: 'VIN', number: '1', electric: 'INPUT', endpoint: { x: 300, y: 350 } },
        { id: 'p2', name: 'VOUT', number: '2', electric: 'OUTPUT', endpoint: { x: 460, y: 400 } },
        { id: 'p3', name: 'EN', number: '3', electric: 'INPUT', endpoint: { x: 300, y: 400 } },
      ],
    })]))
    // Edges track the endpoint span exactly: x 300..460, y 350..400 plus a
    // 40-unit title band above and a 10-unit pad below.
    expect(box!.x).toBe(300)
    expect(box!.width).toBe(160)
    expect(box!.y).toBe(310)
    expect(box!.height).toBe(100)
    expect(box!.titleX).toBe(308)
    expect(box!.titleY).toBe(320)
    const [vin, vout, en] = box!.pins
    expect(vin!.name).toBe('VIN')
    expect(vin!.align).toBe('LEFT_TOP')
    expect(vin!.x).toBe(308)
    expect(vin!.y).toBe(350)
    expect(vout!.align).toBe('RIGHT_TOP')
    expect(vout!.x).toBe(452)
    expect(vout!.y).toBe(400)
    expect(en!.align).toBe('LEFT_TOP')
    expect(en!.y).toBe(400)
  })

  it('widens a single-column pin span to the minimum body width', () => {
    const [box] = computeSheetSymbolBoxes(sheet([block({
      pins: [
        { id: 'p1', name: 'A', number: '1', electric: 'INPUT', endpoint: { x: 300, y: 350 } },
        { id: 'p2', name: 'B', number: '2', electric: 'INPUT', endpoint: { x: 300, y: 400 } },
      ],
    })]))
    expect(box!.width).toBe(60)
    expect(box!.pins.every(pin => pin.align === 'LEFT_TOP')).toBe(true)
  })

  it('boxes a pinless block around its position', () => {
    const [box] = computeSheetSymbolBoxes(sheet([block({ position: { x: 120, y: 200 } })]))
    expect(box!.x).toBe(120)
    expect(box!.width).toBe(60)
    expect(box!.y).toBe(200)
    expect(box!.height).toBe(100)
    expect(box!.pins).toEqual([])
  })

  it('stacks endpoint-less pins down the left edge in declaration order', () => {
    const [box] = computeSheetSymbolBoxes(sheet([block({
      position: { x: 0, y: 0 },
      pins: [
        { id: 'pa', name: 'A', electric: 'INPUT' },
        { id: 'pb', number: '7', electric: 'INPUT' },
      ],
    })]))
    expect(box!.pins).toHaveLength(2)
    expect(box!.pins[0]!.name).toBe('A')
    expect(box!.pins[1]!.name).toBe('7')
    expect(box!.pins[0]!.y).toBeLessThan(box!.pins[1]!.y)
    expect(box!.pins.every(pin => pin.align === 'LEFT_TOP' && pin.x === box!.x + 8)).toBe(true)
  })

  it('falls back through net and number for the pin label, then the pin id', () => {
    const [box] = computeSheetSymbolBoxes(sheet([block({
      pins: [
        { id: 'pa', net: 'CLK', electric: 'BI', endpoint: { x: 300, y: 350 } },
        { id: 'pb', number: '4', electric: 'BI', endpoint: { x: 300, y: 400 } },
        { id: 'pc', electric: 'BI' },
        { id: 'pd', electric: 'BI', endpoint: { x: 300, y: 450 } },
      ],
    })]))
    expect(box!.pins.map(pin => pin.name)).toEqual(['CLK', '4', 'pd', 'pc'])
  })
})
