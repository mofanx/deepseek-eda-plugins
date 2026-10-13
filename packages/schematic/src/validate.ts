/**
 * The static schematic validator — the authoritative delivery gate. Deterministic
 * rules over the typed IR, in-process and keyless: connectivity via a union-find
 * net graph, electrical sanity, device/symbol/footprint binding, and net-naming
 * plus format invariants. Findings carry a stable code, severity, locator, and
 * an actionable message; `error` findings block, `warning` findings report.
 * @module @deepseek-ai/dsh-plugin-eda-sch/validate
 */

import { transformSymbolPoint } from './geometry.ts'
import { SCHEMATIC_LOOKUP_FAILED } from './types.ts'
import type {
  SchematicFinding,
  SchematicIr,
  SchematicIrComponent,
  SchematicIrPin,
  SchematicIrWire,
  SchematicLocator,
  SchematicPoint,
  SchematicValidationOptions,
  SchematicValidationReport,
} from './types.ts'

const DESIGNATOR_RE = /^[A-Z]+\d+$/
/** Declared net names: alphanumeric plus the usual EDA net-name punctuation. */
const NET_NAME_RE = /^[A-Za-z0-9_+\-/#.[\]():~|]+$/
const BUS_NAME_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*\[\d+:\d+\])+$/
const BUS_SEGMENT_RE = /([A-Za-z_][A-Za-z0-9_]*)\[(\d+):(\d+)\]/g

interface Segment {
  a: SchematicPoint
  b: SchematicPoint
}

class UnionFind {
  private parent = new Map<string, string>()

  find(key: string): string {
    let root = this.parent.get(key)
    if (root === undefined) {
      this.parent.set(key, key)
      return key
    }
    while (true) {
      const next = this.parent.get(root)
      if (next === undefined || next === root) break
      root = next
    }
    let node = key
    while (true) {
      const next = this.parent.get(node)
      if (next === undefined || next === root) break
      this.parent.set(node, root)
      node = next
    }
    return root
  }

  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b))
  }
}

const pointKey = (p: SchematicPoint): string => `pt:${p.x},${p.y}`
const flagKey = (name: string): string => `flag:${name}`
const portKey = (name: string): string => `port:${name}`

interface PinRef {
  pin: SchematicIrPin
  component: SchematicIrComponent
  sheetIndex: number
}

/**
 * Expand a bus name like `A[1:5]` or `A[2:3]B[7:6]` into its branch names.
 * Multi-segment names form a cartesian product with the leftmost segment
 * outermost, matching the document-source `order` convention (`A[2:3]B[7:6]`
 * yields `A2B7`, `A2B6`, `A3B7`, `A3B6`).
 * @param name - the declared bus name.
 * @returns the ordered branch list, or `undefined` when the name is not a
 *   well-formed bus name.
 */
export function expandBusName(name: string): string[] | undefined {
  if (!BUS_NAME_RE.test(name)) return undefined
  let branches: string[] = ['']
  for (const segment of name.matchAll(BUS_SEGMENT_RE)) {
    const prefix = segment[1] as string
    const lo = Number(segment[2])
    const hi = Number(segment[3])
    const step = lo <= hi ? 1 : -1
    const next: string[] = []
    for (const base of branches) {
      for (let n = lo; ; n += step) {
        next.push(`${base}${prefix}${n}`)
        if (n === hi) break
      }
    }
    branches = next
  }
  return branches
}

function segmentsOf(wire: SchematicIrWire): Segment[][] {
  const chains: Segment[][] = []
  for (const dots of wire.dots ?? []) {
    const chain: Segment[] = []
    for (let i = 0; i + 3 < dots.length; i += 2) {
      chain.push({
        a: { x: dots[i] as number, y: dots[i + 1] as number },
        b: { x: dots[i + 2] as number, y: dots[i + 3] as number },
      })
    }
    chains.push(chain)
  }
  return chains
}

/** True when `p` lies strictly inside segment `s` (not at an endpoint). */
function onInterior(p: SchematicPoint, s: Segment): boolean {
  const cross = (s.b.x - s.a.x) * (p.y - s.a.y) - (s.b.y - s.a.y) * (p.x - s.a.x)
  if (Math.abs(cross) > 1e-9) return false
  const dot = (p.x - s.a.x) * (s.b.x - s.a.x) + (p.y - s.a.y) * (s.b.y - s.a.y)
  const len = (s.b.x - s.a.x) ** 2 + (s.b.y - s.a.y) ** 2
  return dot > 1e-9 && dot < len - 1e-9
}

/** Default `SCHEMATIC_LAYOUT_MONOLITHIC` trigger: more than this many `part` components on a module-free sheet. */
const MONOLITHIC_COMPONENT_THRESHOLD = 20

/** Proper interior-interior intersection of two segments, or `undefined`. */
function interiorIntersection(s1: Segment, s2: Segment): SchematicPoint | undefined {
  const d1x = s1.b.x - s1.a.x
  const d1y = s1.b.y - s1.a.y
  const d2x = s2.b.x - s2.a.x
  const d2y = s2.b.y - s2.a.y
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) < 1e-12) return undefined
  const t = ((s2.a.x - s1.a.x) * d2y - (s2.a.y - s1.a.y) * d2x) / denom
  const u = ((s2.a.x - s1.a.x) * d1y - (s2.a.y - s1.a.y) * d1x) / denom
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return undefined
  return { x: s1.a.x + t * d1x, y: s1.a.y + t * d1y }
}

/**
 * Validate one IR document through all four rule families.
 * @param ir - the typed schematic IR.
 * @param options - optional library resolver and rule suppressions.
 * @returns the gate report; `ok` is false when any `error` finding exists.
 */
export function validateSchematic(ir: SchematicIr, options: SchematicValidationOptions = {}): SchematicValidationReport {
  const findings: SchematicFinding[] = []
  const disabled = new Set(options.disabledRules ?? [])
  const monolithicThreshold = options.monolithicThreshold ?? MONOLITHIC_COMPONENT_THRESHOLD
  const report = (
    code: string,
    severity: SchematicFinding['severity'],
    message: string,
    locator?: SchematicLocator,
    suggestion?: string,
  ): void => {
    if (!disabled.has(code)) findings.push({ code, severity, message, locator, suggestion })
  }

  const allPins: PinRef[] = []
  const pinsById = new Map<string, PinRef>()
  const componentIds = new Set<string>()
  const wireIds = new Set<string>()
  const busEntryIds = new Set<string>()
  const pinIds = new Set<string>()
  const countId = (ids: Map<string, number>, id: string): void => {
    ids.set(id, (ids.get(id) ?? 0) + 1)
  }
  const dupCheck = (set: Map<string, number>, typeName: string): void => {
    for (const [id, count] of set) {
      if (count > 1) report(
        'FORMAT_DUPLICATE_ID',
        'error',
        `${count} ${typeName} primitives share id "${id}"`,
        { componentId: id },
        'Give every primitive a unique id within its type',
      )
    }
  }
  const groupCheck = (groupId: string | undefined, id: string): void => {
    if (groupId === '0') report('FORMAT_GROUP_ID', 'error', `primitive "${id}" carries groupId "0", which is reserved`, { componentId: id })
  }

  const uf = new UnionFind()
  const segments: Segment[] = []
  // Points that can tap a segment interior: wire polyline endpoints (own chain
  // excluded), pin endpoints, flag/port positions, and bus-entry points.
  const taps: { point: SchematicPoint; skip: Segment[] }[] = []
  const netDecl = new Map<string, Set<string>>()

  for (const [sheetIndex, sheet] of ir.sheets.entries()) {
    const localComponentIds = new Map<string, number>()
    const localWireIds = new Map<string, number>()
    const localBusEntryIds = new Map<string, number>()
    const localAttrIds = new Map<string, number>()
    const localPinIds = new Map<string, number>()

    const partCount = sheet.components.filter(component => component.kind === 'part').length
    const hasModules = (sheet.blocks?.length ?? 0) > 0 || sheet.components.some(component => component.block !== undefined)
    if (partCount > monolithicThreshold && !hasModules) {
      report(
        'SCHEMATIC_LAYOUT_MONOLITHIC',
        'warning',
        `sheet ${sheetIndex + 1} places ${partCount} parts with no module grouping; the layout stays one undifferentiated canvas`,
        { sheetIndex },
        'Declare functional modules: add `blocks` (name + title) on the sheet and set `block` on each part, or split into multiple sheets',
      )
    }

    for (const component of sheet.components) {
      componentIds.add(component.id)
      countId(localComponentIds, component.id)
      groupCheck(component.groupId, component.id)
      if ((component.kind === 'netflag' || component.kind === 'netport') && component.position !== undefined) {
        taps.push({ point: component.position, skip: [] })
      }
      for (const pin of component.pins) {
        pinIds.add(pin.id)
        countId(localPinIds, pin.id)
        groupCheck(pin.groupId, pin.id)
        const ref: PinRef = { pin, component, sheetIndex }
        allPins.push(ref)
        pinsById.set(pin.id, ref)
        if (pin.endpoint !== undefined) {
          uf.union(`pin:${pin.id}`, pointKey(pin.endpoint))
          taps.push({ point: pin.endpoint, skip: [] })
        }
      }
    }
    for (const wire of sheet.wires) {
      wireIds.add(wire.id)
      countId(localWireIds, wire.id)
      groupCheck(wire.groupId, wire.id)
      for (const chain of segmentsOf(wire)) {
        for (const segment of chain) {
          segments.push(segment)
          uf.union(pointKey(segment.a), pointKey(segment.b))
        }
        const first = chain[0]
        const last = chain[chain.length - 1]
        if (first !== undefined) taps.push({ point: first.a, skip: chain })
        if (last !== undefined) taps.push({ point: last.b, skip: chain })
      }
      if (wire.net !== undefined) {
        const firstSeg = segmentsOf(wire).flat()[0]
        const rootKey = firstSeg !== undefined ? uf.find(pointKey(firstSeg.a)) : uf.find(`wire:${wire.id}`)
        const names = netDecl.get(rootKey) ?? new Set<string>()
        names.add(wire.net)
        netDecl.set(rootKey, names)
      }
    }
    for (const entry of sheet.busEntries) {
      busEntryIds.add(entry.id)
      countId(localBusEntryIds, entry.id)
      groupCheck(entry.groupId, entry.id)
      uf.union(`busentry:${entry.id}`, pointKey(entry.point))
      taps.push({ point: entry.point, skip: [] })
      const names = netDecl.get(uf.find(pointKey(entry.point))) ?? new Set<string>()
      names.add(entry.busNet)
      netDecl.set(uf.find(pointKey(entry.point)), names)
    }
    for (const junction of sheet.junctions) {
      uf.find(pointKey(junction.point))
    }
    for (const attr of sheet.attrs) countId(localAttrIds, attr.id)

    dupCheck(localComponentIds, 'COMPONENT')
    dupCheck(localWireIds, 'WIRE/BUS')
    dupCheck(localBusEntryIds, 'BUSENTRY')
    dupCheck(localAttrIds, 'ATTR')
    dupCheck(localPinIds, 'PIN')
  }

  // T-connections: a tap point strictly inside another segment joins that net.
  for (const { point, skip } of taps) {
    for (const segment of segments) {
      if (skip.includes(segment)) continue
      if (onInterior(point, segment)) uf.union(pointKey(point), pointKey(segment.a))
    }
  }

  // NetFlag / NetPort / Short symbols participate by name across all sheets.
  for (const sheet of ir.sheets) {
    for (const component of sheet.components) {
      if (component.kind === 'netflag' && component.netName !== undefined && component.position !== undefined) {
        uf.union(flagKey(component.netName), pointKey(component.position))
        const names = netDecl.get(uf.find(pointKey(component.position))) ?? new Set<string>()
        names.add(component.netName)
        netDecl.set(uf.find(pointKey(component.position)), names)
      } else if (component.kind === 'netport' && component.netName !== undefined && component.position !== undefined) {
        uf.union(portKey(component.netName), pointKey(component.position))
        const names = netDecl.get(uf.find(pointKey(component.position))) ?? new Set<string>()
        names.add(component.netName)
        netDecl.set(uf.find(pointKey(component.position)), names)
      } else if (component.kind === 'short' && component.pins.length === 2) {
        const [first, second] = component.pins
        /* v8 ignore next -- pins.length === 2 guarantees both elements */
        if (first !== undefined && second !== undefined) uf.union(`pin:${first.id}`, `pin:${second.id}`)
      }
    }
  }

  // Re-key declared names after all unions settled.
  const netNames = new Map<string, Set<string>>()
  for (const [key, names] of netDecl) {
    const merged = netNames.get(uf.find(key)) ?? new Set<string>()
    for (const name of names) merged.add(name)
    netNames.set(uf.find(key), merged)
  }

  const netPins = new Map<string, PinRef[]>()
  for (const ref of allPins) {
    const root = uf.find(`pin:${ref.pin.id}`)
    const list = netPins.get(root) ?? []
    list.push(ref)
    netPins.set(root, list)
  }
  const carrierRoots = new Set<string>()
  for (const segment of segments) carrierRoots.add(uf.find(pointKey(segment.a)))

  const netRoots = new Set<string>([...netPins.keys()])
  for (const key of carrierRoots) netRoots.add(key)

  const netLabel = (names: Set<string>): string => (names.size > 0 ? `"${[...names].join('", "')}"` : '(unnamed)')

  const pinLocator = (ref: PinRef): SchematicLocator => ({
    sheetIndex: ref.sheetIndex,
    componentId: ref.component.id,
    designator: ref.component.designator,
    pinId: ref.pin.id,
    pinNumber: ref.pin.number,
  })

  // --- Family: pin connectivity -------------------------------------------------
  for (const ref of allPins) {
    const root = uf.find(`pin:${ref.pin.id}`)
    /* v8 ignore next -- the netPins loop above seeds an entry for every pin root */
    const members = netPins.get(root) ?? []
    const connected = members.length > 1 || carrierRoots.has(root)
    if (!connected) {
      if (ref.pin.electric === 'INPUT') {
        report(
          'FLOATING_INPUT_PIN',
          'error',
          `INPUT pin ${ref.pin.number ?? ref.pin.id} of ${ref.component.designator ?? ref.component.id} connects to no net`,
          pinLocator(ref),
          'Connect the pin to a wire or named net',
        )
      } else if (ref.pin.noConnect !== true) {
        report(
          'FLOATING_PIN',
          'warning',
          `pin ${ref.pin.number ?? ref.pin.id} of ${ref.component.designator ?? ref.component.id} is unconnected`,
          pinLocator(ref),
          'Connect the pin or mark it no-connect',
        )
      }
    }
    if (ref.pin.electric === 'UNKNOWN') {
      report(
        'ELECTRIC_TYPE_UNKNOWN',
        'warning',
        `pin ${ref.pin.number ?? ref.pin.id} of ${ref.component.designator ?? ref.component.id} has electric=UNKNOWN`,
        pinLocator(ref),
        'Resolve the symbol pin electrical type instead of passing through the default',
      )
    }
  }

  for (const root of netRoots) {
    const names = netNames.get(root) ?? new Set<string>()
    const pins = netPins.get(root) ?? []
    if (names.size > 1) {
      report(
        'NET_NAME_CONFLICT',
        'error',
        `net ${netLabel(names)} carries ${names.size} different declared names`,
        { net: [...names].join(' / ') },
        'Use one name per connected graph component',
      )
    }
    const only = pins[0]
    if (names.size === 1 && pins.length === 1 && only !== undefined) {
      report(
        'SINGLE_PIN_NET',
        'warning',
        `named net ${netLabel(names)} drives exactly one pin`,
        { net: [...names][0], pinId: only.pin.id, pinNumber: only.pin.number },
        'A named net should connect at least two pins',
      )
    }
    const outputs = pins.filter(ref => ref.pin.electric === 'OUTPUT')
    const inputs = pins.filter(ref => ref.pin.electric === 'INPUT')
    const powerNames = new Set(pins.map(ref => ref.pin.powerName).filter((name): name is string => name !== undefined))
    const allPower = pins.length > 0 && pins.every(ref => ref.pin.powerName !== undefined)
    if (powerNames.size > 1) {
      report(
        'POWER_SHORT',
        'error',
        `net ${netLabel(names)} shorts power pins ${[...powerNames].join(' and ')}`,
        { net: [...names][0], x: pins[0]?.pin.endpoint?.x, y: pins[0]?.pin.endpoint?.y },
        'Split the net or fix the power-name declarations',
      )
    }
    if (outputs.length >= 2 && !allPower) {
      report(
        'NET_MULTI_DRIVER',
        'error',
        `net ${netLabel(names)} has ${outputs.length} OUTPUT drivers`,
        { net: [...names][0] },
        'Remove the extra drivers or use a shared bus structure',
      )
    }
    if (pins.length >= 2 && inputs.length === pins.length) {
      report(
        'INPUT_NO_DRIVER',
        'warning',
        `net ${netLabel(names)} contains only INPUT pins`,
        { net: [...names][0] },
        'Add a driver (OUTPUT or power pin) to the net',
      )
    }
  }

  // AMBIGUOUS_CROSSING: interior-interior intersections without a junction.
  const junctionKeys = new Set<string>()
  for (const sheet of ir.sheets) {
    for (const junction of sheet.junctions) junctionKeys.add(pointKey(junction.point))
  }
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const crossing = interiorIntersection(segments[i] as Segment, segments[j] as Segment)
      if (crossing === undefined) continue
      if (junctionKeys.has(pointKey(crossing))) continue
      report(
        'AMBIGUOUS_CROSSING',
        'warning',
        `wires cross at (${crossing.x}, ${crossing.y}) without a junction`,
        { x: crossing.x, y: crossing.y },
        'Place an explicit junction or re-route so the crossing cannot be read as connected',
      )
    }
  }

  // --- Family: device, symbol, and footprint matching ----------------------------
  const resolver = options.libraryResolver
  const designatorGroups = new Map<string, SchematicIrComponent[]>()
  for (const [sheetIndex, sheet] of ir.sheets.entries()) {
    for (const component of sheet.components) {
      const physical = component.kind === 'part' || component.kind === 'block'
      if (physical) {
        if (component.designator === undefined || component.designator.length === 0) {
          report(
            'DESIGNATOR_MISSING',
            'error',
            `component "${component.id}" has no designator`,
            { sheetIndex, componentId: component.id },
            'Assign a unique designator like R1 or U3',
          )
        } else {
          if (!DESIGNATOR_RE.test(component.designator)) {
            report(
              'DESIGNATOR_MALFORMED',
              'warning',
              `designator "${component.designator}" does not match the PREFIX+number convention`,
              { sheetIndex, componentId: component.id, designator: component.designator },
              'Use a letter prefix followed by digits',
            )
          }
          const group = designatorGroups.get(component.designator) ?? []
          group.push(component)
          designatorGroups.set(component.designator, group)
        }
        const bindings = [
          ['deviceUuid', component.deviceUuid, component.deviceLibraryUuid, resolver?.resolveDevice?.bind(resolver)] as const,
          ['symbolUuid', component.symbolUuid, component.symbolLibraryUuid, resolver?.resolveSymbol?.bind(resolver)] as const,
          ['footprintUuid', component.footprintUuid, component.footprintLibraryUuid, resolver?.resolveFootprint?.bind(resolver)] as const,
        ]
        const declared = bindings.filter(([, uuid]) => uuid !== undefined)
        if (declared.length === 0) {
          report(
            'BINDING_UNRESOLVED',
            'error',
            component.lcsc === undefined
              ? `component ${component.designator ?? component.id} declares no Device/Symbol/Footprint binding`
              : `component ${component.designator ?? component.id} declares LCSC part "${component.lcsc}" but no resolved Device/Symbol/Footprint binding`,
            { sheetIndex, componentId: component.id, designator: component.designator },
            component.lcsc === undefined
              ? 'Bind the component to a real library device'
              : 'Resolve the LCSC part through a reachable library or bind UUIDs directly',
          )
        } else if (resolver === undefined) {
          report(
            'BINDING_UNRESOLVED',
            options.requireLibrary === true ? 'error' : 'warning',
            `library unreachable: ${declared.length} binding(s) of ${component.designator ?? component.id} are unverified`,
            { sheetIndex, componentId: component.id, designator: component.designator },
            'Provide a library resolver to verify bindings',
          )
        } else {
          for (const [field, uuid, libraryScope, resolve] of declared) {
            if (uuid === undefined || resolve === undefined) continue
            const resolved = resolve(uuid)
            if (resolved === SCHEMATIC_LOOKUP_FAILED) {
              report(
                'BINDING_UNRESOLVED',
                'warning',
                `library lookup failed: ${field} "${uuid}" of ${component.designator ?? component.id} is unverified`,
                { sheetIndex, componentId: component.id, designator: component.designator },
                'Retry once the library answers again',
              )
            } else if (resolved === undefined) {
              // A scoped miss is definitive; a scopeless miss is ambiguous —
              // libraries whose UUID namespaces need scoping (EasyEDA resolves
              // nothing without the owning library) answer `undefined` for
              // entries that exist — so it degrades to an unverifiable warning
              // instead of a blocking error.
              report(
                'BINDING_UNRESOLVED',
                libraryScope === undefined ? 'warning' : 'error',
                libraryScope === undefined
                  ? `${field} "${uuid}" of ${component.designator ?? component.id} is unverifiable without a library scope`
                  : `${field} "${uuid}" of ${component.designator ?? component.id} does not resolve in the workspace library`,
                { sheetIndex, componentId: component.id, designator: component.designator },
                libraryScope === undefined
                  ? 'Add the owning library scope (deviceLibraryUuid/symbolLibraryUuid/footprintLibraryUuid) or rebind through an LCSC part number'
                  : 'Pick an existing library entry',
              )
            }
          }
          if (component.symbolUuid !== undefined && component.position !== undefined) {
            const symbolPins = resolver.resolveSymbolPins?.(component.symbolUuid)
            if (symbolPins !== undefined) {
              const byNumber = new Map(symbolPins.map(symbolPin => [symbolPin.number, symbolPin]))
              for (const pin of component.pins) {
                if (pin.number === undefined || pin.endpoint === undefined) continue
                const symbolPin = byNumber.get(pin.number)
                if (symbolPin === undefined) continue
                const offset = transformSymbolPoint(
                  { x: symbolPin.x, y: symbolPin.y },
                  component.rotation,
                  component.mirror,
                )
                const expectedX = component.position.x + offset.x
                const expectedY = component.position.y + offset.y
                if (pin.endpoint.x !== expectedX || pin.endpoint.y !== expectedY) {
                  report(
                    'WIRE_NOT_ON_PIN',
                    'error',
                    `pin ${pin.id} of ${component.designator ?? component.id} sits at (${pin.endpoint.x}, ${pin.endpoint.y}) but the bound symbol's pin ${pin.number} terminates at (${expectedX}, ${expectedY})`,
                    {
                      sheetIndex, componentId: component.id, designator: component.designator,
                      pinId: pin.id, pinNumber: pin.number, x: pin.endpoint.x, y: pin.endpoint.y,
                    },
                    'Move the pin endpoint (or the component) so the connection lands on the bound symbol pin',
                  )
                }
              }
            }
          }
          if (component.footprintUuid !== undefined) {
            const footprint = resolver.resolveFootprint?.(component.footprintUuid)
            if (footprint !== undefined && footprint !== SCHEMATIC_LOOKUP_FAILED && footprint.pads !== undefined) {
              const pads = new Set(footprint.pads)
              for (const pin of component.pins) {
                if (pin.number !== undefined && !pads.has(pin.number)) {
                  report(
                    'PIN_PAD_MISMATCH',
                    'error',
                    `pin NUMBER "${pin.number}" of ${component.designator ?? component.id} has no pad in the bound footprint`,
                    { sheetIndex, componentId: component.id, designator: component.designator, pinId: pin.id, pinNumber: pin.number },
                    'Use a pin NUMBER that exists in the bound footprint pin-pad map',
                  )
                }
              }
            }
          }
        }
        if (component.addIntoPcb === true && component.footprintUuid === undefined) {
          report(
            'PCB_INTENT_WITHOUT_FOOTPRINT',
            'warning',
            `component ${component.designator ?? component.id} has addIntoPcb without a Footprint binding`,
            { sheetIndex, componentId: component.id, designator: component.designator },
            'Bind a footprint or clear addIntoPcb',
          )
        }
      } else if (component.kind === 'nonelec' && (component.addIntoBom === true || component.addIntoPcb === true)) {
        report(
          'NONELEC_PCB_INTENT',
          'error',
          `NoneElec component "${component.id}" carries BOM/PCB intent`,
          { sheetIndex, componentId: component.id },
          'Clear addIntoBom/addIntoPcb on a non-electrical symbol',
        )
      }
      for (const pin of component.pins) {
        if (pin.name === undefined || pin.number === undefined) {
          report(
            'PIN_ATTR_MISSING',
            'error',
            `pin "${pin.id}" of ${component.designator ?? component.id} is missing ${pin.name === undefined ? 'NAME' : 'NUMBER'}`,
            { sheetIndex, componentId: component.id, designator: component.designator, pinId: pin.id },
            'Every pin needs NAME and NUMBER attributes',
          )
        }
      }
    }
  }
  for (const [designator, group] of designatorGroups) {
    const parts = new Map<string | undefined, number>()
    for (const component of group) parts.set(component.partId, (parts.get(component.partId) ?? 0) + 1)
    for (const [partId, count] of parts) {
      if (count > 1) {
        report(
          'DESIGNATOR_DUPLICATE',
          'error',
          `designator "${designator}" is used by ${count} components${partId === undefined ? '' : ` (partId "${partId}")`}`,
          { designator },
          'Designators must be unique per part',
        )
      }
    }
    const first = group[0]
    for (const other of group.slice(1)) {
      if (
        other.deviceUuid !== first?.deviceUuid
        || other.symbolUuid !== first?.symbolUuid
        || other.footprintUuid !== first?.footprintUuid
      ) {
        report(
          'MULTI_PART_INCONSISTENT',
          'error',
          `multi-part designator "${designator}" binds inconsistent device/symbol/footprint across partIds`,
          { designator, componentId: other.id },
          'All parts of one device share the same bindings',
        )
      }
    }
  }

  // --- Family: net naming and format invariants ----------------------------------
  const checkNetName = (name: string, locator: SchematicLocator): void => {
    if (name.length === 0) {
      report('NET_NAME_EMPTY', 'error', 'a declared net name is empty', locator, 'Declare a non-empty net name')
      return
    }
    if (name !== name.trim()) {
      report(
        'NET_NAME_WHITESPACE',
        'error',
        `net name "${name}" has leading or trailing whitespace`,
        { ...locator, net: name },
        'Trim the net name',
      )
    }
    if (!NET_NAME_RE.test(name)) {
      report(
        'NET_NAME_INVALID',
        'error',
        `net name "${name}" contains characters outside the net-name grammar`,
        { ...locator, net: name },
        'Use letters, digits, and EDA net punctuation only',
      )
    }
    if (name.includes('[') && !BUS_NAME_RE.test(name)) {
      report(
        'BUS_NAME_INVALID',
        'error',
        `bus name "${name}" is not a well-formed PREFIX[a:b] expansion`,
        { ...locator, net: name },
        'Use a form like A[1:5] or A[2:3]B[7:6]',
      )
    }
  }
  for (const [sheetIndex, sheet] of ir.sheets.entries()) {
    for (const wire of sheet.wires) {
      if (wire.net === undefined) {
        report(
          'WIRE_MISSING_NET',
          'error',
          `${wire.kind === 'bus' ? 'BUS' : 'WIRE'} "${wire.id}" carries no NET attribute`,
          { sheetIndex, x: wire.dots?.[0]?.[0], y: wire.dots?.[0]?.[1] },
          'Attach the NET attribute naming the graph component',
        )
      } else {
        checkNetName(wire.net, { sheetIndex })
      }
    }
    for (const entry of sheet.busEntries) {
      checkNetName(entry.busNet, { sheetIndex, x: entry.point.x, y: entry.point.y })
      const branches = expandBusName(entry.busNet)
      if (branches !== undefined && entry.order >= branches.length) {
        report(
          'BUS_ENTRY_ORDER_INVALID',
          'error',
          `BUSENTRY "${entry.id}" order ${entry.order} has no branch in ${entry.busNet} (${branches.length} branches)`,
          { sheetIndex, x: entry.point.x, y: entry.point.y, net: entry.busNet },
          `Use an order below ${branches.length}`,
        )
      }
    }
    for (const component of sheet.components) {
      if ((component.kind === 'netflag' || component.kind === 'netport') && component.netName !== undefined) {
        checkNetName(component.netName, { sheetIndex, componentId: component.id })
      }
      for (const pin of component.pins) {
        if (pin.net !== undefined) {
          checkNetName(pin.net, { sheetIndex, componentId: component.id, pinId: pin.id, pinNumber: pin.number })
        }
      }
    }
    for (const attr of sheet.attrs) {
      const direct = componentIds.has(attr.parentId)
        || wireIds.has(attr.parentId)
        || busEntryIds.has(attr.parentId)
        || pinIds.has(attr.parentId)
      let resolved = direct
      if (!resolved) {
        for (const ref of pinsById.values()) {
          if (attr.parentId === `${ref.component.id}${ref.pin.id}`) {
            resolved = true
            break
          }
        }
      }
      if (!resolved) {
        report(
          'ORPHAN_ATTR',
          'error',
          `ATTR "${attr.id}" (${attr.key}) parentId "${attr.parentId}" resolves to no live primitive`,
          { sheetIndex, componentId: attr.parentId },
          'Point parentId at an existing primitive or a component+pin composite',
        )
      }
    }
  }

  return { ok: findings.every(finding => finding.severity !== 'error'), findings }
}
