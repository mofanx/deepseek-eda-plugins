import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SCHEMATIC_PAGE_A3, layoutSchematic, validateSchematic } from '@deepseek-ai/dsh-plugin-eda-sch'
import { segmentsTouch, segmentCrossesRect } from '../src/layout.ts'
import type {
  SchematicIr,
  SchematicIrComponent,
  SchematicIrPin,
  SchematicIrSheet,
} from '@deepseek-ai/dsh-plugin-eda-sch'

const pin = (id: string, extra: Partial<SchematicIrPin> = {}): SchematicIrPin => ({
  id,
  name: id.toUpperCase(),
  number: id.replace('p', ''),
  electric: 'BI',
  ...extra,
})

const comp = (id: string, extra: Partial<SchematicIrComponent> = {}): SchematicIrComponent => ({
  id,
  kind: 'part',
  designator: id.toUpperCase(),
  deviceUuid: `dev-${id}`,
  pins: [],
  ...extra,
})

const sheet = (partial: Partial<SchematicIrSheet>): SchematicIrSheet => ({
  components: [],
  wires: [],
  busEntries: [],
  junctions: [],
  attrs: [],
  ...partial,
})

const ir = (...sheets: SchematicIrSheet[]): SchematicIr => ({ sheets })

const gridAligned = (ir: SchematicIr, grid = 10): boolean =>
  ir.sheets.every(sheet =>
    sheet.components.every(component =>
      component.position !== undefined
      && component.position.x % grid === 0
      && component.position.y % grid === 0
      && component.pins.every(pin =>
        pin.endpoint === undefined || (pin.endpoint.x % grid === 0 && pin.endpoint.y % grid === 0),
      ),
    ),
  )

describe('layoutSchematic placement', () => {
  it('assigns grid-aligned positions and pin endpoints when absent', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u1', {
        pins: [
          pin('p1', { electric: 'INPUT', net: 'SIG' }),
          pin('p2', { electric: 'OUTPUT', net: 'OUT' }),
          pin('p3', { electric: 'BI', net: 'REF' }),
        ],
      })],
    })))
    const u1 = laid.sheets[0]?.components[0]
    expect(u1?.position).toEqual({ x: 260, y: 240 })
    expect(gridAligned(laid)).toBe(true)
    // INPUT → left of the body, OUTPUT → right, BI balances onto the left.
    expect(u1?.pins[0]?.endpoint).toEqual({ x: 180, y: 230 })
    expect(u1?.pins[1]?.endpoint).toEqual({ x: 340, y: 240 })
    expect(u1?.pins[2]?.endpoint).toEqual({ x: 180, y: 250 })
  })

  it('layers driver components to the left of their receivers', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('u2', { pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
        comp('u1', { pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
      ],
    })))
    const byId = new Map(laid.sheets[0]?.components.map(component => [component.id, component]))
    expect(byId.get('u1')?.position?.x).toBeLessThan(byId.get('u2')?.position?.x ?? 0)
  })

  it('stacks same-layer components vertically with a row gap', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u2'), comp('u1')],
    })))
    const byId = new Map(laid.sheets[0]?.components.map(component => [component.id, component]))
    expect(byId.get('u1')?.position?.x).toBe(byId.get('u2')?.position?.x)
    expect((byId.get('u2')?.position?.y ?? 0) - (byId.get('u1')?.position?.y ?? 0)).toBeGreaterThanOrEqual(60)
  })

  it('breaks feedback cycles deterministically', () => {
    const doc = ir(sheet({
      components: [
        comp('u1', { pins: [pin('p1', { electric: 'OUTPUT', net: 'N' }), pin('p2', { electric: 'INPUT', net: 'N' })] }),
        comp('u2', { pins: [pin('p1', { electric: 'OUTPUT', net: 'N' }), pin('p2', { electric: 'INPUT', net: 'N' })] }),
      ],
    }))
    const first = layoutSchematic(doc)
    const second = layoutSchematic(doc)
    expect(first).toEqual(second)
    expect(first.sheets[0]?.components.every(component => component.position !== undefined)).toBe(true)
  })

  it('keeps explicit positions and endpoints untouched', () => {
    const doc = ir(sheet({
      components: [comp('u1', {
        position: { x: 123, y: 456 },
        pins: [pin('p1', { endpoint: { x: 111, y: 456 } })],
      })],
    }))
    const laid = layoutSchematic(doc)
    const u1 = laid.sheets[0]?.components[0]
    expect(u1?.position).toEqual({ x: 123, y: 456 })
    expect(u1?.pins[0]?.endpoint).toEqual({ x: 111, y: 456 })
  })

  it('places annotation kinds in a margin column to the right of the main zone', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('u1', { pins: [pin('p1')] }),
        comp('f1', { kind: 'netflag', designator: undefined, netName: 'VCC' }),
        comp('m1', { kind: 'nonelec', designator: undefined }),
      ],
    })))
    const byId = new Map(laid.sheets[0]?.components.map(component => [component.id, component]))
    expect(byId.get('f1')?.position?.x ?? 0).toBeGreaterThan(byId.get('u1')?.position?.x ?? 0)
    expect(byId.get('m1')?.position?.x).toBe(byId.get('f1')?.position?.x)
  })
})

describe('layoutSchematic routing', () => {
  it('routes a small net through an orthogonal trunk wire', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('u1', { pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
        comp('u2', { pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
    })))
    const trunk = laid.sheets[0]?.wires.find(wire => wire.id === 'layout:wire:SIG')
    expect(trunk?.net).toBe('SIG')
    // Both endpoints share a height, so one trunk spine carries the net.
    expect(trunk?.dots).toEqual([[340, 230, 580, 230]])
    // Every emitted segment is axis-aligned.
    for (const dots of trunk?.dots ?? []) {
      for (let i = 0; i + 3 < dots.length; i += 2) {
        expect(dots[i] === dots[i + 2] || dots[i + 1] === dots[i + 3]).toBe(true)
      }
    }
  })

  it('emits a stub and a junction where a member taps the trunk', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('u1', {
          position: { x: 200, y: 300 },
          pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })],
        }),
        comp('u2', { pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
    })))
    const trunk = laid.sheets[0]?.wires.find(wire => wire.id === 'layout:wire:SIG')
    expect(trunk?.dots).toEqual([[280, 230, 580, 230], [280, 300, 280, 230]])
    expect(laid.sheets[0]?.junctions).toEqual([{ point: { x: 280, y: 230 } }])
  })

  it('routes a power pin upward to a generated flag', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u1', { pins: [pin('p1', { electric: 'BI', net: 'VCC', powerName: 'VCC' })] })],
    })))
    const flag = laid.sheets[0]?.components.find(component => component.id.startsWith('layout:flag:'))
    const placed = laid.sheets[0]?.components[0]?.pins[0]
    expect(flag?.kind).toBe('netflag')
    expect(flag?.netName).toBe('VCC')
    expect((flag?.position?.y ?? 0) - (placed?.endpoint?.y ?? 0)).toBe(40)
    const stub = laid.sheets[0]?.wires.find(wire => wire.id === 'layout:wire:VCC:flags')
    expect(stub?.dots).toEqual([[placed?.endpoint?.x, placed?.endpoint?.y, flag?.position?.x, flag?.position?.y]])
  })

  it('routes a ground pin downward to a generated flag', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u1', { pins: [pin('p1', { electric: 'BI', net: 'GND', powerName: 'GND' })] })],
    })))
    const flag = laid.sheets[0]?.components.find(component => component.id.startsWith('layout:flag:'))
    const placed = laid.sheets[0]?.components[0]?.pins[0]
    expect((placed?.endpoint?.y ?? 0) - (flag?.position?.y ?? 0)).toBe(40)
  })

  it('routes a cross-sheet net through netports', () => {
    const laid = layoutSchematic(ir(
      sheet({ components: [comp('u1', { pins: [pin('p1', { electric: 'OUTPUT', net: 'CLK' })] })] }),
      sheet({ components: [comp('u2', { pins: [pin('p1', { electric: 'INPUT', net: 'CLK' })] })] }),
    ))
    for (const laidSheet of laid.sheets) {
      const flag = laidSheet.components.find(component => component.id.startsWith('layout:flag:'))
      expect(flag?.kind).toBe('netport')
      expect(flag?.netName).toBe('CLK')
    }
  })

  it('routes a block interface pin through netports to its child sheet', () => {
    const laid = layoutSchematic(ir(
      sheet({ components: [comp('b1', { kind: 'block', designator: 'B1', sheetIndex: 1, pins: [pin('p1', { electric: 'OUTPUT', net: 'CLK' })] })] }),
      sheet({ components: [comp('u1', { pins: [pin('p1', { electric: 'INPUT', net: 'CLK' })] })] }),
    ))
    for (const laidSheet of laid.sheets) {
      const flag = laidSheet.components.find(component => component.id.startsWith('layout:flag:'))
      expect(flag?.kind).toBe('netport')
      expect(flag?.netName).toBe('CLK')
    }
  })

  it('uses flags for high-fanout nets', () => {
    const members = Array.from({ length: 6 }, (_, index) =>
      comp(`u${index}`, {
        position: { x: 300, y: 200 + index * 100 },
        pins: [pin(`p${index}`, { electric: 'INPUT', net: 'WIDE' })],
      }))
    const laid = layoutSchematic(ir(sheet({ components: members })))
    const flags = laid.sheets[0]?.components.filter(component => component.id.startsWith('layout:flag:'))
    // One tapped bus + one flag for the whole receiver column.
    expect(flags?.length).toBe(1)
    expect(flags?.[0]?.id).toContain(':bus:')
    const bus = laid.sheets[0]?.wires.find(wire => wire.id === 'layout:wire:WIDE:flags')
    expect(bus?.net).toBe('WIDE')
    expect(bus?.dots?.length).toBeGreaterThan(0)
  })

  it('extends a tapped bus past an off-grid outermost tap', () => {
    const members = Array.from({ length: 6 }, (_, index) =>
      comp(`u${index}`, {
        position: { x: 300, y: 105 + index * 100 },
        pins: [pin(`p${index}`, {
          electric: 'INPUT',
          net: 'WIDE',
          endpoint: { x: 220, y: 105 + index * 100 },
        })],
      }))
    const laid = layoutSchematic(ir(sheet({ components: members })), { grid: 100 })
    const flags = laid.sheets[0]?.components.filter(component => component.id.startsWith('layout:flag:'))
    expect(flags).toHaveLength(1)
    const wire = laid.sheets[0]?.wires.find(item => item.id === 'layout:wire:WIDE:flags')
    const vertical = (wire?.dots ?? []).find(chain => chain[0] === chain[2] && chain[1] !== chain[3])
    expect(vertical).toBeDefined()
    const [x1, y1, x2, y2] = vertical as number[]
    expect(x1).toBe(x2)
    // The bus must reach the y=605 tap; snap(645,100) alone would stop at 600.
    expect(Math.min(y1 as number, y2 as number)).toBeLessThanOrEqual(105)
    expect(Math.max(y1 as number, y2 as number)).toBeGreaterThanOrEqual(605)
  })

  it('shares one flag across a high-fanout signal column and keeps the driver separate', () => {
    const receivers = Array.from({ length: 7 }, (_, index) =>
      comp(`u${index}`, {
        position: { x: 300, y: 200 + index * 80 },
        pins: [pin(`p${index}`, { electric: 'INPUT', net: 'CLK' })],
      }))
    const driver = comp('src', {
      position: { x: 600, y: 400 },
      pins: [pin('ps', { electric: 'OUTPUT', net: 'CLK' })],
    })
    const laid = layoutSchematic(ir(sheet({ components: [driver, ...receivers] })))
    const flags = laid.sheets[0]?.components.filter(component =>
      component.kind === 'netflag' && component.netName === 'CLK') ?? []
    // 8 receiver/driver pins would be 8 flags; the receiver column aggregates
    // to one bus flag and the lone driver keeps one flag.
    expect(flags).toHaveLength(2)
    expect(flags.some(flag => flag.id.includes(':bus:'))).toBe(true)
    const errors = validateSchematic(laid).findings.filter(finding => finding.severity === 'error')
    expect(errors).toEqual([])
  })

  it('falls back to flags when a trunk would touch a foreign pin endpoint', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('r1', { pins: [pin('p1', { net: 'OTHER' }), pin('p2', { net: 'SIG' })] }),
        comp('r2', { pins: [pin('p1', { net: 'SIG' })] }),
      ],
    })))
    const wires = laid.sheets[0]?.wires ?? []
    expect(wires.some(wire => wire.id === 'layout:wire:SIG')).toBe(false)
    const stub = wires.find(wire => wire.id === 'layout:wire:SIG:flags')
    expect(stub?.net).toBe('SIG')
    const flags = laid.sheets[0]?.components.filter(component => component.id.startsWith('layout:flag:SIG:'))
    expect(flags?.length).toBe(2)
  })

  it('extends a lone left-side member stub away from the component body', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u1', { pins: [pin('p1', { electric: 'INPUT', net: 'SENSE' })] })],
    })))
    const endpoint = laid.sheets[0]?.components[0]?.pins[0]?.endpoint
    const wire = laid.sheets[0]?.wires.find(candidate => candidate.id === 'layout:wire:SENSE')
    expect(endpoint?.x).toBeDefined()
    expect((wire?.dots?.[0]?.[2] ?? 0) < (endpoint?.x ?? 0)).toBe(true)
  })

  it('routes a lone ground net through a flag without a powerName hint', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u1', { pins: [pin('p1', { electric: 'BI', net: 'GND' })] })],
    })))
    const flag = laid.sheets[0]?.components.find(component => component.id === 'layout:flag:GND:0')
    expect(flag?.kind).toBe('netflag')
    expect(flag?.netName).toBe('GND')
  })

  it('emits one junction where stacked same-column stubs share a tap point', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [0, 1, 2].map(index =>
        comp(`u${index}`, { pins: [pin('p1', { electric: 'INPUT', net: 'BUS' })] })),
    })))
    const junctions = laid.sheets[0]?.junctions ?? []
    expect(junctions).toHaveLength(1)
    const trunk = laid.sheets[0]?.wires.find(wire => wire.id === 'layout:wire:BUS')
    expect(trunk?.net).toBe('BUS')
  })

  it('falls back to flags when a carrier stub would touch a foreign junction', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u1', { pins: [pin('p1', { electric: 'INPUT', net: 'X' })] })],
      wires: [{ id: 'w1', kind: 'wire', dots: [[100, 100, 300, 100]], net: 'X' }],
      junctions: [{ point: { x: 150, y: 230 } }],
    })))
    const carrier = laid.sheets[0]?.wires.find(wire => wire.id === 'w1')
    expect(carrier?.dots).toEqual([[100, 100, 300, 100]])
    const stub = laid.sheets[0]?.wires.find(wire => wire.id === 'layout:wire:X:flags')
    expect(stub?.net).toBe('X')
  })

  it('stubs members onto a declared net-only carrier wire', () => {
    const doc = ir(sheet({
      components: [
        comp('u1', {
          position: { x: 200, y: 300 },
          pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })],
        }),
        comp('u2', { pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
      wires: [{ id: 'w1', kind: 'wire', net: 'SIG' }],
    }))
    const laid = layoutSchematic(doc)
    const carrier = laid.sheets[0]?.wires.find(wire => wire.id === 'w1')
    expect(carrier?.net).toBe('SIG')
    expect(carrier?.dots).toEqual([[280, 230, 580, 230], [280, 300, 280, 230]])
    expect(laid.sheets[0]?.wires.some(wire => wire.id === 'layout:wire:SIG')).toBe(false)
  })

  it('stubs members onto an explicitly routed carrier wire', () => {
    const doc = ir(sheet({
      components: [
        comp('u1', {
          position: { x: 200, y: 200 },
          pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG', endpoint: { x: 140, y: 200 } })],
        }),
      ],
      wires: [{ id: 'w1', kind: 'wire', dots: [[100, 100, 300, 100]], net: 'SIG' }],
    }))
    const laid = layoutSchematic(doc)
    const carrier = laid.sheets[0]?.wires.find(wire => wire.id === 'w1')
    expect(carrier?.dots?.length).toBe(2)
    // The stub is an L-path ending at the carrier's first vertex.
    expect(carrier?.dots?.[1]).toEqual([140, 200, 100, 200, 100, 100])
  })

  it('leaves members alone when their endpoint already touches a named wire', () => {
    const doc = ir(sheet({
      components: [
        comp('u1', {
          position: { x: 200, y: 200 },
          pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG', endpoint: { x: 150, y: 100 } })],
        }),
      ],
      wires: [{ id: 'w1', kind: 'wire', dots: [[100, 100, 300, 100]], net: 'SIG' }],
    }))
    const laid = layoutSchematic(doc)
    expect(laid.sheets[0]?.wires.find(wire => wire.id === 'w1')?.dots).toEqual([[100, 100, 300, 100]])
    expect(laid.sheets[0]?.wires.length).toBe(1)
  })

  it('treats a zero-length wire segment as a point contact', () => {
    const doc = ir(sheet({
      components: [
        comp('u1', {
          position: { x: 160, y: 100 },
          pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG', endpoint: { x: 100, y: 100 } })],
        }),
        comp('u2', {
          position: { x: 200, y: 200 },
          pins: [
            pin('p1', { electric: 'INPUT', net: 'SIG', endpoint: { x: 140, y: 200 } }),
            pin('p2', { electric: 'INPUT', net: 'SIG', endpoint: { x: 100, y: 200 } }),
          ],
        }),
      ],
      wires: [{ id: 'w1', kind: 'wire', dots: [[100, 100, 100, 100]], net: 'SIG' }],
    }))
    const laid = layoutSchematic(doc)
    // u1:p1 sits on the degenerate point and stays put; the carrier extends to
    // reach the other two members instead of spawning trunk wires.
    const carrier = laid.sheets[0]?.wires.find(wire => wire.id === 'w1')
    expect(carrier?.dots?.[0]).toEqual([100, 100, 100, 100])
    expect(carrier?.dots?.length).toBeGreaterThan(1)
  })

  it('is idempotent and deterministic', () => {
    const doc = ir(sheet({
      components: [
        comp('u1', { pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' }), pin('p2', { electric: 'BI', net: 'VCC', powerName: 'VCC' })] }),
        comp('u2', { pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
    }))
    const once = layoutSchematic(doc)
    const twice = layoutSchematic(once)
    expect(twice).toEqual(once)
  })
})

describe('layoutSchematic options', () => {
  it('honors grid, margin, and pitch overrides', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u1', { pins: [pin('p1', { electric: 'INPUT' }), pin('p2', { electric: 'OUTPUT' })] })],
    })), { grid: 50, margin: { x: 500, y: 500 }, columnPitch: 500, pinStub: 50, pinPitch: 50 })
    const u1 = laid.sheets[0]?.components[0]
    expect(u1?.position).toEqual({ x: 550, y: 550 })
    expect(gridAligned(laid, 50)).toBe(true)
    expect(u1?.pins[0]?.endpoint?.x).toBe(450)
  })

  it('honors the flag fanout threshold', () => {
    const members = Array.from({ length: 3 }, (_, index) =>
      comp(`u${index}`, { pins: [pin('p1', { electric: 'INPUT', net: 'N' })] }))
    // Below the threshold the net routes as a trunk, not flags.
    const trunk = layoutSchematic(ir(sheet({ components: members })), { flagFanout: 4 })
    expect(trunk.sheets[0]?.components.filter(component => component.id.startsWith('layout:flag:'))).toHaveLength(0)
    expect(trunk.sheets[0]?.wires.some(wire => wire.id === 'layout:wire:N')).toBe(true)
    // At the threshold it flags; a same-column run then aggregates to one bus flag.
    const flagged = layoutSchematic(ir(sheet({ components: members })), { flagFanout: 3 })
    const flags = flagged.sheets[0]?.components.filter(component => component.id.startsWith('layout:flag:')) ?? []
    expect(flags).toHaveLength(1)
    expect(flags[0]?.id).toContain(':bus:')
  })
})

describe('layoutSchematic geometry edge cases', () => {
  it('preserves declared junctions and does not duplicate a colliding generated one', () => {
    // u2's endpoint sits off the SIG trunk; the junction at its crossing is
    // already declared, so layout adds nothing there, while the unrelated
    // declared junction is kept.
    const doc = ir(sheet({
      components: [
        comp('u1', { position: { x: 260, y: 230 }, pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
        comp('u2', { position: { x: 660, y: 290 }, pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
      junctions: [{ point: { x: 580, y: 230 } }, { point: { x: 50, y: 50 } }],
    }))
    const laid = layoutSchematic(doc)
    const points = laid.sheets[0]?.junctions.map(j => `${j.point.x},${j.point.y}`).sort()
    expect(points).toEqual(['50,50', '580,230'])
  })

  it('orders two same-x flags of a net by y', () => {
    const doc = ir(sheet({
      components: [
        comp('f2', { kind: 'netflag', netName: 'N', position: { x: 300, y: 500 }, pins: [] }),
        comp('f1', { kind: 'netflag', netName: 'N', position: { x: 300, y: 400 }, pins: [] }),
        comp('u1', { pins: [pin('p1', { electric: 'INPUT', net: 'N' })] }),
      ],
    }))
    const laid = layoutSchematic(doc)
    const stubs = laid.sheets[0]?.wires.filter(w => w.id.startsWith('layout:wire:'))
    // Flag strategy: u1's pin still gets its own stub + generated flag.
    expect(stubs?.length).toBe(1)
    expect(laid.sheets[0]?.components.filter(c => c.id.startsWith('layout:flag:')).length).toBe(1)
  })

  it('omits the stub segment when a coarse grid snaps the flag onto the endpoint', () => {
    const doc = ir(sheet({
      components: [
        comp('u1', { position: { x: 200, y: 200 }, pins: [pin('p1', { electric: 'INPUT', net: 'N' })] }),
        comp('u2', { position: { x: 700, y: 200 }, pins: [pin('p1', { electric: 'INPUT', net: 'N' })] }),
      ],
    }))
    const laid = layoutSchematic(doc, { grid: 100, flagFanout: 2 })
    const flagWire = laid.sheets[0]?.wires.find(w => w.id === 'layout:wire:N:flags')
    expect(flagWire).toBeUndefined()
    expect(laid.sheets[0]?.components.filter(c => c.id.startsWith('layout:flag:')).length).toBe(2)
  })
})

describe('layoutSchematic bound-symbol geometry', () => {
  // Symbol pins reach the layout stage in sheet/API space (y down): the
  // EasyEDA adapter flips the persisted symbol document's y on the way out.
  const symbolPins = new Map([['sym-u1', [
    { number: '1', x: -60, y: 20 },
    { number: '2', x: -60, y: 0 },
    { number: '8', x: 50, y: 20 },
  ]]])

  it('places pin endpoints on the resolved symbol pin offsets', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u1', {
        symbolUuid: 'sym-u1',
        position: { x: 200, y: 200 },
        pins: [pin('p1'), pin('p2'), pin('p8')],
      })],
    })), { symbolPins })
    const u1 = laid.sheets[0]?.components[0]
    expect(u1?.pins[0]?.endpoint).toEqual({ x: 140, y: 220 })
    expect(u1?.pins[1]?.endpoint).toEqual({ x: 140, y: 200 })
    expect(u1?.pins[2]?.endpoint).toEqual({ x: 250, y: 220 })
  })

  it('transforms symbol pin offsets under rotation and mirror', () => {
    const rotated = layoutSchematic(ir(sheet({
      components: [comp('u1', {
        symbolUuid: 'sym-u1', position: { x: 200, y: 200 }, rotation: 180,
        pins: [pin('p1')],
      })],
    })), { symbolPins })
    expect(rotated.sheets[0]?.components[0]?.pins[0]?.endpoint).toEqual({ x: 260, y: 180 })

    const mirrored = layoutSchematic(ir(sheet({
      components: [comp('u1', {
        symbolUuid: 'sym-u1', position: { x: 200, y: 200 }, mirror: true,
        pins: [pin('p1')],
      })],
    })), { symbolPins })
    expect(mirrored.sheets[0]?.components[0]?.pins[0]?.endpoint).toEqual({ x: 260, y: 220 })
  })

  it('snaps explicit endpoints within one grid step of the true pin', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u1', {
        symbolUuid: 'sym-u1', position: { x: 200, y: 200 },
        pins: [pin('p1', { endpoint: { x: 145, y: 215 } })],
      })],
    })), { symbolPins })
    expect(laid.sheets[0]?.components[0]?.pins[0]?.endpoint).toEqual({ x: 140, y: 220 })
  })

  it('keeps explicit endpoints beyond the snap tolerance for the validator to flag', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u1', {
        symbolUuid: 'sym-u1', position: { x: 200, y: 200 },
        pins: [pin('p1', { endpoint: { x: 160, y: 180 } })],
      })],
    })), { symbolPins })
    expect(laid.sheets[0]?.components[0]?.pins[0]?.endpoint).toEqual({ x: 160, y: 180 })
  })

  it('derives the flag-routing side from the real pin offset, keeping assigned sides at dx zero', () => {
    const vertical = new Map([['sym-v', [
      { number: '1', x: 0, y: 20 },
    ]]])
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('u1', {
          symbolUuid: 'sym-v', position: { x: 200, y: 200 },
          pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })],
        }),
        comp('u2', {
          symbolUuid: 'sym-u1', position: { x: 600, y: 200 },
          pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })],
        }),
      ],
    })), { symbolPins: new Map([...symbolPins, ...vertical]) })
    const u1p = laid.sheets[0]?.components[0]?.pins[0]?.endpoint
    const u2p = laid.sheets[0]?.components[1]?.pins[0]?.endpoint
    // u1's pin sits at dx 0 (kept side); u2's pin 1 sits at dx -60 (left).
    expect(u1p).toEqual({ x: 200, y: 220 })
    expect(u2p).toEqual({ x: 540, y: 220 })
    const trunk = laid.sheets[0]?.wires.find(wire => wire.id === 'layout:wire:SIG')
    expect(trunk?.dots).toEqual([[200, 220, 540, 220]])
  })

  it('falls back to synthesized rows for pins absent from the symbol record', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [comp('u1', {
        symbolUuid: 'sym-u1', position: { x: 200, y: 200 },
        pins: [pin('p1'), pin('p9')],
      })],
    })), { symbolPins })
    const u1 = laid.sheets[0]?.components[0]
    expect(u1?.pins[0]?.endpoint).toEqual({ x: 140, y: 220 })
    // p9 has no symbol counterpart: synthesized row on its electric side
    // (BI balances left→right, p1 took left, so p9 goes right).
    expect(u1?.pins[1]?.endpoint).toEqual({ x: 280, y: 200 })
  })
})

describe('layoutSchematic module clustering', () => {
  const byId = (laid: SchematicIr) =>
    new Map(laid.sheets[0]?.components.map(component => [component.id, component]))

  it('packs declared modules into separate grid cells in declaration order', () => {
    const laid = layoutSchematic(ir(sheet({
      blocks: [{ name: 'mcu', title: 'MCU' }, { name: 'psu', title: 'PSU' }],
      components: [
        comp('u1', { block: 'mcu', pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
        comp('u2', { block: 'mcu' }),
        comp('u3', { block: 'psu' }),
        comp('u4', { block: 'psu' }),
      ],
    })))
    const placed = byId(laid)
    const mcuRight = Math.max(placed.get('u1')?.position?.x ?? 0, placed.get('u2')?.position?.x ?? 0)
    const psuLeft = Math.min(placed.get('u3')?.position?.x ?? 0, placed.get('u4')?.position?.x ?? 0)
    expect(psuLeft).toBeGreaterThan(mcuRight)
    // The module gap is wider than one signal-flow column.
    expect(psuLeft - mcuRight).toBeGreaterThan(240)
  })

  it('orders undeclared block names after declared modules and ungrouped members last', () => {
    const laid = layoutSchematic(ir(sheet({
      blocks: [{ name: 'psu' }],
      components: [
        comp('u1', { block: 'extra' }),
        comp('u2', { block: 'psu' }),
        comp('u3'),
      ],
    })))
    const placed = byId(laid)
    const x = (id: string) => placed.get(id)?.position?.x ?? 0
    const y = (id: string) => placed.get(id)?.position?.y ?? 0
    // Three cells with the default √3≈2 columns: psu and extra on row one,
    // the ungrouped remainder wrapped onto row two.
    expect(x('u2')).toBeLessThan(x('u1'))
    expect(y('u3')).toBeGreaterThan(y('u1'))
  })

  it('routes inter-module nets through flags instead of a trunk', () => {
    const laid = layoutSchematic(ir(sheet({
      blocks: [{ name: 'a' }, { name: 'b' }],
      components: [
        comp('u1', { block: 'a', pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
        comp('u2', { block: 'b', pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
    })))
    expect(laid.sheets[0]?.wires.some(wire => wire.id === 'layout:wire:SIG')).toBe(false)
    const flags = laid.sheets[0]?.components.filter(component => component.id.startsWith('layout:flag:SIG:'))
    expect(flags?.map(flag => flag.kind)).toEqual(['netflag', 'netflag'])
    expect(flags?.every(flag => flag.netName === 'SIG')).toBe(true)
  })

  it('keeps an intra-module net on its trunk', () => {
    const laid = layoutSchematic(ir(sheet({
      blocks: [{ name: 'a' }],
      components: [
        comp('u1', { block: 'a', pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
        comp('u2', { block: 'a', pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
    })))
    expect(laid.sheets[0]?.wires.some(wire => wire.id === 'layout:wire:SIG')).toBe(true)
  })

  it('treats members of one implicit block set as cross-module', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('u1', { block: 'a', pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
        comp('u2', { pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
    })))
    // u2 has no block: the implicit remainder group is a distinct module cell,
    // so SIG still routes through flags.
    expect(laid.sheets[0]?.wires.some(wire => wire.id === 'layout:wire:SIG')).toBe(false)
    expect(laid.sheets[0]?.components.filter(c => c.id.startsWith('layout:flag:SIG:')).length).toBe(2)
  })

  it('stacks modules vertically when moduleColumns is 1', () => {
    const laid = layoutSchematic(ir(sheet({
      blocks: [{ name: 'a' }, { name: 'b' }],
      components: [comp('u1', { block: 'a' }), comp('u2', { block: 'b' })],
    })), { moduleColumns: 1 })
    const placed = byId(laid)
    expect(placed.get('u2')?.position?.y).toBeGreaterThan(placed.get('u1')?.position?.y ?? 0)
    expect(placed.get('u2')?.position?.x).toBe(placed.get('u1')?.position?.x)
  })

  it('is deterministic and idempotent with modules', () => {
    const doc = ir(sheet({
      blocks: [{ name: 'a' }, { name: 'b' }],
      components: [
        comp('u1', { block: 'a', pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
        comp('u2', { block: 'b', pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
    }))
    const once = layoutSchematic(doc)
    expect(layoutSchematic(doc)).toEqual(once)
    expect(layoutSchematic(once)).toEqual(once)
  })
})

describe('page bounds', () => {
  const A4 = { width: 1170, height: 825 }
  const allGeometry = (ir: SchematicIr): { x: number; y: number }[] =>
    ir.sheets.flatMap(sheet => [
      ...sheet.components.flatMap(component => [
        ...component.position === undefined ? [] : [component.position],
        ...component.pins.flatMap(pin => pin.endpoint === undefined ? [] : [pin.endpoint]),
      ]),
      ...sheet.junctions.map(junction => junction.point),
      ...sheet.wires.flatMap(wire => (wire.dots ?? []).flatMap(chain => {
        const points: { x: number; y: number }[] = []
        for (let i = 0; i + 1 < chain.length; i += 2) {
          points.push({ x: chain[i] as number, y: chain[i + 1] as number })
        }
        return points
      })),
    ])
  const inPage = (p: { x: number; y: number }, page = A4): boolean =>
    p.x >= 0 && p.x <= page.width && p.y >= 0 && p.y <= page.height

  it('keeps generated geometry inside the A4 frame for a packed module grid', () => {
    const laid = layoutSchematic(ir(sheet({
      blocks: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
      components: ['a', 'b', 'c', 'd'].map(block =>
        comp(`u-${block}`, { block, pins: [pin('p1', { electric: 'OUTPUT', net: 'VCC', powerName: 'VCC' })] })),
    })))
    expect(laid.sheets).toHaveLength(1)
    for (const point of allGeometry(laid)) expect(inPage(point)).toBe(true)
  })

  it('paginates a vertical module stack instead of shrinking the module gap', () => {
    // Four one-component modules in a single column overflow A4 height at the
    // frame-safe 200-unit gap (4*60 + 3*200 = 840 > 675 usable). Shrinking
    // that gap would make the dashed module frames (80 pad + 60 title
    // headroom) overlap, so the planner paginates instead.
    const doc = ir(sheet({
      blocks: [1, 2, 3, 4].map(i => ({ name: `m${i}` })),
      components: [1, 2, 3, 4].map(i => comp(`u${i}`, { block: `m${i}` })),
    }))
    const laid = layoutSchematic(doc, { moduleColumns: 1 })
    expect(laid.sheets).toHaveLength(2)
    const placed = new Map(laid.sheets[0]?.components.map(component => [component.id, component]))
    expect((placed.get('u2')?.position?.y ?? 0) - (placed.get('u1')?.position?.y ?? 0))
      .toBeGreaterThanOrEqual(260)
    for (const point of allGeometry(laid)) expect(inPage(point)).toBe(true)
  })

  it('keeps the greedy page count when balancing would add a page', () => {
    // One tall module plus five short ones: an even per-page cap would push the
    // tall module onto its own page and still split the shorts into 2 + 2 + 1,
    // so the balance pass must fall back to the greedy 1 + 3 + 2 layout.
    const shorts = ['a', 'b', 'c', 'd', 'e']
    const doc = ir(sheet({
      blocks: [{ name: 'tall' }, ...shorts.map(name => ({ name }))],
      components: [
        comp('tall', { block: 'tall', pins: Array.from({ length: 80 }, (_, i) => pin(`p${i}`)) }),
        ...shorts.map((block, i) => comp(`s${i}`, { block, pins: [pin('p1')] })),
      ],
    }))
    const laid = layoutSchematic(doc, { moduleColumns: 1, pageSize: SCHEMATIC_PAGE_A3 })
    expect(laid.sheets).toHaveLength(3)
    expect(laid.sheets[0]?.components.filter(component => component.kind === 'part')).toHaveLength(1)
  })

  it('paginates a module grid that cannot compress onto one page', () => {
    const doc = ir(sheet({
      name: 'MAIN',
      blocks: Array.from({ length: 9 }, (_, i) => ({ name: `m${i}` })),
      components: Array.from({ length: 9 }, (_, i) =>
        comp(`u${i}`, { block: `m${i}`, pins: [pin('p1', { electric: 'BI', net: 'VCC', powerName: 'VCC' })] })),
    }))
    const laid = layoutSchematic(doc, { moduleColumns: 1 })
    expect(laid.sheets.length).toBeGreaterThan(1)
    // Each page lists the modules it carries, so the generated `MAIN 2`
    // continuation name disappears from a fully grouped split.
    const modulesOf = (page: SchematicIrSheet): string[] =>
      [...new Set(page.components.filter(component => component.kind === 'part').map(component => component.block))]
        .filter((block): block is string => block !== undefined)
    for (const page of laid.sheets) expect(page.name).toBe(modulesOf(page).join('+'))
    expect(laid.sheets.some(page => page.name === 'MAIN 2')).toBe(false)
    for (const point of allGeometry(laid)) expect(inPage(point)).toBe(true)
  })

  it('routes a net crossing a pagination split through net ports', () => {
    const doc = ir(sheet({
      blocks: Array.from({ length: 9 }, (_, i) => ({ name: `m${i}` })),
      components: Array.from({ length: 9 }, (_, i) =>
        comp(`u${i}`, { block: `m${i}`, pins: [pin('p1', { electric: 'BI', net: 'SHARED' })] })),
    }))
    const laid = layoutSchematic(doc, { moduleColumns: 1 })
    expect(laid.sheets.length).toBeGreaterThan(1)
    for (const page of laid.sheets) {
      expect(page.components.some(component => component.kind === 'netport' && component.netName === 'SHARED')).toBe(true)
      expect(page.components.some(component => component.kind === 'netflag' && component.netName === 'SHARED')).toBe(false)
    }
  })

  it('honours a custom pageSize bound', () => {
    const doc = ir(sheet({
      blocks: Array.from({ length: 6 }, (_, i) => ({ name: `m${i}` })),
      components: Array.from({ length: 6 }, (_, i) => comp(`u${i}`, { block: `m${i}` })),
    }))
    const laid = layoutSchematic(doc, { moduleColumns: 1, pageSize: { width: 3000, height: 2000 } })
    expect(laid.sheets).toHaveLength(1)
    for (const point of allGeometry(laid)) {
      expect(inPage(point, { width: 3000, height: 2000 })).toBe(true)
    }
  })

  it('uses the taller A3 frame to fit a module row that A4 must paginate', () => {
    // Four 40-pin modules cannot share A4's 820-unit usable width, so they
    // wrap into two rows whose combined height exceeds A4; A3 fits the same
    // row on one page. Module height is fixed by the pin pitch floor, so the
    // compression ladder cannot hide the width difference.
    // The exported production preset, not a hand-rolled size: A3 is the dense
    // module-board page, so a wrong constant must fail here.
    expect(SCHEMATIC_PAGE_A3).toEqual({ width: 1655, height: 1170 })
    const A3 = SCHEMATIC_PAGE_A3
    const components = Array.from({ length: 4 }, (_, i) => comp(`u${i}`, {
      block: `m${i}`,
      pins: Array.from({ length: 40 }, (_, p) => pin(`p${p}`)),
    }))
    const doc = ir(sheet({
      blocks: Array.from({ length: 4 }, (_, i) => ({ name: `m${i}` })),
      components,
    }))
    const a4 = layoutSchematic(structuredClone(doc), { moduleColumns: 4 })
    expect(a4.sheets.length).toBeGreaterThan(1)
    const a3 = layoutSchematic(structuredClone(doc), { moduleColumns: 4, pageSize: A3 })
    expect(a3.sheets).toHaveLength(1)
    for (const point of allGeometry(a3)) expect(inPage(point, A3)).toBe(true)
  })

  it('paginates module rows onto extra sheets when a smaller frame overflows', () => {
    const small = { width: 1170, height: 500 }
    const doc = ir(sheet({
      blocks: Array.from({ length: 8 }, (_, i) => ({ name: `m${i}` })),
      components: Array.from({ length: 8 }, (_, i) =>
        comp(`u${i}`, { block: `m${i}`, pins: [pin('p1', { electric: 'BI', net: 'SHARED' })] })),
    }))
    const laid = layoutSchematic(doc, { moduleColumns: 1, pageSize: small })
    expect(laid.sheets.length).toBeGreaterThan(1)
    for (const page of laid.sheets) {
      for (const component of page.components) {
        if (component.position !== undefined) expect(inPage(component.position, small)).toBe(true)
        for (const p of component.pins) {
          if (p.endpoint !== undefined) expect(inPage(p.endpoint, small)).toBe(true)
        }
      }
    }
  })

  it('compresses column pitch when a signal chain exceeds the row width', () => {
    // A five-layer chain spans 1720 units at default pitch — wider than the
    // 890-unit usable width — but fits once the pitch floors at 160.
    const doc = ir(sheet({
      components: Array.from({ length: 5 }, (_, i) => comp(`u${i}`, {
        pins: [
          ...i > 0 ? [pin(`in${i}`, { electric: 'INPUT' as const, net: `N${i - 1}` })] : [],
          pin(`out${i}`, { electric: 'OUTPUT' as const, net: `N${i}` }),
        ],
      })),
    }))
    const laid = layoutSchematic(doc)
    expect(laid.sheets).toHaveLength(1)
    const placed = laid.sheets[0]?.components.map(component => component.position)
    expect((placed?.[4]?.x ?? 0) - (placed?.[0]?.x ?? 0)).toBeLessThanOrEqual(4 * 160)
    for (const point of allGeometry(laid)) expect(inPage(point)).toBe(true)
  })

  it('keeps a single oversized group on its page at the tightest spacing', () => {
    // A flat sheet is one atomic group — it cannot paginate; the tightest
    // spacing rung still applies and the validator flags what remains out.
    const doc = ir(sheet({
      components: Array.from({ length: 30 }, (_, i) => comp(`u${i}`)),
    }))
    const laid = layoutSchematic(doc)
    expect(laid.sheets).toHaveLength(1)
    const placed = laid.sheets[0]?.components.map(component => component.position)
    // Tightest rung: row gap floors at 30 — a taller step would mean the
    // ladder did not apply.
    expect((placed?.[1]?.y ?? 0) - (placed?.[0]?.y ?? 0)).toBeLessThanOrEqual(60 + 30)
  })

  it('wraps a tall single column into continuation columns instead of overflowing', () => {
    // One group with a column taller than the usable page wraps rightward at
    // the bottom edge, so the whole sheet still fits on one page.
    const doc = ir(sheet({
      components: Array.from({ length: 12 }, (_, i) =>
        comp(`u${i}`, { pins: Array.from({ length: 8 }, (_, p) => pin(`p${p}`)) })),
    }))
    const laid = layoutSchematic(doc)
    expect(laid.sheets).toHaveLength(1)
    const xs = new Set(laid.sheets[0]?.components.map(component => component.position?.x))
    expect(xs.size).toBeGreaterThan(1)
    for (const point of allGeometry(laid)) expect(inPage(point)).toBe(true)
  })

  it('keeps a lone component taller than the page on one sheet at the tightest rung', () => {
    // 240 pins on one body: even at the 10-unit pin-pitch floor its outline
    // exceeds the usable height, so the ladder fails every rung and the sheet
    // stays single — the validator owns the remaining violation.
    const doc = ir(sheet({
      components: [comp('u1', {
        pins: Array.from({ length: 240 }, (_, p) => pin(`p${p}`)),
      })],
    }))
    const laid = layoutSchematic(doc)
    expect(laid.sheets).toHaveLength(1)
    expect(laid.sheets[0]?.components[0]?.position).toBeDefined()
  })

  it('wraps the annotation column rightward when it would pass the bottom edge', () => {
    // Unpositioned net flags stack beside the main zone; more flags than a
    // column holds wrap into a second column instead of leaving the frame.
    const doc = ir(sheet({
      components: [
        comp('u1', { pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
        ...Array.from({ length: 9 }, (_, i) => comp(`f${i}`, { kind: 'netflag' })),
      ],
    }))
    const laid = layoutSchematic(doc)
    const flags = laid.sheets[0]?.components.filter(component => component.kind === 'netflag')
    const xs = new Set(flags?.map(component => component.position?.x))
    expect(xs.size).toBeGreaterThan(1)
    for (const point of allGeometry(laid)) expect(inPage(point)).toBe(true)
  })

  it('leaves authored geometry sheets unpaginated and untouched', () => {
    const doc = ir(sheet({
      components: [comp('u1', { position: { x: 5000, y: 5000 } })],
    }))
    const laid = layoutSchematic(doc)
    expect(laid.sheets).toHaveLength(1)
    expect(laid.sheets[0]?.components[0]?.position).toEqual({ x: 5000, y: 5000 })
  })

  it('mirrors generated flags that would land outside the frame', () => {
    // SIG spans two modules so it routes through flags; u1's OUTPUT endpoint
    // lands on the frame's right edge, u2's GND endpoint near the top edge.
    const doc = ir(sheet({
      components: [
        comp('u1', { block: 'a', position: { x: 1090, y: 400 }, pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
        comp('u2', { block: 'a', position: { x: 400, y: 30 }, pins: [pin('p1', { electric: 'BI', net: 'GND', powerName: 'GND' })] }),
        comp('u3', { block: 'b', position: { x: 600, y: 400 }, pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
    }))
    const laid = layoutSchematic(doc)
    const flags = laid.sheets[0]?.components.filter(component => component.id.startsWith('layout:flag:'))
    for (const flag of flags ?? []) {
      expect(flag.position === undefined ? false : inPage(flag.position)).toBe(true)
    }
    // u1's OUTPUT endpoint sits at x=1170: the flag mirrors to its left.
    const sig = flags?.filter(component => component.netName === 'SIG')
      .find(component => (component.position?.x ?? 0) > 1000)
    expect(sig?.position?.x).toBeLessThanOrEqual(1170)
    // u2's GND flag cannot hang above the top edge; it drops below the pin.
    const gnd = flags?.find(component => component.netName === 'GND')
    expect(gnd?.position?.y).toBeGreaterThan(30)
  })

  it('clamps a generated flag onto the frame when its endpoint is out of bounds', () => {
    const doc = ir(sheet({
      components: [
        comp('u1', { block: 'a', position: { x: 1200, y: 400 }, pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
        comp('u3', { block: 'b', position: { x: 600, y: 400 }, pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
    }))
    const laid = layoutSchematic(doc)
    const flag = laid.sheets[0]?.components
      .filter(component => component.netName === 'SIG')
      .find(component => (component.position?.x ?? 0) > 1000)
    expect(flag?.position?.x).toBe(A4.width)
  })

  it('routes an elbow stub when the clamped flag differs from its endpoint on both axes', () => {
    // u1 sits beyond the top-right corner: its endpoint is out of frame in
    // both axes, so the flag clamps onto the corner and the stub bends.
    const doc = ir(sheet({
      components: [
        comp('u1', { block: 'a', position: { x: 1200, y: -60 }, pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
        comp('u3', { block: 'b', position: { x: 600, y: 400 }, pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
    }))
    const laid = layoutSchematic(doc)
    const flag = laid.sheets[0]?.components
      .filter(component => component.netName === 'SIG')
      .find(component => (component.position?.x ?? 0) > 1000)
    expect(inPage(flag?.position ?? { x: -1, y: -1 })).toBe(true)
    const stub = laid.sheets[0]?.wires.find(wire => wire.net === 'SIG')
    const bent = stub?.dots.some(chain => chain.length > 4)
    expect(bent).toBe(true)
  })
})

describe('golden fixture', () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as SchematicIr

  it('reproduces the committed laid IR for the fixture document', () => {
    expect(layoutSchematic(read('layout-input.json'))).toEqual(read('layout-golden.json'))
  })

  it('reproduces the committed module-grouped laid IR', () => {
    const laid = layoutSchematic(read('module-input.json'))
    expect(laid).toEqual(read('module-golden.json'))
    // The committed module document keeps SIG on flags across the block
    // boundary: no cross-cell trunk wire exists.
    expect(laid.sheets[0]?.wires.some(wire => wire.id === 'layout:wire:SIG')).toBe(false)
  })
})

describe('pagination of content that cannot fit one page', () => {
  const A4 = { width: 1170, height: 825 }
  const inPage = (p: { x: number; y: number }, page = A4): boolean =>
    p.x >= 0 && p.x <= page.width && p.y >= 0 && p.y <= page.height
  const points = (laid: SchematicIr): { x: number; y: number }[] =>
    laid.sheets.flatMap(page => [
      ...page.components.flatMap(component => [
        ...component.position === undefined ? [] : [component.position],
        ...component.pins.flatMap(pin => pin.endpoint === undefined ? [] : [pin.endpoint]),
      ]),
      ...page.junctions.map(junction => junction.point),
      ...page.wires.flatMap(wire => (wire.dots ?? []).flatMap(chain => {
        const vertices: { x: number; y: number }[] = []
        for (let i = 0; i + 1 < chain.length; i += 2) vertices.push({ x: chain[i] as number, y: chain[i + 1] as number })
        return vertices
      })),
    ])

  /** A flat chain too wide and too tall for any spacing rung to fit. */
  const flatChain = (count: number): SchematicIr => ir(sheet({
    name: 'MAIN',
    components: Array.from({ length: count }, (_, i) => comp(`u${i}`, {
      pins: [
        pin(`in${i}`, { electric: 'INPUT', net: `N${i}` }),
        pin(`out${i}`, { electric: 'OUTPUT', net: `N${i + 1}` }),
        pin(`v${i}`, { electric: 'INPUT', net: 'VCC', powerName: 'VCC' }),
        pin(`g${i}`, { electric: 'INPUT', net: 'GND', powerName: 'GND' }),
      ],
    })),
  }))

  it('rewrites explicit block sheetIndex targets when pagination shifts the document', () => {
    // The flat first sheet splits into four pages, so the originally-index-2
    // child sheet becomes page 5. A block that still said `sheetIndex: 2`
    // would bind to a page of the flat sheet and break the hierarchy.
    const top = sheet({
      name: 'TOP',
      components: [comp('b1', {
        kind: 'block',
        designator: 'CHILD',
        sheetIndex: 2,
        pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })],
      })],
    })
    const child = sheet({
      name: 'CHILD',
      components: [
        comp('c1', { pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
        comp('port1', { kind: 'netport', designator: undefined, netName: 'SIG' }),
      ],
    })
    const laid = layoutSchematic({ sheets: [...flatChain(30).sheets, top, child] })
    expect(laid.sheets.length).toBeGreaterThan(3)
    const topPage = laid.sheets.findIndex(page => page.components.some(component => component.id === 'b1'))
    const childPage = laid.sheets.findIndex(page => page.components.some(component => component.id === 'c1'))
    expect(topPage).toBeGreaterThan(0)
    expect(childPage).toBeGreaterThan(topPage)
    const block = laid.sheets[topPage]?.components.find(component => component.id === 'b1')
    expect(block?.sheetIndex).toBe(childPage)
    expect(validateSchematic(laid).findings.filter(finding => finding.code.startsWith('HIERARCHY_'))).toEqual([])
  })

  it('keeps ATTR rows with their owning primitives across a page split', () => {
    // ATTR is sheet-scoped in the serializer: leaving a component's ATTR on
    // page 1 after the component moved to page 4 raises ORPHAN_ATTR and blocks
    // delivery. Component, pin-composite, wire, and bus-entry owners must all
    // follow their primitive; a truly orphaned ATTR stays on page 1 so the
    // validator still reports it.
    const base = flatChain(30).sheets[0] as SchematicIrSheet
    const laid = layoutSchematic(ir(sheet({
      ...base,
      wires: [{ id: 'w1', kind: 'wire', net: 'LINK', dots: [[100, 100, 200, 100]] }],
      busEntries: [{ id: 'be1', busNet: 'A[1:2]', order: 0, point: { x: 100, y: 100 } }],
      attrs: [
        { id: 'a-part', parentId: 'u29', key: 'Note', value: 'part' },
        { id: 'a-pin', parentId: 'u29in29', key: 'Note', value: 'pin' },
        { id: 'a-wire', parentId: 'w1', key: 'Note', value: 'wire' },
        { id: 'a-bus', parentId: 'be1', key: 'Note', value: 'bus' },
        { id: 'a-ghost', parentId: 'ghost', key: 'Note', value: 'ghost' },
      ],
    })))
    const pageOf = (id: string): number =>
      laid.sheets.findIndex(page => page.attrs.some(attr => attr.id === id))
    const partPage = laid.sheets.findIndex(page => page.components.some(component => component.id === 'u29'))
    expect(partPage).toBeGreaterThan(0)
    expect(pageOf('a-part')).toBe(partPage)
    expect(pageOf('a-pin')).toBe(partPage)
    expect(pageOf('a-wire')).toBe(0)
    expect(pageOf('a-bus')).toBe(0)
    expect(pageOf('a-ghost')).toBe(0)
    expect(validateSchematic(laid).findings
      .filter(finding => finding.code === 'ORPHAN_ATTR')
      .map(finding => finding.locator?.componentId)).toEqual(['ghost'])
  })

  it('names a paginated page by the modules it carries', () => {
    // Five six-part modules land 3 + 2 on A3. The reference project names
    // pages after their modules, so the generated `MAIN 2` becomes the actual
    // module list instead of an opaque ordinal.
    const titles = ['MCU', 'POWER', 'IO', 'MEM', 'CLK']
    const components = titles.flatMap((_, m) => Array.from({ length: 6 }, (_, i) => comp(`u${m}_${i}`, {
      block: `m${m}`,
      symbolUuid: 'sym',
      pins: [
        pin('p1', { electric: 'BI', net: `M${m}A${i}` }),
        pin('p2', { electric: 'BI', net: `M${m}B${i}` }),
      ],
    })))
    const laid = layoutSchematic(ir(sheet({
      name: 'MAIN',
      blocks: titles.map((title, m) => ({ name: `m${m}`, title })),
      components,
    })), {
      pageSize: SCHEMATIC_PAGE_A3,
      symbolPins: new Map([['sym', [
        { number: '1', name: 'P1', x: 20, y: -10 },
        { number: '2', name: 'P2', x: 20, y: 10 },
      ]]]),
    })
    expect(laid.sheets.map(page => page.name)).toEqual(['MCU+POWER+IO', 'MEM+CLK'])
    expect(laid.sheets.flatMap(page => page.components.filter(component => component.kind === 'part'))).toHaveLength(30)
  })

  it('keeps the sheet name when a page carries too many modules to list', () => {
    // Six one-part modules per page: joining six keys would be unreadable, so
    // the page keeps the authored name and its ordinal.
    const components = Array.from({ length: 12 }, (_, i) => comp(`u${i}`, {
      block: `m${i}`,
      pins: [pin('p1', { electric: 'BI', net: `N${i}` })],
    }))
    const laid = layoutSchematic(ir(sheet({
      name: 'MAIN',
      blocks: Array.from({ length: 12 }, (_, i) => ({ name: `m${i}` })),
      components,
    })))
    expect(laid.sheets.length).toBe(2)
    expect(laid.sheets.map(page => page.name)).toEqual(['MAIN', 'MAIN 2'])
  })

  it('keeps the sheet name when the module list would be too long', () => {
    // Two long titles per page exceed the composed-name budget; the authored
    // sheet name reads better than a 57-character page tab.
    const titles = Array.from({ length: 9 }, (_, i) => `MODULE-${i}-LONG-NAME-FOR-PAGE`)
    const components = Array.from({ length: 9 }, (_, i) => comp(`u${i}`, {
      block: `m${i}`,
      pins: [pin('p1', { electric: 'BI', net: `N${i}` })],
    }))
    const laid = layoutSchematic(ir(sheet({
      name: 'MAIN',
      blocks: titles.map((title, i) => ({ name: `m${i}`, title })),
      components,
    })), { moduleColumns: 1 })
    expect(laid.sheets.length).toBeGreaterThan(2)
    expect(laid.sheets[0]?.name).toBe('MAIN')
    expect(laid.sheets[1]?.name).toBe('MAIN 2')
  })

  it('pins an implicit hierarchy binding to a page that got a module name', () => {
    // A block that resolved its child by the authored sheet name `MAIN` must
    // keep working after that page is renamed `MCU+POWER+IO`.
    const titles = ['MCU', 'POWER', 'IO', 'MEM', 'CLK']
    const main = sheet({
      name: 'MAIN',
      blocks: titles.map((title, m) => ({ name: `m${m}`, title })),
      components: titles.flatMap((_, m) => Array.from({ length: 6 }, (_, i) => comp(`u${m}_${i}`, {
        block: `m${m}`,
        symbolUuid: 'sym',
        pins: [
          pin('p1', { electric: 'BI', net: `M${m}A${i}` }),
          pin('p2', { electric: 'BI', net: `M${m}B${i}` }),
        ],
      }))),
    })
    const top = sheet({
      name: 'TOP',
      components: [
        comp('child', { kind: 'block', designator: 'MAIN' }),
        comp('unbound', { kind: 'block', designator: 'NOPE' }),
      ],
    })
    const laid = layoutSchematic(ir(main, top), {
      pageSize: SCHEMATIC_PAGE_A3,
      symbolPins: new Map([['sym', [
        { number: '1', name: 'P1', x: 20, y: -10 },
        { number: '2', name: 'P2', x: 20, y: 10 },
      ]]]),
    })
    const topPage = laid.sheets.find(page => page.name === 'TOP')
    const block = topPage?.components.find(component => component.id === 'child')
    expect(block?.sheetIndex).toBe(0)
    // A block whose name matches nothing is left for the validator to report.
    expect(topPage?.components.find(component => component.id === 'unbound')?.sheetIndex).toBeUndefined()
    const hierarchy = validateSchematic(laid).findings.filter(finding => finding.code.startsWith('HIERARCHY'))
    expect(hierarchy.some(finding => finding.locator?.componentId === 'child')).toBe(false)
  })

  it('does not pin implicit blocks when two source sheets share a renamed name', () => {
    const titles = ['MCU', 'POWER', 'IO', 'MEM', 'CLK']
    const board = (tag: string): SchematicIrSheet => sheet({
      name: 'MAIN',
      blocks: titles.map((title, m) => ({ name: `m${m}`, title })),
      components: titles.flatMap((_, m) => Array.from({ length: 6 }, (_, i) => comp(`${tag}${m}_${i}`, {
        block: `m${m}`,
        symbolUuid: 'sym',
        pins: [
          pin('p1', { electric: 'BI', net: `${tag}M${m}A${i}` }),
          pin('p2', { electric: 'BI', net: `${tag}M${m}B${i}` }),
        ],
      }))),
    })
    const laid = layoutSchematic(ir(board('A'), board('B')), {
      pageSize: SCHEMATIC_PAGE_A3,
      symbolPins: new Map([['sym', [
        { number: '1', name: 'P1', x: 20, y: -10 },
        { number: '2', name: 'P2', x: 20, y: 10 },
      ]]]),
    })
    const names = laid.sheets.map(page => page.name)
    // The second source sheet's first page cannot repeat the first sheet's
    // composed name; it takes an ordinal instead.
    expect(names[0]).toBe('MCU+POWER+IO')
    expect(names[2]).toBe('MCU+POWER+IO 2')
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps continuation page names unique against authored sheet names', () => {
    // The flat MAIN sheet splits into MAIN, MAIN 3, MAIN 4, MAIN 5: the
    // authored sheet literally named MAIN 2 keeps its name, so a block that
    // resolves by name is not made ambiguous by a generated duplicate.
    const flat = flatChain(30).sheets[0] as SchematicIrSheet
    const other = sheet({ name: 'MAIN 2', components: [comp('x1')] })
    const laid = layoutSchematic(ir(flat, other))
    const names = laid.sheets.map(page => page.name)
    expect(names[0]).toBe('MAIN')
    expect(names[1]).toBe('MAIN 3')
    expect(names[names.length - 1]).toBe('MAIN 2')
    expect(names.filter(name => name === 'MAIN 2')).toHaveLength(1)
    expect(new Set(names).size).toBe(names.length)
  })

  it('paginates a flat sheet instead of letting it overflow the frame', () => {
    // Previously a single ungrouped group was kept on one sheet at the
    // tightest rung, producing 5000-unit-wide geometry and 143
    // OBJECT_OUT_OF_SHEET errors that blocked delivery.
    const laid = layoutSchematic(flatChain(30))
    expect(laid.sheets.length).toBeGreaterThan(1)
    expect(laid.sheets.flatMap(page => page.components.filter(component => component.kind === 'part'))).toHaveLength(30)
    for (const point of points(laid)) expect(inPage(point)).toBe(true)
    expect(validateSchematic(laid).findings.some(finding => finding.code === 'OBJECT_OUT_OF_SHEET')).toBe(false)
  })

  it('paginates an oversized module, keeps its membership, and numbers continued frames', () => {
    // A single 24-part module cannot split into smaller modules, so the
    // planner shards it by page while every member keeps its block tag.
    const components = Array.from({ length: 24 }, (_, i) => comp(`m${i}`, {
      block: 'mcu',
      pins: [
        pin(`in${i}`, { electric: 'INPUT', net: `N${i}` }),
        pin(`out${i}`, { electric: 'OUTPUT', net: `N${i + 1}` }),
      ],
    }))
    const laid = layoutSchematic(ir(sheet({
      name: 'CORE',
      blocks: [{ name: 'mcu', title: 'MCU CORE' }],
      components,
    })))
    expect(laid.sheets.length).toBeGreaterThan(1)
    expect(laid.sheets.every(page => page.components.every(component =>
      component.kind !== 'part' || component.block === 'mcu'))).toBe(true)
    const titles = laid.sheets.map(page => page.blocks?.[0]?.title)
    expect(titles.every(title => title !== undefined && /^MCU CORE \(\d+\/\d+\)$/.test(title))).toBe(true)
    expect(new Set(titles).size).toBe(titles.length)
    // A split frame continues on later pages and the page titles stay ordered.
    expect(titles[0]).toBe(`MCU CORE (1/${laid.sheets.length})`)
    // The page is named after the module it carries, and the continuation
    // takes the module title plus an ordinal (reference: CORE/POWER/DEVICE).
    expect(laid.sheets[0]?.name).toBe('MCU CORE')
    expect(laid.sheets[1]?.name).toBe('MCU CORE 2')
    for (const point of points(laid)) expect(inPage(point)).toBe(true)
  })

  it('is deterministic and idempotent across pagination', () => {
    const doc = flatChain(30)
    const once = layoutSchematic(doc)
    expect(layoutSchematic(doc)).toEqual(once)
    expect(layoutSchematic(once)).toEqual(once)
  })

  it('keeps an atomic component taller than the page on one sheet', () => {
    // 240 pins make the symbol body taller than any page; splitting cannot
    // help, so the planner still emits the single shard for the validator.
    const doc = ir(sheet({
      components: [comp('u1', { pins: Array.from({ length: 240 }, (_, p) => pin(`p${p}`)) })],
    }))
    const laid = layoutSchematic(doc)
    expect(laid.sheets).toHaveLength(1)
    expect(laid.sheets[0]?.components.filter(component => component.kind === 'part')).toHaveLength(1)
  })

  it('splits a same-layer column across pages and numbers its repeated frame', () => {
    // 24 parts on one net layer form a single column far taller than a page.
    // The shard cut must chunk that column instead of emitting one huge page.
    const components = Array.from({ length: 24 }, (_, i) => comp(`w${i}`, {
      block: 'logic',
      pins: Array.from({ length: 6 }, (_, p) => pin(`p${p}`, { electric: 'BI', net: `L${i}_${p}` })),
    }))
    const laid = layoutSchematic(ir(sheet({
      name: 'BUS',
      blocks: [{ name: 'logic' }],
      components,
    })))
    expect(laid.sheets.length).toBeGreaterThan(1)
    expect(laid.sheets.flatMap(page => page.components.filter(component => component.kind === 'part'))).toHaveLength(24)
    expect(laid.sheets.map(page => page.name)).toEqual(laid.sheets.map((_, i) => i === 0 ? 'logic' : `logic ${i + 1}`))
    const titles = laid.sheets.map(page => page.blocks?.[0]?.title)
    expect(titles.every(title => /^logic \(\d+\/\d+\)$/.test(title ?? ''))).toBe(true)
    for (const point of points(laid)) expect(inPage(point)).toBe(true)
  })

  it('names a page by its module key when the sheet declares no block title', () => {
    // `ghost` has no matching `blocks` entry: the page still takes the key.
    const ghost = layoutSchematic(ir(sheet({
      name: 'GHOSTS',
      blocks: [{ name: 'other' }],
      components: Array.from({ length: 60 }, (_, i) => comp(`g${i}`, {
        block: 'ghost',
        pins: [
          pin(`in${i}`, { electric: 'INPUT', net: `G${i}` }),
          pin(`out${i}`, { electric: 'OUTPUT', net: `H${i}` }),
        ],
      })),
    })))
    expect(ghost.sheets.length).toBeGreaterThan(1)
    expect(ghost.sheets[0]?.name).toBe('ghost')
    expect(ghost.sheets[1]?.name).toBe('ghost 2')
  })

  it('leaves pages unnamed when an unnamed sheet mixes too many modules', () => {
    const small = (prefix: string) => comp(`${prefix}1`, {
      block: prefix,
      pins: [pin('p', { electric: 'BI', net: `${prefix}N` })],
    })
    const big = Array.from({ length: 30 }, (_, i) => comp(`e${i}`, {
      block: 'e',
      pins: [pin(`p${i}`, { electric: 'BI', net: `E${i}` })],
    }))
    const laid = layoutSchematic(ir(sheet({
      name: undefined,
      blocks: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }],
      components: [small('a'), small('b'), small('c'), small('d'), ...big],
    })), { moduleColumns: 2 })
    expect(laid.sheets.length).toBeGreaterThan(1)
    // Four modules exceed the composed-name budget, and the sheet has no name
    // to fall back to; the oversized single-module page is still named `e`.
    expect(laid.sheets[0]?.name).toBeUndefined()
    expect(laid.sheets.some(page => page.name === 'e')).toBe(true)
  })

  it('keeps module-driven page names unique across source sheets', () => {
    // Two source sheets whose single module shares a title: page-zero names
    // must not collide, and the second sheet continues the numbering.
    const big = (prefix: string) => Array.from({ length: 60 }, (_, i) => comp(`${prefix}${i}`, {
      block: 'mcu',
      pins: [
        pin(`a${i}`, { electric: 'BI', net: `${prefix}${i}A` }),
        pin(`b${i}`, { electric: 'BI', net: `${prefix}${i}B` }),
      ],
    }))
    const laid = layoutSchematic(ir(
      sheet({ name: 'A', blocks: [{ name: 'mcu', title: 'MCU CORE' }], components: big('a') }),
      sheet({ name: 'B', blocks: [{ name: 'mcu', title: 'MCU CORE' }], components: big('b') }),
    ))
    const names = laid.sheets.map(page => page.name)
    expect(names.length).toBeGreaterThan(2)
    expect(new Set(names).size).toBe(names.length)
    expect(names[0]).toBe('MCU CORE')
  })

  it("routes a net around another net's wire instead of tapping it", () => {
    // A trunk between the two pins would cross the authored guard wire at
    // (400, 200). A crossing/tap merges nets in the client, so the planner
    // must fall back to named flags for SIG.
    const laid = layoutSchematic(ir(sheet({
      name: 'MAIN',
      components: [
        comp('u1', { pins: [pin('p1', { electric: 'OUTPUT', net: 'SIG' })] }),
        comp('u2', { pins: [pin('p1', { electric: 'INPUT', net: 'SIG' })] }),
      ],
      wires: [{ id: 'guard', kind: 'wire', net: 'VCC', dots: [[400, 100, 400, 700]] }],
    })))
    expect(laid.sheets[0]?.wires.some(wire => wire.id === 'layout:wire:SIG')).toBe(false)
    expect(laid.sheets[0]?.components.filter(component => component.netName === 'SIG')).toHaveLength(2)
    expect(validateSchematic(laid).findings.some(finding => finding.code === 'NET_NAME_CONFLICT')).toBe(false)
  })
})

describe('segment collision predicate', () => {
  const p = (x: number, y: number) => ({ x, y })

  it('detects crossings, taps, shared endpoints, and collinear overlap', () => {
    // Proper crossing.
    expect(segmentsTouch(p(0, 0), p(10, 0), p(5, -5), p(5, 5))).toBe(true)
    // a lies on c-d and b lies on c-d (two collinear containment directions).
    expect(segmentsTouch(p(0, 0), p(10, 0), p(-5, 0), p(15, 0))).toBe(true)
    expect(segmentsTouch(p(0, 0), p(10, 0), p(5, 0), p(15, 0))).toBe(true)
    // T taps: c or d lands on a-b.
    expect(segmentsTouch(p(0, 0), p(10, 0), p(5, 0), p(5, 5))).toBe(true)
    expect(segmentsTouch(p(0, 0), p(10, 0), p(5, 5), p(5, 0))).toBe(true)
    // Shared endpoint and collinear overlap.
    expect(segmentsTouch(p(0, 0), p(10, 0), p(10, 0), p(20, 0))).toBe(true)
    expect(segmentsTouch(p(0, 0), p(10, 0), p(2, 0), p(8, 0))).toBe(true)
    // Disjoint collinear and disjoint parallel segments.
    expect(segmentsTouch(p(0, 0), p(10, 0), p(20, 0), p(30, 0))).toBe(false)
    expect(segmentsTouch(p(0, 0), p(10, 0), p(20, 10), p(30, 10))).toBe(false)
  })
})

describe('segment body-crossing predicate', () => {
  const p = (x: number, y: number) => ({ x, y })
  const rect = { left: 0, right: 100, top: 0, bottom: 100 }

  it('counts a clean crossing but not a segment that starts inside', () => {
    expect(segmentCrossesRect(p(-10, 50), p(110, 50), rect, 0)).toBe(true)
    expect(segmentCrossesRect(p(-10, -10), p(110, 110), rect, 0)).toBe(true)
    // An endpoint inside the outline is a pin stub, not a crossing.
    expect(segmentCrossesRect(p(20, 20), p(110, 20), rect, 0)).toBe(false)
    expect(segmentCrossesRect(p(-10, 50), p(10, 50), rect, 0)).toBe(false)
    // Missing the body entirely, and a pad that collapses the rect.
    expect(segmentCrossesRect(p(-10, -10), p(-10, 110), rect, 0)).toBe(false)
    expect(segmentCrossesRect(p(-10, 150), p(110, 150), rect, 0)).toBe(false)
    expect(segmentCrossesRect(p(-10, 50), p(110, 50), rect, 60)).toBe(false)
  })

  it('lets a pin stub start exactly on the padded edge without hiding edge-to-edge chords', () => {
    // BODY_HALF_WIDTH 60, a 40-unit pin offset and pinStub 20 put the pin
    // exactly on the padded edge; the stub leaves the body from there.
    expect(segmentCrossesRect(p(80, 50), p(120, 50), rect, 20)).toBe(false)
    // A stub aimed back into the body counts as pin geometry, not a crossing.
    expect(segmentCrossesRect(p(80, 50), p(60, 50), rect, 20)).toBe(false)
    // Chords that merely touch the padded edge still cut the body: across the
    // middle, along the top edge, and a near-edge diagonal.
    expect(segmentCrossesRect(p(20, 50), p(80, 50), rect, 20)).toBe(true)
    expect(segmentCrossesRect(p(20, 20), p(80, 20), rect, 20)).toBe(true)
    expect(segmentCrossesRect(p(20, 20), p(80, 21), rect, 20)).toBe(true)
    // The 48-pin case: padded rect [260,340]x[20,500], a chord at y=500 runs
    // from one edge to the other even though both endpoints touch the edge.
    const body = { left: 240, right: 360, top: 0, bottom: 520 }
    expect(segmentCrossesRect(p(340, 500), p(260, 500), body, 20)).toBe(true)
    expect(segmentCrossesRect(p(340, 500), p(420, 500), body, 20)).toBe(false)
  })
})

describe('authored geometry on a paginated sheet', () => {
  it('drops stale wire geometry but keeps the wire row and its ATTR', () => {
    // 24 parts on one layer overflow the page, so the sheet paginates. The
    // authored wire sits far outside the frame; if its dots survived, the
    // validator would report OBJECT_OUT_OF_SHEET.
    const components = Array.from({ length: 24 }, (_, i) => comp(`w${i}`, {
      block: 'logic',
      pins: [
        pin(`p${i}a`, { electric: 'BI', net: `N${i}` }),
        pin(`p${i}b`, { electric: 'BI', net: 'SIG' }),
        ...Array.from({ length: 4 }, (_, k) => pin(`p${i}x${k}`, { electric: 'BI', net: `M${i}_${k}` })),
      ],
    }))
    const laid = layoutSchematic(ir(sheet({
      name: 'BUS',
      blocks: [{ name: 'logic' }],
      components,
      wires: [
        { id: 'w-dots', kind: 'wire', net: 'SIG', dots: [[9000, 9000, 9100, 9000]] },
        { id: 'w-bare', kind: 'wire', net: 'OTHER' },
      ],
      attrs: [{ id: 'a1', key: 'Name', value: 'kept', parentId: 'w-dots' }],
    })))
    expect(laid.sheets.length).toBeGreaterThan(1)
    const page0 = laid.sheets[0] as SchematicIrSheet
    const wire = page0.wires.find(candidate => candidate.id === 'w-dots')
    expect(wire?.net).toBe('SIG')
    // The stale geometry is gone and the row itself became the carrier of the
    // regenerated flag bundle: one primitive keeps the id, the net, and the ATTR
    // instead of an empty row the builder would have to skip.
    expect(wire?.dots?.length).toBeGreaterThan(0)
    expect(page0.wires.some(candidate => candidate.id === 'layout:wire:SIG:flags')).toBe(false)
    expect(page0.wires.some(candidate => candidate.id === 'w-bare')).toBe(true)
    expect(page0.attrs.some(attr => attr.id === 'a1')).toBe(true)
    const findings = validateSchematic(laid).findings
    expect(findings.some(finding => finding.code === 'OBJECT_OUT_OF_SHEET')).toBe(false)
    expect(findings.some(finding => finding.code === 'ORPHAN_ATTR')).toBe(false)
    for (const page of laid.sheets.slice(1)) {
      expect(page.wires.some(candidate => candidate.id === 'w-dots' || candidate.id === 'w-bare')).toBe(false)
      expect(page.attrs).toHaveLength(0)
    }
    // No page kept a vertex from the stale authored geometry.
    for (const page of laid.sheets) {
      for (const wire of page.wires) {
        for (const chain of wire.dots ?? []) {
          expect(chain).not.toContain(9000)
          expect(chain).not.toContain(9100)
        }
      }
    }
  })
})

describe('power and ground bus aggregation', () => {
  const stacked = (count: number) => Array.from({ length: count }, (_, i) => comp(`u${i}`, {
    position: { x: 200, y: 200 + i * 100 },
    pins: [
      pin('v', { electric: 'POWER_IN', net: 'VCC' }),
      pin('g', { electric: 'POWER_IN', net: 'GND' }),
    ],
  }))
  const flag = (laid: SchematicIr, net: string) =>
    laid.sheets[0]?.components.filter(component => component.netName === net && component.kind === 'netflag')

  it('shares one flag and one tapped bus across a stacked power column', () => {
    const laid = layoutSchematic(ir(sheet({ components: stacked(4) })))
    const page = laid.sheets[0] as SchematicIrSheet
    expect(flag(laid, 'VCC')).toHaveLength(1)
    expect(flag(laid, 'GND')).toHaveLength(1)
    // VCC pins sit left of the body at x=120, GND right at x=280; each bus
    // steps one flag stub outward and gets a junction at every tap.
    expect(flag(laid, 'VCC')?.[0]?.position).toEqual({ x: 80, y: 540 })
    expect(flag(laid, 'GND')?.[0]?.position).toEqual({ x: 320, y: 160 })
    expect(page.wires.filter(wire => wire.net === 'VCC')).toHaveLength(1)
    expect(page.wires.filter(wire => wire.net === 'GND')).toHaveLength(1)
    expect(page.junctions).toHaveLength(8)
    for (const wire of page.wires) {
      for (const chain of wire.dots ?? []) {
        for (let i = 0; i < chain.length; i += 2) {
          expect(chain[i]).toBeGreaterThanOrEqual(0)
          expect(chain[i + 1]).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  it('refills an authored empty-dots row instead of adding a flag carrier', () => {
    const laid = layoutSchematic(ir(sheet({
      components: stacked(4),
      wires: [{ id: 'w-decl', kind: 'wire', dots: [], net: 'VCC' }],
    })))
    const page = laid.sheets[0] as SchematicIrSheet
    const declared = page.wires.find(wire => wire.id === 'w-decl')
    expect(declared?.dots?.length).toBeGreaterThan(0)
    expect(page.wires.some(wire => wire.id === 'layout:wire:VCC:flags')).toBe(false)
    expect(page.wires.filter(wire => wire.net === 'VCC')).toHaveLength(1)
  })

  it('does not rewrite a declared bus row into a wire', () => {
    const laid = layoutSchematic(ir(sheet({
      components: stacked(4),
      wires: [{ id: 'bus-decl', kind: 'bus', dots: [], net: 'VCC' }],
    })))
    const page = laid.sheets[0] as SchematicIrSheet
    // Same net, but a bus primitive must never be given wire geometry: the
    // carrier is generated alongside it and the declaration row stays as is.
    expect(page.wires.find(wire => wire.id === 'bus-decl')?.dots).toEqual([])
    expect(page.wires.some(wire => wire.id === 'layout:wire:VCC:flags')).toBe(true)
    expect(page.wires.filter(wire => wire.net === 'VCC')).toHaveLength(2)
  })

  it('does not stack a trunk onto a declared bus row', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('u1', { position: { x: 200, y: 200 }, pins: [pin('p1', { electric: 'BI', net: 'N', endpoint: { x: 300, y: 200 } })] }),
        comp('u2', { position: { x: 200, y: 400 }, pins: [pin('p1', { electric: 'BI', net: 'N', endpoint: { x: 300, y: 400 } })] }),
      ],
      // Same net, but a bus primitive: appending wire segments here would ship a
      // BUS the client never joins, while the offline validator sees a wire.
      wires: [{ id: 'bus-row', kind: 'bus', dots: [[600, 600, 700, 600]], net: 'N' }],
    })))
    const page = laid.sheets[0] as SchematicIrSheet
    expect(page.wires.find(wire => wire.id === 'bus-row')?.dots).toEqual([[600, 600, 700, 600]])
    expect(page.wires.some(wire => wire.id === 'layout:wire:N')).toBe(true)
  })

  it('steps the bus outward past a blocked lane and falls back when all lanes are blocked', () => {
    const blocker = (x: number, y: number): SchematicIrComponent => ({
      id: `f${x}`, kind: 'netflag', netName: 'X', position: { x, y }, pins: [],
    })
    // A foreign flag on the near lane blocks it without crossing the tap stubs
    // (the flag sits between two pin rows), so the bus moves one lane out.
    const near = layoutSchematic(ir(sheet({
      components: [...stacked(4), blocker(80, 250)],
    })))
    expect(flag(near, 'VCC')?.[0]?.position?.x).toBe(40)
    const far = layoutSchematic(ir(sheet({
      components: [...stacked(4), blocker(80, 250), blocker(40, 250)],
    })))
    expect(flag(far, 'VCC')?.[0]?.position?.x).toBe(0)
    const blocked = layoutSchematic(ir(sheet({
      components: [...stacked(4), blocker(80, 250), blocker(40, 250), blocker(0, 250)],
    })))
    // Every VCC lane is occupied: the four pins fall back to their own flags.
    expect(flag(blocked, 'VCC')).toHaveLength(4)
    expect(blocked.sheets[0]?.components.some(component => component.netName === 'VCC' && component.id.includes(':bus:'))).toBe(false)
  })
})

describe('generated wires avoid symbol bodies', () => {
  it('falls back to flags when a trunk would cross a symbol', () => {
    // Both parts sit in one column. u1's pin leaves the body on the right at
    // (280, 200) and u2's on the left at (120, 400); the median trunk would run
    // straight through u1's outline.
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('u1', {
          position: { x: 200, y: 200 },
          pins: [pin('p1', { electric: 'BI', net: 'N', endpoint: { x: 280, y: 200 } })],
        }),
        comp('u2', {
          position: { x: 200, y: 400 },
          pins: [pin('p1', { electric: 'BI', net: 'N', endpoint: { x: 120, y: 400 } })],
        }),
      ],
    })))
    const page = laid.sheets[0] as SchematicIrSheet
    expect(page.wires.some(wire => wire.id === 'layout:wire:N')).toBe(false)
    expect(page.components.filter(component => component.netName === 'N')).toHaveLength(2)
    // The fallback flags stay outside both outlines (x 140..260, y 170..230 and
    // y 370..430, minus the pin stub inset).
    for (const component of page.components.filter(candidate => candidate.netName === 'N')) {
      const { x, y } = component.position ?? { x: -1, y: -1 }
      const inUpper = x > 150 && x < 250 && y > 180 && y < 220
      const inLower = x > 150 && x < 250 && y > 380 && y < 420
      expect(inUpper || inLower).toBe(false)
    }
  })
})

describe('power lane contention and saturated flag fallback', () => {
  const blocker = (id: string, x: number, y: number): SchematicIrComponent =>
    ({ id, kind: 'netflag', netName: 'X', position: { x, y }, pins: [] })

  it('keeps per-pin flags when two power nets share a pin column', () => {
    // Both VCC and GND pins face left at x=120. A bus for either net would cut
    // the other's only lane, so both must stay on per-pin flags.
    const components = Array.from({ length: 3 }, (_, i) => comp(`u${i}`, {
      position: { x: 200, y: 200 + i * 100 },
      pins: [
        pin(`v${i}`, { electric: 'INPUT', net: 'VCC', powerName: 'VCC' }),
        pin(`g${i}`, { electric: 'INPUT', net: 'GND', powerName: 'GND' }),
      ],
    }))
    const laid = layoutSchematic(ir(sheet({ components })))
    const flags = laid.sheets[0]?.components.filter(component => component.kind === 'netflag') ?? []
    expect(flags.filter(component => component.netName === 'VCC')).toHaveLength(3)
    expect(flags.filter(component => component.netName === 'GND')).toHaveLength(3)
    expect(flags.some(component => component.id.includes(':bus:'))).toBe(false)
    const errors = validateSchematic(laid).findings.filter(finding => finding.severity === 'error')
    expect(errors.map(finding => finding.code)).toEqual([])
  })

  it('sits the flag on the pin when every direction is blocked', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('u1', {
          position: { x: 200, y: 250 },
          pins: [pin('p1', { electric: 'POWER_IN', net: 'VCC' })],
        }),
        // Every candidate the power flag would try is occupied by a foreign flag.
        blocker('b1', 120, 290),
        blocker('b2', 120, 210),
        blocker('b3', 80, 290),
        blocker('b4', 80, 210),
        blocker('b5', 80, 250),
        blocker('b6', 160, 250),
      ],
    })))
    const flag = laid.sheets[0]?.components.find(component => component.netName === 'VCC')
    expect(flag?.position).toEqual({ x: 120, y: 250 })
    expect(laid.sheets[0]?.wires.some(wire => wire.net === 'VCC')).toBe(false)
  })

  it('sits the flag on an out-of-frame pin instead of clamping onto a foreign flag', () => {
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('u1', {
          position: { x: 1260, y: 400 },
          pins: [pin('p1', { electric: 'POWER_IN', net: 'VCC' })],
        }),
        blocker('b1', 1170, 440),
        blocker('b2', 1180, 360),
        blocker('b3', 1140, 400),
        blocker('b4', 1220, 400),
      ],
    })))
    const flag = laid.sheets[0]?.components.find(component => component.netName === 'VCC')
    // The clamped coordinate (1170, 440) is exactly b1: taking it would merge
    // VCC with X. The pin itself is the only safe spot left, even though it is
    // out of frame (OBJECT_OUT_OF_SHEET is the honest error).
    expect(flag?.position).toEqual({ x: 1180, y: 400 })
    expect(laid.sheets[0]?.wires.some(wire => wire.net === 'VCC')).toBe(false)
    const codes = validateSchematic(laid).findings.map(finding => finding.code)
    expect(codes).not.toContain('NET_NAME_CONFLICT')
    expect(codes).not.toContain('POWER_SHORT')
    expect(codes).toContain('OBJECT_OUT_OF_SHEET')
  })

  it('keeps a generated trunk off a bus-entry point', () => {
    // Net N runs from (300,200) to (300,600); a straight trunk would pass
    // through the authored bus entry at (300,400), which the validator unions
    // with the bus. The planner must see it as a foreign point and fall back.
    const laid = layoutSchematic(ir(sheet({
      components: [
        comp('u1', { position: { x: 200, y: 200 }, pins: [pin('p1', { electric: 'BI', net: 'N', endpoint: { x: 300, y: 200 } })] }),
        comp('u2', { position: { x: 200, y: 600 }, pins: [pin('p1', { electric: 'BI', net: 'N', endpoint: { x: 300, y: 600 } })] }),
      ],
      busEntries: [{ id: 'be1', busNet: 'BUS[1:2]', order: 0, point: { x: 300, y: 400 } }],
    })))
    expect(laid.sheets[0]?.wires.some(wire => wire.id === 'layout:wire:N')).toBe(false)
    expect(laid.sheets[0]?.components.filter(component => component.netName === 'N')).toHaveLength(2)
    const codes = validateSchematic(laid).findings.map(finding => finding.code)
    expect(codes).not.toContain('NET_NAME_CONFLICT')
  })
})
