import { describe, expect, it } from 'vitest'
import { expandBusName, SCHEMATIC_LOOKUP_FAILED, validateSchematic } from '@deepseek-ai/dsh-plugin-eda-sch'
import type { SchematicIr, SchematicIrComponent, SchematicIrPin, SchematicLibraryResolver } from '@deepseek-ai/dsh-plugin-eda-sch'

const pin = (id: string, electric: SchematicIrPin['electric'], endpoint: { x: number; y: number }, extra: Partial<SchematicIrPin> = {}): SchematicIrPin =>
  ({ id, name: id, number: id.replace(/\D/g, '') || '1', electric, endpoint, ...extra })

const part = (id: string, designator: string, pins: SchematicIrPin[], extra: Partial<SchematicIrComponent> = {}): SchematicIrComponent =>
  ({ id, kind: 'part', designator, position: { x: 0, y: 0 }, deviceUuid: 'dev', symbolUuid: 'sym', footprintUuid: 'fp', pins, ...extra })

const codes = (ir: SchematicIr, options: Parameters<typeof validateSchematic>[1] = {}) =>
  validateSchematic(ir, options).findings.map(f => f.code)

const emptySheet = { components: [], wires: [], busEntries: [], junctions: [], attrs: [] }

/** Two components whose pins join through one wire on net SIG. */
const connected: SchematicIr = {
  sheets: [{
    components: [
      part('c1', 'U1', [pin('p1', 'OUTPUT', { x: 0, y: 0 })]),
      part('c2', 'U2', [pin('p2', 'INPUT', { x: 10, y: 0 })]),
    ],
    wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
    busEntries: [], junctions: [], attrs: [],
  }],
}

describe('pin-connectivity rules', () => {
  it('accepts a wire-connected driver-to-input net', () => {
    const report = validateSchematic(connected)
    expect(report.ok).toBe(true)
    expect(report.findings.filter(f => f.severity === 'error')).toHaveLength(0)
  })

  it('flags FLOATING_INPUT_PIN when an INPUT pin touches nothing', () => {
    const ir: SchematicIr = { sheets: [{ ...emptySheet, components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 })])] }] }
    expect(codes(ir)).toContain('FLOATING_INPUT_PIN')
    expect(validateSchematic(ir).ok).toBe(false)
  })

  it('warns FLOATING_PIN on an unconnected non-INPUT pin but not when noConnect', () => {
    const floating: SchematicIr = { sheets: [{ ...emptySheet, components: [part('c1', 'U1', [pin('p1', 'OUTPUT', { x: 0, y: 0 })])] }] }
    expect(codes(floating)).toContain('FLOATING_PIN')
    const nc: SchematicIr = { sheets: [{ ...emptySheet, components: [part('c1', 'U1', [pin('p1', 'OUTPUT', { x: 0, y: 0 }, { noConnect: true })])] }] }
    expect(codes(nc)).not.toContain('FLOATING_PIN')
  })

  it('joins a pin to a net through a wire endpoint T-connection', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [
          part('c1', 'U1', [pin('p1', 'OUTPUT', { x: 0, y: 0 })]),
          part('c2', 'U2', [pin('p2', 'INPUT', { x: 5, y: 0 })]),
        ],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    expect(codes(ir)).not.toContain('FLOATING_INPUT_PIN')
  })

  it('flags NET_MULTI_DRIVER on two OUTPUT drivers sharing a net', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [
          part('c1', 'U1', [pin('p1', 'OUTPUT', { x: 0, y: 0 })]),
          part('c2', 'U2', [pin('p2', 'OUTPUT', { x: 10, y: 0 })]),
        ],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    expect(codes(ir)).toContain('NET_MULTI_DRIVER')
  })

  it('flags POWER_SHORT when different power names land on one net', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [
          part('c1', 'U1', [pin('p1', 'OUTPUT', { x: 0, y: 0 }, { powerName: 'VCC' })]),
          part('c2', 'U2', [pin('p2', 'OUTPUT', { x: 10, y: 0 }, { powerName: 'GND' })]),
        ],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'PWR' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    expect(codes(ir)).toContain('POWER_SHORT')
  })

  it('flags INPUT_NO_DRIVER when a net has only INPUT pins', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [
          part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 })]),
          part('c2', 'U2', [pin('p2', 'INPUT', { x: 10, y: 0 })]),
        ],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    expect(codes(ir)).toContain('INPUT_NO_DRIVER')
  })

  it('merges nets across sheets by netflag name', () => {
    const flag: SchematicIrComponent = { id: 'f1', kind: 'netflag', netName: 'SIG', position: { x: 0, y: 0 }, pins: [] }
    const ir: SchematicIr = {
      sheets: [
        { components: [flag, part('c1', 'U1', [pin('p1', 'OUTPUT', { x: 0, y: 0 })])], wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 0, 10]], net: 'SIG' }], busEntries: [], junctions: [], attrs: [] },
        { components: [flag, part('c2', 'U2', [pin('p2', 'INPUT', { x: 0, y: 0 })])], wires: [], busEntries: [], junctions: [], attrs: [] },
      ],
    }
    // p2 sits on the flag position of sheet 2's flag? Move p2 onto the flag.
    const moved: SchematicIr = {
      sheets: [ir.sheets[0]!, {
        ...ir.sheets[1]!,
        components: [{ ...flag, id: 'f2' }, part('c2', 'U2', [pin('p2', 'INPUT', { x: 0, y: 0 })])],
      }],
    }
    const report = validateSchematic(moved)
    // flag position (0,0) equals p2 endpoint AND p1's wire endpoint — one net.
    expect(report.findings.filter(f => f.code === 'FLOATING_INPUT_PIN')).toHaveLength(0)
  })

  it('warns AMBIGUOUS_CROSSING on an interior-interior crossing without a junction', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [],
        wires: [
          { id: 'w1', kind: 'wire', dots: [[0, 0, 10, 10]], net: 'A' },
          { id: 'w2', kind: 'wire', dots: [[0, 10, 10, 0]], net: 'B' },
        ],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    expect(codes(ir)).toContain('AMBIGUOUS_CROSSING')
    const withJunction: SchematicIr = { sheets: [{ ...ir.sheets[0]!, junctions: [{ point: { x: 5, y: 5 } }] }] }
    expect(codes(withJunction)).not.toContain('AMBIGUOUS_CROSSING')
  })
})

describe('device/symbol/footprint rules', () => {
  it('flags DESIGNATOR_MISSING on a physical part without one', () => {
    const ir: SchematicIr = { sheets: [{ ...emptySheet, components: [part('c1', '', [pin('p1', 'INPUT', { x: 0, y: 0 })])] }] }
    expect(codes(ir)).toContain('DESIGNATOR_MISSING')
  })

  it('flags DESIGNATOR_DUPLICATE for two parts sharing one designator', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', []), part('c2', 'U1', [])],
      }],
    }
    expect(codes(ir)).toContain('DESIGNATOR_DUPLICATE')
  })

  it('flags BINDING_UNRESOLVED when no binding is declared, and warns when unverified', () => {
    const noBinding: SchematicIr = {
      sheets: [{ ...emptySheet, components: [{ id: 'c1', kind: 'part', designator: 'U1', position: { x: 0, y: 0 }, pins: [] }] }],
    }
    const findings = validateSchematic(noBinding).findings.filter(f => f.code === 'BINDING_UNRESOLVED')
    expect(findings.some(f => f.severity === 'error')).toBe(true)

    const unverified: SchematicIr = {
      sheets: [{ ...emptySheet, components: [part('c1', 'U1', [])] }],
    }
    const warn = validateSchematic(unverified).findings.filter(f => f.code === 'BINDING_UNRESOLVED')
    expect(warn).toHaveLength(1)
    expect(warn[0]!.severity).toBe('warning')
  })

  it('flags BINDING_UNRESOLVED as error when the resolver misses the uuid', () => {
    const ir: SchematicIr = { sheets: [{ ...emptySheet, components: [part('c1', 'U1', [])] }] }
    const resolver = {
      resolveDevice: (uuid: string) => uuid === 'dev' ? {} : undefined,
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({ pads: ['1'] }),
    }
    const findings = validateSchematic(ir, { libraryResolver: resolver }).findings
    expect(findings.filter(f => f.code === 'BINDING_UNRESOLVED')).toHaveLength(0)

    const miss: SchematicIr = { sheets: [{ ...emptySheet, components: [part('c1', 'U1', [], { deviceUuid: 'nope' })] }] }
    expect(codes(miss, { libraryResolver: resolver })).toContain('BINDING_UNRESOLVED')
  })

  it('flags PIN_PAD_MISMATCH for pin numbers missing from the bound footprint', () => {
    const ir: SchematicIr = {
      sheets: [{ ...emptySheet, components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 }, { number: '9' })])] }],
    }
    const resolver = {
      resolveDevice: () => ({}),
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({ pads: ['1', '2'] }),
    }
    expect(codes(ir, { libraryResolver: resolver })).toContain('PIN_PAD_MISMATCH')
  })

  it('flags NONELEC_PCB_INTENT on a nonelec symbol with PCB intent', () => {
    const ir: SchematicIr = {
      sheets: [{ ...emptySheet, components: [{ id: 'g1', kind: 'nonelec', position: { x: 0, y: 0 }, addIntoPcb: true, pins: [] }] }],
    }
    expect(codes(ir)).toContain('NONELEC_PCB_INTENT')
  })

  it('flags PIN_ATTR_MISSING when a pin lacks NAME or NUMBER', () => {
    const ir: SchematicIr = {
      sheets: [{ ...emptySheet, components: [part('c1', 'U1', [{ id: 'p1', electric: 'INPUT', endpoint: { x: 0, y: 0 } }])] }],
    }
    expect(codes(ir)).toContain('PIN_ATTR_MISSING')
  })
})

describe('net-naming and format rules', () => {
  it('flags WIRE_MISSING_NET when a wire carries no net', () => {
    const ir: SchematicIr = {
      sheets: [{ ...emptySheet, wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]] }] }],
    }
    expect(codes(ir)).toContain('WIRE_MISSING_NET')
  })

  it('flags NET_NAME_CONFLICT when one net carries two names', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        wires: [
          { id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'A' },
          { id: 'w2', kind: 'wire', dots: [[10, 0, 20, 0]], net: 'B' },
        ],
      }],
    }
    expect(codes(ir)).toContain('NET_NAME_CONFLICT')
  })

  it('flags NET_NAME_INVALID and NET_NAME_WHITESPACE on bad names', () => {
    const bad: SchematicIr = {
      sheets: [{ ...emptySheet, wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'BAD NAME*' }] }],
    }
    expect(codes(bad)).toEqual(expect.arrayContaining(['NET_NAME_INVALID']))
    const ws: SchematicIr = {
      sheets: [{ ...emptySheet, wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: ' X' }] }],
    }
    expect(codes(ws)).toEqual(expect.arrayContaining(['NET_NAME_WHITESPACE', 'NET_NAME_INVALID']))
  })

  it('flags BUS_NAME_INVALID and BUS_ENTRY_ORDER_INVALID', () => {
    const badBus: SchematicIr = {
      sheets: [{ ...emptySheet, wires: [{ id: 'w1', kind: 'bus', dots: [[0, 0, 10, 0]], net: 'A[' }] }],
    }
    // '[' is a legal net-name character, so only the bus-syntax rule fires.
    expect(codes(badBus)).toEqual(expect.arrayContaining(['BUS_NAME_INVALID']))
    expect(codes(badBus)).not.toContain('NET_NAME_INVALID')
    const badOrder: SchematicIr = {
      sheets: [{ ...emptySheet, busEntries: [{ id: 'b1', busNet: 'A[1:2]', order: 5, point: { x: 0, y: 0 } }] }],
    }
    expect(codes(badOrder)).toContain('BUS_ENTRY_ORDER_INVALID')
  })

  it('flags FORMAT_DUPLICATE_ID and FORMAT_GROUP_ID', () => {
    const dup: SchematicIr = {
      sheets: [{
        ...emptySheet,
        wires: [
          { id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'A' },
          { id: 'w1', kind: 'wire', dots: [[20, 0, 30, 0]], net: 'B' },
        ],
      }],
    }
    expect(codes(dup)).toContain('FORMAT_DUPLICATE_ID')
    const grp: SchematicIr = {
      sheets: [{ ...emptySheet, wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'A', groupId: '0' }] }],
    }
    expect(codes(grp)).toContain('FORMAT_GROUP_ID')
  })

  it('flags ORPHAN_ATTR for an attr whose parentId resolves to nothing', () => {
    const ir: SchematicIr = {
      sheets: [{ ...emptySheet, attrs: [{ id: 'a1', parentId: 'ghost', key: 'X', value: 'y' }] }],
    }
    expect(codes(ir)).toContain('ORPHAN_ATTR')
  })

  it('honours disabledRules suppression', () => {
    const ir: SchematicIr = {
      sheets: [{ ...emptySheet, wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]] }] }],
    }
    expect(codes(ir, { disabledRules: ['WIRE_MISSING_NET'] })).not.toContain('WIRE_MISSING_NET')
  })
})

describe('connectivity edge cases', () => {
  it('unions the two pins of a short component, merging their nets', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [{
          id: 's1', kind: 'short', position: { x: 0, y: 0 },
          pins: [pin('a1', 'OUTPUT', { x: 0, y: 0 }), pin('b2', 'OUTPUT', { x: 10, y: 0 })],
        }],
        wires: [
          { id: 'w1', kind: 'wire', dots: [[0, 0, 0, 10]], net: 'A' },
          { id: 'w2', kind: 'wire', dots: [[10, 0, 10, 10]], net: 'B' },
        ],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    expect(codes(ir)).toContain('NET_NAME_CONFLICT')
  })

  it('does not union a short component that has other than two pins', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [{
          id: 's1', kind: 'short', position: { x: 0, y: 0 },
          pins: [pin('a1', 'OUTPUT', { x: 0, y: 0 })],
        }],
      }],
    }
    expect(codes(ir)).not.toContain('NET_NAME_CONFLICT')
  })

  it('names a point net through a netport tap and flags a single-pin net', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [
          { id: 'np1', kind: 'netport', netName: 'SIG', position: { x: 0, y: 0 }, pins: [] },
          part('c1', 'U1', [pin('p1', 'OUTPUT', { x: 0, y: 0 })]),
        ],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]] }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    const report = validateSchematic(ir)
    expect(report.findings.map(f => f.code)).toEqual(expect.arrayContaining(['SINGLE_PIN_NET', 'WIRE_MISSING_NET']))
    expect(report.findings.map(f => f.code)).not.toContain('FLOATING_PIN')
  })

  it('tolerates netflags and netports without a netName', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [
          { id: 'f1', kind: 'netflag', position: { x: 0, y: 0 }, pins: [] },
          { id: 'np1', kind: 'netport', position: { x: 5, y: 0 }, pins: [] },
        ],
        wires: [], busEntries: [], junctions: [], attrs: [],
      }],
    }
    expect(validateSchematic(ir).ok).toBe(true)
  })

  it('warns INPUT_NO_DRIVER on an unnamed connected net', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [
          part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 })]),
          part('c2', 'U2', [pin('p2', 'INPUT', { x: 10, y: 0 })]),
        ],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]] }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    const report = validateSchematic(ir)
    expect(report.findings.map(f => f.code)).toEqual(expect.arrayContaining(['WIRE_MISSING_NET', 'INPUT_NO_DRIVER']))
    expect(report.findings.find(f => f.code === 'INPUT_NO_DRIVER')?.message).toContain('unnamed')
  })

  it('warns ELECTRIC_TYPE_UNKNOWN on a connected UNKNOWN pin', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [part('c1', 'U1', [pin('p1', 'UNKNOWN', { x: 0, y: 0 })])],
        wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'SIG' }],
        busEntries: [], junctions: [], attrs: [],
      }],
    }
    expect(codes(ir)).toContain('ELECTRIC_TYPE_UNKNOWN')
  })

  it('reports floating pins by id when number and designator are absent', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [{
          id: 'c1', kind: 'part', position: { x: 0, y: 0 }, pins: [{ id: 'p1', electric: 'UNKNOWN', endpoint: { x: 0, y: 0 } }],
        }],
      }],
    }
    const findings = validateSchematic(ir).findings
    expect(findings.find(f => f.code === 'FLOATING_PIN')?.message).toContain('pin p1 of c1')
    expect(findings.find(f => f.code === 'ELECTRIC_TYPE_UNKNOWN')?.message).toContain('pin p1 of c1')
  })

  it('handles wires whose dots carry no segments', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        wires: [
          { id: 'w1', kind: 'wire', dots: [], net: 'X' },
          { id: 'w2', kind: 'wire', dots: [[]], net: 'Y' },
        ],
      }],
    }
    expect(validateSchematic(ir).ok).toBe(true)
  })

  it('does not warn on non-parallel wire pairs that do not cross', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        wires: [
          { id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'A' },
          { id: 'w2', kind: 'wire', dots: [[0, 5, 10, 15]], net: 'B' },
        ],
      }],
    }
    expect(codes(ir)).not.toContain('AMBIGUOUS_CROSSING')
    expect(codes(ir)).not.toContain('NET_NAME_CONFLICT')
  })
})

describe('designator and binding edge cases', () => {
  it('warns DESIGNATOR_MALFORMED on a designator without the PREFIX+digits shape', () => {
    const ir: SchematicIr = {
      sheets: [{ ...emptySheet, components: [part('c1', '1U', [])] }],
    }
    expect(codes(ir)).toContain('DESIGNATOR_MALFORMED')
  })

  it('flags MULTI_PART_INCONSISTENT when partId siblings diverge in bindings', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [
          part('c1', 'U1', [], { partId: 'A', deviceUuid: 'devA' }),
          part('c2', 'U1', [], { partId: 'B', deviceUuid: 'devB' }),
        ],
      }],
    }
    expect(codes(ir)).toContain('MULTI_PART_INCONSISTENT')
  })

  it('accepts multi-part siblings that share identical bindings', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [
          part('c1', 'U1', [], { partId: 'A' }),
          part('c2', 'U1', [], { partId: 'B' }),
        ],
      }],
    }
    expect(codes(ir)).not.toContain('MULTI_PART_INCONSISTENT')
    expect(codes(ir)).not.toContain('DESIGNATOR_DUPLICATE')
  })

  it('names the shared partId in DESIGNATOR_DUPLICATE', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [
          part('c1', 'U1', [], { partId: 'A' }),
          part('c2', 'U1', [], { partId: 'A' }),
        ],
      }],
    }
    const finding = validateSchematic(ir).findings.find(f => f.code === 'DESIGNATOR_DUPLICATE')
    expect(finding?.message).toContain('partId "A"')
  })

  it('locates binding findings by component id when the designator is absent', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [{
          id: 'c1', kind: 'part', position: { x: 0, y: 0 },
          deviceUuid: 'd', symbolUuid: 's', footprintUuid: 'f', pins: [],
        }],
      }],
    }
    const findings = validateSchematic(ir).findings
    expect(findings.map(f => f.code)).toEqual(expect.arrayContaining(['DESIGNATOR_MISSING', 'BINDING_UNRESOLVED']))
  })

  it('locates unresolved bindings by id when the designator is absent', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [{
          id: 'c1', kind: 'part', position: { x: 0, y: 0 }, deviceUuid: 'nope', deviceLibraryUuid: 'lib-1', pins: [],
        }],
      }],
    }
    const resolver = {
      resolveDevice: () => undefined,
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({ pads: ['1'] }),
    }
    const finding = validateSchematic(ir, { libraryResolver: resolver }).findings
      .find(f => f.code === 'BINDING_UNRESOLVED' && f.severity === 'error')
    expect(finding?.message).toContain('"nope" of c1')
  })

  it('degrades a scopeless binding miss to an unverifiable warning', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [], { deviceUuid: 'gone' }), {
          id: 'c2', kind: 'part', position: { x: 0, y: 0 }, deviceUuid: 'gone', pins: [],
        }],
      }],
    }
    const resolver = {
      resolveDevice: () => undefined,
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({ pads: ['1'] }),
    }
    const findings = validateSchematic(ir, { libraryResolver: resolver }).findings
      .filter(f => f.code === 'BINDING_UNRESOLVED')
    expect(findings.every(f => f.severity === 'warning')).toBe(true)
    expect(findings.map(f => f.message).join(' ')).toContain('without a library scope')
    expect(findings.map(f => f.message).join(' ')).toContain('of c2')
  })

  it('resolves partial bindings without requiring a footprint binding', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [], { symbolUuid: undefined, footprintUuid: undefined })],
      }],
    }
    const resolver = {
      resolveDevice: () => ({}),
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({ pads: ['1'] }),
    }
    expect(validateSchematic(ir, { libraryResolver: resolver }).ok).toBe(true)
  })

  it('locates PCB-intent warnings by id when the designator is absent', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [{ id: 'c1', kind: 'part', position: { x: 0, y: 0 }, addIntoPcb: true, pins: [] }],
      }],
    }
    const finding = validateSchematic(ir).findings.find(f => f.code === 'PCB_INTENT_WITHOUT_FOOTPRINT')
    expect(finding?.message).toContain('component c1')
  })

  it('skips pad checks when the footprint uuid fails to resolve', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 })], { footprintUuid: 'gone' })],
      }],
    }
    const resolver = {
      resolveDevice: () => ({}),
      resolveSymbol: () => ({}),
      resolveFootprint: (uuid: string) => uuid === 'gone' ? undefined : { pads: ['1'] },
    }
    const findings = validateSchematic(ir, { libraryResolver: resolver }).findings
    expect(findings.filter(f => f.code === 'BINDING_UNRESOLVED')).toHaveLength(1)
    expect(findings.filter(f => f.code === 'PIN_PAD_MISMATCH')).toHaveLength(0)
  })

  it('skips pad checks on pins without a NUMBER and locates mismatches by id', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [{
          id: 'c1', kind: 'part', position: { x: 0, y: 0 },
          deviceUuid: 'd', footprintUuid: 'f',
          pins: [
            { id: 'p1', name: 'n', electric: 'INPUT', endpoint: { x: 0, y: 0 } },
            { id: 'p2', name: 'm', number: '9', electric: 'INPUT', endpoint: { x: 1, y: 0 } },
          ],
        }],
      }],
    }
    const resolver = {
      resolveDevice: () => ({}),
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({ pads: ['1'] }),
    }
    const finding = validateSchematic(ir, { libraryResolver: resolver }).findings.find(f => f.code === 'PIN_PAD_MISMATCH')
    expect(finding?.message).toContain('c1')
  })

  it('warns PCB_INTENT_WITHOUT_FOOTPRINT on a part with PCB intent but no footprint', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [], { footprintUuid: undefined, addIntoPcb: true })],
      }],
    }
    expect(codes(ir)).toContain('PCB_INTENT_WITHOUT_FOOTPRINT')
  })

  it('escalates the unreachable-library warning to an error under requireLibrary', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [], {})],
      }],
    }
    const finding = validateSchematic(ir, { requireLibrary: true }).findings
      .find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.severity).toBe('error')
  })

  it('reports a lookup-failure sentinel as an unverifiable warning', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [], { symbolUuid: undefined, footprintUuid: undefined })],
      }],
    }
    const resolver = {
      resolveDevice: () => SCHEMATIC_LOOKUP_FAILED,
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({ pads: ['1'] }),
    }
    const finding = validateSchematic(ir, { libraryResolver: resolver }).findings
      .find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.severity).toBe('warning')
    expect(finding?.message).toContain('lookup failed')
  })

  it('treats a footprint sentinel like other sentinel lookups and skips pad checks', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 })], { deviceUuid: undefined, symbolUuid: undefined })],
      }],
    }
    const resolver: SchematicLibraryResolver = {
      resolveDevice: () => ({}),
      resolveSymbol: () => ({}),
      resolveFootprint: () => SCHEMATIC_LOOKUP_FAILED,
    }
    const findings = validateSchematic(ir, { libraryResolver: resolver }).findings
    const binding = findings.find(f => f.code === 'BINDING_UNRESOLVED')
    expect(binding?.severity).toBe('warning')
    expect(findings.filter(f => f.code === 'PIN_PAD_MISMATCH')).toHaveLength(0)
  })

  it('skips pad checks when a resolved footprint carries no pad list', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 })], {})],
      }],
    }
    const resolver = {
      resolveDevice: () => ({}),
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({}),
    }
    const findings = validateSchematic(ir, { libraryResolver: resolver }).findings
    expect(findings.filter(f => f.code === 'BINDING_UNRESOLVED')).toHaveLength(0)
    expect(findings.filter(f => f.code === 'PIN_PAD_MISMATCH')).toHaveLength(0)
  })

  it('locates the lcsc binding error by component id when the designator is absent', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [{
          id: 'c1', kind: 'part', position: { x: 0, y: 0 }, lcsc: 'C77', pins: [],
        }],
      }],
    }
    const finding = validateSchematic(ir).findings.find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.message).toContain('LCSC part "C77"')
    expect(finding?.message).toContain('component c1')
  })

  it('locates the lookup-failure warning by component id when the designator is absent', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [{
          id: 'c1', kind: 'part', position: { x: 0, y: 0 }, deviceUuid: 'd', pins: [],
        }],
      }],
    }
    const resolver = {
      resolveDevice: () => SCHEMATIC_LOOKUP_FAILED,
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({ pads: ['1'] }),
    }
    const finding = validateSchematic(ir, { libraryResolver: resolver }).findings
      .find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.message).toContain('of c1')
  })

  it('skips declared bindings whose resolver method is absent', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [], { deviceUuid: undefined, symbolUuid: undefined })],
      }],
    }
    const partial = {
      resolveDevice: () => ({}),
      resolveSymbol: () => ({}),
    } as SchematicLibraryResolver
    const findings = validateSchematic(ir, { libraryResolver: partial }).findings
    expect(findings.filter(f => f.code === 'BINDING_UNRESOLVED')).toHaveLength(0)
  })

  it('names the lcsc declaration when a part has no resolved binding', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [], { deviceUuid: undefined, symbolUuid: undefined, footprintUuid: undefined, lcsc: 'C25804' })],
      }],
    }
    const finding = validateSchematic(ir).findings.find(f => f.code === 'BINDING_UNRESOLVED')
    expect(finding?.message).toContain('LCSC part "C25804"')
    expect(finding?.suggestion).toContain('reachable library')
  })

  it('flags WIRE_NOT_ON_PIN when an endpoint misses the bound symbol pin', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [{
          id: 'c1', kind: 'part', position: { x: 0, y: 0 },
          deviceUuid: 'dev', symbolUuid: 'sym', footprintUuid: 'fp',
          pins: [pin('p1', 'INPUT', { x: 0, y: 0 })],
        }],
      }],
    }
    const resolver: SchematicLibraryResolver = {
      resolveDevice: () => ({}),
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({ pads: ['1'] }),
      resolveSymbolPins: () => [{ number: '1', x: -60, y: 20 }],
    }
    const finding = validateSchematic(ir, { libraryResolver: resolver }).findings
      .find(f => f.code === 'WIRE_NOT_ON_PIN')
    expect(finding?.severity).toBe('error')
    expect(finding?.message).toContain('of c1')
    expect(finding?.message).toContain('(-60, 20)')
    expect(finding?.locator?.pinId).toBe('p1')
  })

  it('accepts endpoints on the bound symbol pins under rotation and mirror', () => {
    const sym = () => [{ number: '1', x: -60, y: 20 }]
    const resolver: SchematicLibraryResolver = {
      resolveDevice: () => ({}),
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({ pads: ['1'] }),
      resolveSymbolPins: sym,
    }
    const rotated: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 60, y: -20 })], { rotation: 180 })],
      }],
    }
    const mirrored: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 60, y: 20 })], { mirror: true })],
      }],
    }
    for (const doc of [rotated, mirrored]) {
      expect(validateSchematic(doc, { libraryResolver: resolver }).findings
        .filter(f => f.code === 'WIRE_NOT_ON_PIN')).toHaveLength(0)
    }
  })

  it('skips WIRE_NOT_ON_PIN for pins that cannot be located on the symbol', () => {
    const resolver: SchematicLibraryResolver = {
      resolveDevice: () => ({}),
      resolveSymbol: () => ({}),
      resolveFootprint: () => ({ pads: ['1'] }),
      resolveSymbolPins: () => [{ number: '1', x: -60, y: 20 }],
    }
    const noNumber: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 }, { number: undefined })])],
      }],
    }
    const noEndpoint: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 }, { endpoint: undefined })])],
      }],
    }
    const unknownNumber: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 }, { number: '99' })])],
      }],
    }
    const noPosition: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: -60, y: -20 })], { position: undefined })],
      }],
    }
    for (const doc of [noNumber, noEndpoint, unknownNumber, noPosition]) {
      expect(validateSchematic(doc, { libraryResolver: resolver }).findings
        .filter(f => f.code === 'WIRE_NOT_ON_PIN')).toHaveLength(0)
    }
  })
})

describe('net-name and attr edge cases', () => {
  it('flags NET_NAME_EMPTY on an empty wire net and labels a bus wire missing its net', () => {
    const empty: SchematicIr = {
      sheets: [{ ...emptySheet, wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: '' }] }],
    }
    expect(codes(empty)).toContain('NET_NAME_EMPTY')
    const bus: SchematicIr = {
      sheets: [{ ...emptySheet, wires: [{ id: 'w1', kind: 'bus', dots: [[0, 0, 10, 0]] }] }],
    }
    const finding = validateSchematic(bus).findings.find(f => f.code === 'WIRE_MISSING_NET')
    expect(finding?.message).toContain('BUS "w1"')
  })

  it('checks netflag and netport names against the net-name grammar', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [{ id: 'f1', kind: 'netflag', netName: 'BAD NAME*', position: { x: 0, y: 0 }, pins: [] }],
      }],
    }
    expect(codes(ir)).toContain('NET_NAME_INVALID')
  })

  it('skips order checks when the bus entry busNet is not a bus range', () => {
    const ir: SchematicIr = {
      sheets: [{ ...emptySheet, busEntries: [{ id: 'b1', busNet: 'PLAIN', order: 0, point: { x: 0, y: 0 } }] }],
    }
    expect(codes(ir)).not.toContain('BUS_ENTRY_ORDER_INVALID')
  })

  it('resolves composite pin-scoped attr parents', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 })])],
        wires: [], busEntries: [], junctions: [],
        attrs: [{ id: 'a1', parentId: 'c1p1', key: 'X', value: 'y' }],
      }],
    }
    expect(codes(ir)).not.toContain('ORPHAN_ATTR')
  })

  it('resolves direct attr parents and still catches orphans beside real pins', () => {
    const ir: SchematicIr = {
      sheets: [{
        components: [part('c1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 })])],
        wires: [], busEntries: [], junctions: [],
        attrs: [
          { id: 'a1', parentId: 'c1', key: 'X', value: 'y' },
          { id: 'a2', parentId: 'ghost', key: 'X', value: 'y' },
        ],
      }],
    }
    const orphans = validateSchematic(ir).findings.filter(f => f.code === 'ORPHAN_ATTR')
    expect(orphans).toHaveLength(1)
    expect(orphans[0]!.message).toContain('"ghost"')
  })

  it('checks pin-declared net names against the net-name grammar', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [{
          id: 'p1', name: 'A', number: '1', electric: 'INPUT', endpoint: { x: 0, y: 0 }, net: 'BAD NAME*',
        }])],
      }],
    }
    const finding = validateSchematic(ir).findings.find(f => f.code === 'NET_NAME_INVALID')
    expect(finding?.locator?.pinId).toBe('p1')
  })

  it('treats pins without endpoints as unconnected', () => {
    const ir: SchematicIr = {
      sheets: [{
        ...emptySheet,
        components: [part('c1', 'U1', [{ id: 'p1', name: 'A', number: '1', electric: 'INPUT' }])],
      }],
    }
    expect(codes(ir)).toContain('FLOATING_INPUT_PIN')
  })

  it('accepts a named wire without geometry', () => {
    const ir: SchematicIr = {
      sheets: [{ ...emptySheet, wires: [{ id: 'w1', kind: 'wire', net: 'N' }] }],
    }
    expect(codes(ir)).not.toContain('WIRE_MISSING_NET')
  })
})

describe('layout advisories', () => {
  /** A sheet of `count` no-connect parts, optionally assigned to a block. */
  const bigSheet = (count: number, block?: string): SchematicIr => ({
    sheets: [{
      ...emptySheet,
      components: Array.from({ length: count }, (_, index) =>
        part(`c${index}`, `U${index}`, [pin(`p${index}`, 'OUTPUT', { x: index * 10, y: 0 }, { noConnect: true })],
          block === undefined ? {} : { block })),
    }],
  })

  it('warns SCHEMATIC_LAYOUT_MONOLITHIC past the threshold with zero modules', () => {
    const report = validateSchematic(bigSheet(21))
    const finding = report.findings.find(f => f.code === 'SCHEMATIC_LAYOUT_MONOLITHIC')
    expect(finding?.severity).toBe('warning')
    expect(finding?.locator).toEqual({ sheetIndex: 0 })
    expect(finding?.suggestion).toBeDefined()
    expect(report.ok).toBe(true)
  })

  it('stays quiet with component block membership or sheet block declarations', () => {
    expect(codes(bigSheet(21, 'mcu'))).not.toContain('SCHEMATIC_LAYOUT_MONOLITHIC')
    const declared: SchematicIr = {
      sheets: [{ ...bigSheet(21).sheets[0]!, blocks: [{ name: 'mcu', title: 'MCU' }] }],
    }
    expect(codes(declared)).not.toContain('SCHEMATIC_LAYOUT_MONOLITHIC')
  })

  it('stays quiet at or under the threshold and honors overrides', () => {
    expect(codes(bigSheet(20))).not.toContain('SCHEMATIC_LAYOUT_MONOLITHIC')
    expect(codes(bigSheet(5), { monolithicThreshold: 4 })).toContain('SCHEMATIC_LAYOUT_MONOLITHIC')
  })

  it('is suppressible through disabledRules for the repair loop', () => {
    expect(codes(bigSheet(21), { disabledRules: ['SCHEMATIC_LAYOUT_MONOLITHIC'] }))
      .not.toContain('SCHEMATIC_LAYOUT_MONOLITHIC')
  })
})

describe('hierarchy rules', () => {
  /** A `block` component binding a child sheet through its pin nets. */
  const block = (id: string, nets: string[], extra: Partial<SchematicIrComponent> = {}): SchematicIrComponent => ({
    id,
    kind: 'block',
    pins: nets.map((net, index) => pin(`bp${index}`, 'BI', { x: index * 10, y: 0 }, { net, noConnect: true })),
    ...extra,
  })

  const port = (id: string, netName: string, x = 0): SchematicIrComponent => ({
    id,
    kind: 'netport',
    netName,
    position: { x, y: 0 },
    pins: [],
  })

  const hierarchy = (topComponents: SchematicIrComponent[], childComponents: SchematicIrComponent[], childName?: string): SchematicIr => ({
    sheets: [
      { ...emptySheet, components: topComponents },
      { ...emptySheet, name: childName, components: childComponents },
    ],
  })

  it('accepts an explicit sheetIndex whose pin nets echo as child netports', () => {
    const ir = hierarchy(
      [block('b1', ['SIG', 'CLK'], { sheetIndex: 1 })],
      [port('po1', 'SIG'), port('po2', 'CLK', 10)],
    )
    const hierarchyFindings = validateSchematic(ir).findings.filter(f => f.code.startsWith('HIERARCHY_'))
    expect(hierarchyFindings).toHaveLength(0)
  })

  it('flags HIERARCHY_BAD_SHEET_INDEX on out-of-range and self references', () => {
    const far = hierarchy([block('b1', [], { sheetIndex: 5 })], [])
    expect(codes(far)).toContain('HIERARCHY_BAD_SHEET_INDEX')
    expect(validateSchematic(far).ok).toBe(false)
    const self = { sheets: [{ ...emptySheet, components: [block('b1', [], { sheetIndex: 0 })] }] }
    expect(codes(self)).toContain('HIERARCHY_BAD_SHEET_INDEX')
  })

  it('resolves the child implicitly by designator, netName, or id sheet-name match', () => {
    for (const extra of [{ designator: 'POWER' }, { netName: 'POWER' }, {}] as const) {
      const named = extra.designator === undefined && extra.netName === undefined ? 'POWER' : 'b1'
      const ir = hierarchy([block(named, ['SIG'], extra)], [port('po1', 'SIG')], 'POWER')
      const findings = validateSchematic(ir).findings.filter(f => f.code.startsWith('HIERARCHY_'))
      expect(findings).toHaveLength(0)
    }
  })

  it('flags HIERARCHY_AMBIGUOUS_BLOCK when several sheets share the name', () => {
    const ir: SchematicIr = {
      sheets: [
        { ...emptySheet, components: [block('b1', [], { designator: 'POWER' })] },
        { ...emptySheet, name: 'POWER' },
        { ...emptySheet, name: 'POWER' },
      ],
    }
    expect(codes(ir)).toContain('HIERARCHY_AMBIGUOUS_BLOCK')
    expect(validateSchematic(ir).ok).toBe(false)
  })

  it('flags HIERARCHY_UNRESOLVED_BLOCK when no binding mechanism applies', () => {
    const ir = hierarchy([block('b1', [])], [])
    const finding = validateSchematic(ir).findings.find(f => f.code === 'HIERARCHY_UNRESOLVED_BLOCK')
    expect(finding?.severity).toBe('error')
    expect(finding?.suggestion).toBeDefined()
  })

  it('warns HIERARCHY_INTERFACE_MISMATCH in both directions without blocking', () => {
    const ir = hierarchy(
      [block('b1', ['SIG', 'CLK'], { sheetIndex: 1 })],
      [port('po1', 'SIG'), port('po2', 'EXTRA', 10)],
    )
    const report = validateSchematic(ir)
    const mismatches = report.findings.filter(f => f.code === 'HIERARCHY_INTERFACE_MISMATCH')
    expect(mismatches).toHaveLength(2)
    expect(mismatches.every(f => f.severity === 'warning')).toBe(true)
    expect(mismatches[0]?.message).toContain('CLK')
    expect(mismatches[1]?.message).toContain('EXTRA')
    expect(report.ok).toBe(true)
  })

  it('warns HIERARCHY_INDEX_ON_NON_BLOCK when sheetIndex lands on another kind', () => {
    const top = hierarchy([part('u1', 'U1', [pin('p1', 'INPUT', { x: 0, y: 0 }, { net: 'X' })], { sheetIndex: 1 })], [])
    const ir: SchematicIr = {
      sheets: [{ ...top.sheets[0]!, wires: [{ id: 'w1', kind: 'wire', dots: [[0, 0, 10, 0]], net: 'X' }] }, top.sheets[1]!],
    }
    expect(codes(ir)).toContain('HIERARCHY_INDEX_ON_NON_BLOCK')
    expect(validateSchematic(ir).ok).toBe(true)
  })

  it('flags HIERARCHY_CYCLE when blocks form a sheet loop', () => {
    const ir: SchematicIr = {
      sheets: [
        { ...emptySheet, components: [block('ba', [], { sheetIndex: 1 })] },
        { ...emptySheet, components: [block('bb', [], { sheetIndex: 0 })] },
      ],
    }
    expect(codes(ir)).toContain('HIERARCHY_CYCLE')
    expect(validateSchematic(ir).ok).toBe(false)
  })

  it('explores shared descendants without reporting a cycle', () => {
    // Sheets 2 and 3 both expand sheet 4; the diamond has no loop back to 0.
    const ir: SchematicIr = {
      sheets: [
        { ...emptySheet, components: [block('b0', [], { sheetIndex: 1 })] },
        { ...emptySheet, components: [block('b1', [], { sheetIndex: 2 }), block('b2', [], { sheetIndex: 3 })] },
        { ...emptySheet, components: [block('b3', [], { sheetIndex: 4 })] },
        { ...emptySheet, components: [block('b4', [], { sheetIndex: 4 })] },
        { ...emptySheet },
      ],
    }
    expect(codes(ir)).not.toContain('HIERARCHY_CYCLE')
  })

  it('accepts a one-direction nesting chain without a cycle', () => {
    const ir: SchematicIr = {
      sheets: [
        { ...emptySheet, components: [block('ba', [], { sheetIndex: 1 })] },
        { ...emptySheet, components: [block('bb', [], { sheetIndex: 2 })] },
        { ...emptySheet },
      ],
    }
    expect(validateSchematic(ir).findings.filter(f => f.code.startsWith('HIERARCHY_'))).toHaveLength(0)
  })
})

describe('expandBusName', () => {
  it('expands single and multi-range bus names', () => {
    expect(expandBusName('A[1:3]')).toEqual(['A1', 'A2', 'A3'])
    expect(expandBusName('A[3:1]')).toEqual(['A3', 'A2', 'A1'])
    expect(expandBusName('A[1:2]B[5:6]')).toEqual(['A1B5', 'A1B6', 'A2B5', 'A2B6'])
  })

  it('returns undefined for non-bus names', () => {
    expect(expandBusName('SIG')).toBeUndefined()
    expect(expandBusName('A[')).toBeUndefined()
  })
})
