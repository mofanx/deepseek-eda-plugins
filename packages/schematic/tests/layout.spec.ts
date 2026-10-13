import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { layoutSchematic } from '@deepseek-ai/dsh-schematic'
import type {
  SchematicIr,
  SchematicIrComponent,
  SchematicIrPin,
  SchematicIrSheet,
} from '@deepseek-ai/dsh-schematic'

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

  it('uses flags for high-fanout nets', () => {
    const members = Array.from({ length: 6 }, (_, index) =>
      comp(`u${index}`, { pins: [pin('p1', { electric: 'INPUT', net: 'WIDE' })] }))
    const laid = layoutSchematic(ir(sheet({ components: members })))
    const flags = laid.sheets[0]?.components.filter(component => component.id.startsWith('layout:flag:'))
    expect(flags?.length).toBe(6)
    expect(laid.sheets[0]?.wires.some(wire => wire.id === 'layout:wire:WIDE')).toBe(false)
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
    const laid = layoutSchematic(ir(sheet({ components: members })), { flagFanout: 3 })
    expect(laid.sheets[0]?.components.filter(component => component.id.startsWith('layout:flag:')).length).toBe(3)
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

describe('golden fixture', () => {
  it('reproduces the committed laid IR for the fixture document', () => {
    const read = (name: string) =>
      JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as SchematicIr
    expect(layoutSchematic(read('layout-input.json'))).toEqual(read('layout-golden.json'))
  })
})
