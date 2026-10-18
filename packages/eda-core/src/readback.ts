/**
 * Read-back document-source parsing and structural netlist diff. The persisted
 * schema carries no pin records, so connectivity is reconstructed from wire
 * `LINE` geometry, `NET` attributes, and flag components (`Global Net Name` /
 * `Name`), then diffed against the pin→net expectations derivable from the IR.
 * Persisted source coordinates negate the client's bottom-left, Y-up API
 * space, so the diff maps every IR point through `y - pageHeight`; they are
 * not a plain `-y` mirror.
 * @module @deepseek-ai/dsh-plugin-eda-easyeda/readback
 */

import { SCHEMATIC_PAGE_A4 } from '@deepseek-ai/dsh-plugin-eda-sch'
import type { SchematicFinding, SchematicIrSheet, SchematicLocator, SchematicPageSize, SchematicSymbolPin } from '@deepseek-ai/dsh-plugin-eda-sch'
import { transformSymbolPoint } from '@deepseek-ai/dsh-plugin-eda-sch'

/** One `head||body|` record of a persisted document source. */
export interface ParsedRecord {
  type: string
  /** Record id from the head object (`COMPONENT`/`WIRE`/`ATTR` carry it there). */
  id?: string | undefined
  inner: Record<string, unknown> | string
}

/**
 * Parse `||`-joined document-source lines into typed records. Malformed lines
 * are skipped — a partial parse is not evidence either way.
 * @param source - the document source text.
 * @returns one record per parseable line.
 */
export function parseDocumentSource(source: string): ParsedRecord[] {
  const records: ParsedRecord[] = []
  for (const line of source.split('\n')) {
    if (line.trim().length === 0) continue
    const sep = line.indexOf('||')
    if (sep < 0) continue
    let inner = line.slice(sep + 2)
    if (inner.endsWith('|')) inner = inner.slice(0, -1)
    try {
      const head = JSON.parse(line.slice(0, sep)) as { type: string; id?: unknown }
      records.push({
        type: head.type,
        ...typeof head.id === 'string' ? { id: head.id } : {},
        inner: JSON.parse(inner) as ParsedRecord['inner'],
      })
    } catch {
      // A malformed line is not evidence either way; skip it.
    }
  }
  return records
}

/**
 * Collect every ATTR value of a read-back document, keyed by ATTR key.
 * @param records - parsed document-source records.
 * @returns key → ordered values across the document.
 */
export function readBackAttrs(records: ParsedRecord[]): Map<string, string[]> {
  const attrs = new Map<string, string[]>()
  for (const record of records) {
    if (record.type !== 'ATTR' || typeof record.inner !== 'object') continue
    const inner = record.inner as { key?: unknown; value?: unknown }
    if (typeof inner.key !== 'string' || typeof inner.value !== 'string') continue
    const values = attrs.get(inner.key) ?? []
    values.push(inner.value)
    attrs.set(inner.key, values)
  }
  return attrs
}

const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const asNumber = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined

type Segment = readonly [number, number, number, number]

interface Point {
  x: number
  y: number
}

/** A connectivity node: one wire polyline or one flag attach point. */
interface NetNode {
  /** Record id when the node is a wire (LINE records key off it). */
  id?: string | undefined
  names: string[]
  segments: Segment[]
  point?: Point
}

const onSegment = (p: Point, [x1, y1, x2, y2]: Segment): boolean => {
  if (x1 === x2 && y1 === y2) return p.x === x1 && p.y === y1
  const cross = (x2 - x1) * (p.y - y1) - (y2 - y1) * (p.x - x1)
  if (Math.abs(cross) > 1e-9) return false
  return (p.x - x1) * (x2 - x1) + (p.y - y1) * (y2 - y1) >= -1e-9
    && (p.x - x2) * (x1 - x2) + (p.y - y2) * (y1 - y2) >= -1e-9
}

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

/** Whether two segments touch or cross, endpoint contact included. */
const segmentsTouch = (a: Segment, b: Segment): boolean => {
  if (onSegment({ x: a[0], y: a[1] }, b) || onSegment({ x: a[2], y: a[3] }, b)
    || onSegment({ x: b[0], y: b[1] }, a) || onSegment({ x: b[2], y: b[3] }, a)) return true
  const d1 = orient(b[0], b[1], b[2], b[3], a[0], a[1])
  const d2 = orient(b[0], b[1], b[2], b[3], a[2], a[3])
  const d3 = orient(a[0], a[1], a[2], a[3], b[0], b[1])
  const d4 = orient(a[0], a[1], a[2], a[3], b[2], b[3])
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

const nodeTouches = (a: NetNode, b: NetNode): boolean => {
  // Two flag attach points at one coordinate short their nets the same way a
  // wire endpoint touching a segment does — without this the read-back misses
  // a collision the validator's point graph already reports as merged.
  if (a.point !== undefined && b.point !== undefined && a.point.x === b.point.x && a.point.y === b.point.y) return true
  if (a.point !== undefined && b.segments.some(segment => onSegment(a.point as Point, segment))) return true
  if (b.point !== undefined && a.segments.some(segment => onSegment(b.point as Point, segment))) return true
  return a.segments.some(sa => b.segments.some(sb => segmentsTouch(sa, sb)))
}

/**
 * One electrical region of a document: the union of wire polylines and flag
 * attach points that touch each other, with every net name declared inside.
 */
interface NetRegion {
  names: Set<string>
  nodes: NetNode[]
}

/** Union the nodes into electrical regions by geometric contact. */
function regionsOf(nodes: NetNode[]): NetRegion[] {
  const parent = nodes.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root] as number
    return root
  }
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (nodeTouches(nodes[i] as NetNode, nodes[j] as NetNode)) {
        parent[find(j)] = find(i)
      }
    }
  }
  const regions = new Map<number, NetRegion>()
  for (const [index, node] of nodes.entries()) {
    const root = find(index)
    const region = regions.get(root) ?? { names: new Set(), nodes: [] }
    for (const name of node.names) region.names.add(name)
    region.nodes.push(node)
    regions.set(root, region)
  }
  return [...regions.values()]
}

const pointOnNode = (point: Point, node: NetNode): boolean =>
  (node.point !== undefined && node.point.x === point.x && node.point.y === point.y)
  || node.segments.some(segment => onSegment(point, segment))

const namesAt = (point: Point, regions: readonly NetRegion[]): Set<string> => {
  const names = new Set<string>()
  for (const region of regions) {
    if (region.nodes.some(node => pointOnNode(point, node))) {
      for (const name of region.names) names.add(name)
    }
  }
  return names
}

/**
 * The net name a flag component declares: `Global Net Name` when present, else
 * a plain `Name` on a symbol with no `Designator` (formula names like
 * `={Manufacturer Part}` and real parts never qualify).
 * @param attrs - the component's ATTR values keyed by key.
 * @returns the declared net name, or undefined when the component is not a flag.
 */
function flagName(attrs: Map<string, string[]>): string | undefined {
  const global = attrs.get('Global Net Name')?.[0]
  if (global !== undefined) return global
  const name = attrs.get('Name')?.[0]
  if (name === undefined || name === '' || name.startsWith('=')) return undefined
  if (attrs.get('Designator') !== undefined) return undefined
  return name
}

/** Index every ATTR value by its parent record id and key. */
function attrsByParent(records: readonly ParsedRecord[]): Map<string, Map<string, string[]>> {
  const byParent = new Map<string, Map<string, string[]>>()
  for (const record of records) {
    if (record.type !== 'ATTR' || typeof record.inner !== 'object') continue
    const inner = record.inner as { key?: unknown; value?: unknown; parentId?: unknown }
    const key = asString(inner.key)
    const value = asString(inner.value)
    const parentId = asString(inner.parentId)
    if (key === undefined || value === undefined || parentId === undefined) continue
    const perKey = byParent.get(parentId) ?? new Map<string, string[]>()
    const values = perKey.get(key) ?? []
    values.push(value)
    perKey.set(key, values)
    byParent.set(parentId, perKey)
  }
  return byParent
}

/**
 * Reconstruct the net regions of one persisted `SCH_PAGE` source: WIRE/BUS
 * records supply polylines and `NET` names; flag components supply attach
 * points and names. Regions merge wherever geometry touches.
 * @param source - the persisted document source text.
 * @returns every electrical region found.
 */
export function readBackNetRegions(source: string): NetRegion[] {
  const records = parseDocumentSource(source)
  const byParent = attrsByParent(records)
  const wires = new Map<string, NetNode>()
  const nodes: NetNode[] = []
  for (const record of records) {
    if (typeof record.inner !== 'object') continue
    if (record.type === 'WIRE' || record.type === 'BUS') {
      const node: NetNode = { id: record.id, names: [...(byParent.get(record.id ?? '')?.get('NET') ?? [])], segments: [] }
      nodes.push(node)
      if (record.id !== undefined) wires.set(record.id, node)
      continue
    }
    if (record.type === 'LINE') {
      const inner = record.inner
      const [x1, y1, x2, y2] = [inner.startX, inner.startY, inner.endX, inner.endY].map(asNumber)
      const group = asString(inner.lineGroup)
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined || group === undefined) continue
      wires.get(group)?.segments.push([x1, y1, x2, y2])
      continue
    }
    if (record.type === 'COMPONENT') {
      const inner = record.inner
      const x = asNumber(inner.x)
      const y = asNumber(inner.y)
      const name = flagName(byParent.get(record.id ?? '') ?? new Map<string, string[]>())
      if (x === undefined || y === undefined || name === undefined) continue
      nodes.push({ names: [name], segments: [], point: { x, y } })
    }
  }
  return regionsOf(nodes)
}

/** IR-side net regions of one sheet, projected into persisted space by `projectY`. */
function irNetRegions(sheet: SchematicIrSheet, projectY: (y: number) => number): NetRegion[] {
  const nodes: NetNode[] = []
  for (const wire of sheet.wires) {
    const segments: Segment[] = []
    for (const dots of wire.dots ?? []) {
      for (let i = 0; i + 3 < dots.length; i += 2) {
        segments.push([dots[i] as number, projectY(dots[i + 1] as number), dots[i + 2] as number, projectY(dots[i + 3] as number)])
      }
    }
    nodes.push({ id: wire.id, names: wire.net === undefined ? [] : [wire.net], segments })
  }
  for (const component of sheet.components) {
    if ((component.kind !== 'netflag' && component.kind !== 'netport') || component.netName === undefined || component.position === undefined) continue
    nodes.push({ names: [component.netName], segments: [], point: { x: component.position.x, y: projectY(component.position.y) } })
  }
  return regionsOf(nodes)
}

const joinNames = (names: ReadonlySet<string>): string => [...names].sort().join('/')

/**
 * Structurally diff one IR sheet against its read-back document source. For
 * every pin the IR expects on a named net (its `pin.net` declaration plus any
 * wire/flag naming its endpoint), the read-back must place the point on a
 * region carrying the same name — a point on nothing reports
 * `SCHEMATIC_NETLIST_DROPPED`, a point on a differently named region reports
 * `SCHEMATIC_NETLIST_WRONG_NET`, and any read-back region carrying two
 * distinct names reports `SCHEMATIC_NETLIST_MERGED`. Diffs are `error` findings
 * so the verify-repair loop treats them like gate failures.
 *
 * The IR/read-back comparison alone is self-consistent — it projects both
 * sides into the same space, so an endpoint that misses its real symbol pin
 * (e.g. laid out on the y-mirrored offset) still finds its own wire and
 * reports clean. When `symbolPins` carries the bound symbol's library
 * geometry, each pin endpoint must equal `position + transform(pin)` — a
 * `WIRE_NOT_ON_PIN` error — or a wire on the mirrored sibling's spot stays
 * invisible to every name-level check.
 * @param sheet - the IR sheet the source was generated from.
 * @param source - the persisted document source read back from the client.
 * @param sheetIndex - sheet position, for finding locators.
 * @param symbolPins - pin geometry per bound symbol UUID (the `symbolPins`
 * snapshot from `resolveBindings`), in sheet space.
 * @param pageSize - delivered page size for imported `.epru` pages; ignored when `ySign` is `-1`.
 * @param ySign - `1` for persisted `y - pageHeight` (imported pages) or `-1` for
 * the primitive API's `-y` mirror.
 * @returns one finding per detected diff; empty when the netlists agree.
 */
export function diffNetlists(
  sheet: SchematicIrSheet,
  source: string,
  sheetIndex: number,
  symbolPins?: ReadonlyMap<string, readonly SchematicSymbolPin[]>,
  pageSize?: SchematicPageSize,
  ySign: 1 | -1 = 1,
): SchematicFinding[] {
  const findings: SchematicFinding[] = []
  const observed = readBackNetRegions(source)
  const pageHeight = (pageSize ?? SCHEMATIC_PAGE_A4).height
  const projectY = ySign === 1 ? (y: number): number => y - pageHeight : (y: number): number => -y
  const expected = irNetRegions(sheet, projectY)
  for (const region of observed) {
    if (region.names.size > 1) {
      findings.push({
        code: 'SCHEMATIC_NETLIST_MERGED',
        severity: 'error',
        message: `read-back merges nets ${joinNames(region.names)} into one electrical region`,
        locator: { sheetIndex, net: joinNames(region.names) },
        suggestion: 'separate the wire polylines or flags that touch across net names',
      })
    }
  }
  const pinsBySymbol = new Map<string, Map<string, SchematicSymbolPin>>()
  if (symbolPins !== undefined) {
    for (const [uuid, pins] of symbolPins) {
      pinsBySymbol.set(uuid, new Map(pins.map(pin => [pin.number, pin])))
    }
  }
  for (const component of sheet.components) {
    for (const pin of component.pins) {
      if (pin.endpoint === undefined) continue
      if (component.symbolUuid !== undefined && component.position !== undefined && pin.number !== undefined) {
        const symbolPin = pinsBySymbol.get(component.symbolUuid)?.get(pin.number)
        if (symbolPin !== undefined) {
          const offset = transformSymbolPoint({ x: symbolPin.x, y: symbolPin.y }, component.rotation, component.mirror)
          const expectedX = component.position.x + offset.x
          const expectedY = component.position.y + offset.y
          if (pin.endpoint.x !== expectedX || pin.endpoint.y !== expectedY) {
            findings.push({
              code: 'WIRE_NOT_ON_PIN',
              severity: 'error',
              message: `pin ${pin.id} of ${component.designator ?? component.id} terminates at (${pin.endpoint.x}, ${pin.endpoint.y}) but the bound symbol's pin ${pin.number} sits at (${expectedX}, ${expectedY}) — the wire lands off the pin`,
              locator: {
                sheetIndex, componentId: component.id, designator: component.designator,
                pinId: pin.id, pinNumber: pin.number, x: pin.endpoint.x, y: pin.endpoint.y,
              },
              suggestion: 'move the wire endpoint (or the component) onto the bound symbol pin position',
            })
            continue
          }
        }
      }
      const point = { x: pin.endpoint.x, y: projectY(pin.endpoint.y) }
      const want = namesAt(point, expected)
      if (pin.net !== undefined) want.add(pin.net)
      if (want.size === 0) continue
      const locator: SchematicLocator = {
        sheetIndex,
        componentId: component.id,
        designator: component.designator,
        pinId: pin.id,
        pinNumber: pin.number,
        net: joinNames(want),
        x: pin.endpoint.x,
        y: pin.endpoint.y,
      }
      const got = namesAt(point, observed)
      if (got.size === 0) {
        findings.push({
          code: 'SCHEMATIC_NETLIST_DROPPED',
          severity: 'error',
          message: `pin ${component.id}:${pin.id} expected on net ${joinNames(want)} has no geometry at (${point.x},${point.y}) in the read-back`,
          locator,
          suggestion: 're-emit the wire or flag that carries this net',
        })
        continue
      }
      const overlap = [...want].some(name => got.has(name))
      if (!overlap) {
        findings.push({
          code: 'SCHEMATIC_NETLIST_WRONG_NET',
          severity: 'error',
          message: `pin ${component.id}:${pin.id} expected on net ${joinNames(want)} but the read-back places it on ${joinNames(got)}`,
          locator,
          suggestion: 'check that wire geometry and flag names carry the intended net',
        })
      }
    }
  }
  return findings
}
