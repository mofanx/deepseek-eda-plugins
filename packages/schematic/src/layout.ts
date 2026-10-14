/**
 * Deterministic layout stage for the schematic IR. `layoutSchematic` fills the
 * geometry the model leaves out: grid-aligned component placement in layered
 * zones, pin endpoints derived from each pin's electrical side, and net
 * routing that chooses between an orthogonal wire trunk and net flags
 * (`pin.net` is the logical connectivity declaration). Explicit geometry
 * (positions, pin endpoints, wire polylines) passes through untouched, so a
 * fully specified document returns unchanged and the pass is idempotent; the
 * one exception is a pin endpoint within one grid step of its bound symbol's
 * real pin, which snaps onto the true endpoint when `symbolPins` geometry is
 * supplied.
 * @module @deepseek-ai/dsh-plugin-eda-sch/layout
 */

import { transformSymbolPoint } from './geometry.ts'
import { SCHEMATIC_PAGE_A4 } from './types.ts'
import type {
  SchematicIr,
  SchematicIrComponent,
  SchematicIrJunction,
  SchematicIrPin,
  SchematicIrSheet,
  SchematicIrWire,
  SchematicLayoutOptions,
  SchematicPageSize,
  SchematicPoint,
  SchematicSymbolPin,
} from './types.ts'

const DEFAULT_GRID = 10
const DEFAULT_COLUMN_PITCH = 400
const DEFAULT_ROW_GAP = 60
const DEFAULT_MARGIN: SchematicPoint = { x: 200, y: 200 }
const DEFAULT_PIN_PITCH = 20
const DEFAULT_PIN_STUB = 20
const DEFAULT_FLAG_FANOUT = 6
/** Stub length from a pin endpoint to a generated net flag. */
const FLAG_STUB = 40
/** Horizontal gap between the main zone and the annotation margin. */
const ANNOTATION_GAP = 120
/** Gap between functional-module cells in the placement grid. */
const MODULE_GAP = 200
/**
 * Body half-width for the placement outline; the library APIs expose no
 * symbol geometry, so occupancy derives from the declared pin counts.
 */
const BODY_HALF_WIDTH = 60
/** Vertical padding above the outermost pin row inside the outline. */
const BODY_HALF_PADDING = 20
/**
 * Edge allowance inside the page frame for sheets carrying module frames —
 * covers the pin stub + flag stub plus the frame padding and title headroom
 * the serializer adds around module members.
 */
const PAGE_EDGE_FRAMED = 150
/** Edge allowance for flat sheets: pin stub plus generated flag stub. */
const PAGE_EDGE_FLAT = 80
/**
 * Spacing compression ladder applied to module gap / column pitch / row gap
 * when the module grid overflows the page; each level retries the single-page
 * pack before layout falls back to pagination.
 */
const SPACING_SCALES = [1, 0.6, 0.3]
/** Compression floors: below these, bodies/pin stubs would overlap. */
const MIN_COLUMN_PITCH = 160
const MIN_ROW_GAP = 30
const MIN_MODULE_GAP = 60
const MIN_PIN_PITCH = 10

const GROUND_NET_RE = /^(GND|AGND|DGND|PGND|GNDA|VSS|GROUND)/i
const POWER_NET_RE = /^(\+?\d+V|VCC|VDD|VBAT|VBUS|VIN|VOUT|\+)/i
const ANNOTATION_KINDS = new Set(['netflag', 'netport', 'nonelec'])
const FLAG_KINDS = new Set(['netflag', 'netport'])

interface ResolvedLayoutOptions {
  grid: number
  columnPitch: number
  rowGap: number
  margin: SchematicPoint
  pinPitch: number
  pinStub: number
  flagFanout: number
  moduleColumns: number | undefined
  symbolPins: ReadonlyMap<string, readonly SchematicSymbolPin[]>
  pageSize: SchematicPageSize
  /** Effective module gap after spacing compression. */
  moduleGap: number
}

function resolveOptions(options: SchematicLayoutOptions): ResolvedLayoutOptions {
  return {
    grid: options.grid ?? DEFAULT_GRID,
    columnPitch: options.columnPitch ?? DEFAULT_COLUMN_PITCH,
    rowGap: options.rowGap ?? DEFAULT_ROW_GAP,
    margin: options.margin ?? DEFAULT_MARGIN,
    pinPitch: options.pinPitch ?? DEFAULT_PIN_PITCH,
    pinStub: options.pinStub ?? DEFAULT_PIN_STUB,
    flagFanout: options.flagFanout ?? DEFAULT_FLAG_FANOUT,
    moduleColumns: options.moduleColumns,
    symbolPins: options.symbolPins ?? new Map(),
    pageSize: options.pageSize ?? SCHEMATIC_PAGE_A4,
    moduleGap: MODULE_GAP,
  }
}

/**
 * Apply one rung of the spacing-compression ladder: module gap, column pitch,
 * and row gap shrink toward their floors so a slightly oversized module grid
 * still fits the page without splitting sheets.
 */
function compressSpacing(o: ResolvedLayoutOptions, scale: number): ResolvedLayoutOptions {
  if (scale === 1) return o
  return {
    ...o,
    columnPitch: Math.max(MIN_COLUMN_PITCH, o.columnPitch * scale),
    rowGap: Math.max(MIN_ROW_GAP, o.rowGap * scale),
    moduleGap: Math.max(MIN_MODULE_GAP, o.moduleGap * scale),
    pinPitch: Math.max(MIN_PIN_PITCH, o.pinPitch * scale),
  }
}

const snap = (value: number, grid: number): number => Math.round(value / grid) * grid

const componentKey = (component: SchematicIrComponent): string => component.designator ?? component.id

/** Sanitize a net name for use inside generated primitive ids. */
const idPart = (net: string): string => net.replaceAll(/[^A-Za-z0-9_]+/g, '_')

type PinSide = 'left' | 'right'

/**
 * Assign each pin a symbol side: INPUT pins go left, OUTPUT pins right, and
 * BI/UNKNOWN pins balance the shorter side (left first on ties).
 */
function pinSides(pins: readonly SchematicIrPin[]): PinSide[] {
  let lefts = 0
  let rights = 0
  for (const pin of pins) {
    if (pin.electric === 'INPUT') lefts += 1
    if (pin.electric === 'OUTPUT') rights += 1
  }
  return pins.map((pin) => {
    if (pin.electric === 'INPUT') return 'left'
    if (pin.electric === 'OUTPUT') return 'right'
    const side: PinSide = lefts <= rights ? 'left' : 'right'
    if (side === 'left') lefts += 1
    else rights += 1
    return side
  })
}

interface PlacedPin extends SchematicIrPin {
  readonly endpoint: SchematicPoint
}

interface LaidComponent {
  readonly source: SchematicIrComponent
  readonly position: SchematicPoint
  readonly pins: readonly PlacedPin[]
  readonly sides: readonly PinSide[]
}

/**
 * Order main-zone components into signal-flow columns: an edge runs from every
 * OUTPUT pin's component to every INPUT pin's component on the same declared
 * net. Layer assignment is longest-path layering with a deterministic cycle
 * fallback (lowest key first); components without drivers land in layer 0.
 */
function layerOf(components: readonly SchematicIrComponent[]): Map<string, number> {
  const preds = new Map<string, Set<string>>()
  for (const component of components) preds.set(component.id, new Set())
  const membersByNet = new Map<string, { outputs: string[]; inputs: string[] }>()
  for (const component of components) {
    for (const pin of component.pins) {
      if (pin.net === undefined) continue
      const group = membersByNet.get(pin.net) ?? { outputs: [], inputs: [] }
      if (pin.electric === 'OUTPUT') group.outputs.push(component.id)
      if (pin.electric === 'INPUT') group.inputs.push(component.id)
      membersByNet.set(pin.net, group)
    }
  }
  for (const group of membersByNet.values()) {
    for (const output of group.outputs) {
      for (const input of group.inputs) {
        if (output !== input) (preds.get(input) as Set<string>).add(output)
      }
    }
  }
  const layers = new Map<string, number>()
  const keyOf = new Map(components.map(component => [component.id, componentKey(component)]))
  while (layers.size < components.length) {
    let assigned = false
    for (const component of components) {
      if (layers.has(component.id)) continue
      let ready = true
      let layer = 0
      for (const dep of preds.get(component.id) as Set<string>) {
        const depLayer = layers.get(dep)
        if (depLayer === undefined) {
          ready = false
          break
        }
        layer = Math.max(layer, depLayer + 1)
      }
      if (ready) {
        layers.set(component.id, layer)
        assigned = true
      }
    }
    if (!assigned) {
      // Cycle fallback: place the lowest-key remaining component one layer
      // past every assigned node so feedback loops never deadlock.
      const rest = components
        .filter(component => !layers.has(component.id))
        .sort((a, b) => (keyOf.get(a.id) as string).localeCompare(keyOf.get(b.id) as string))[0] as SchematicIrComponent
      layers.set(rest.id, Math.max(-1, ...layers.values()) + 1)
    }
  }
  return layers
}

/** Point-in-segment check inclusive of the endpoints (laid wires use exact grid coordinates). */
function onSegment(p: SchematicPoint, x1: number, y1: number, x2: number, y2: number): boolean {
  if (x1 === x2 && y1 === y2) return p.x === x1 && p.y === y1
  const cross = (x2 - x1) * (p.y - y1) - (y2 - y1) * (p.x - x1)
  if (Math.abs(cross) > 1e-9) return false
  return (p.x - x1) * (x2 - x1) + (p.y - y1) * (y2 - y1) >= -1e-9
    && (p.x - x2) * (x1 - x2) + (p.y - y2) * (y1 - y2) >= -1e-9
}

/** Whether `p` lies on any polyline of `wire` (vertex or interior). */
function onWire(p: SchematicPoint, wire: SchematicIrWire): boolean {
  for (const dots of wire.dots ?? []) {
    for (let i = 0; i + 3 < dots.length; i += 2) {
      if (onSegment(p, dots[i] as number, dots[i + 1] as number, dots[i + 2] as number, dots[i + 3] as number)) return true
    }
  }
  return false
}

const isGroundNet = (net: string): boolean => GROUND_NET_RE.test(net)
const isPowerNet = (net: string): boolean => POWER_NET_RE.test(net)

/** Manhattan L-path from `a` to `b`, horizontal segment first. */
function lPath(a: SchematicPoint, b: SchematicPoint): number[] {
  if (a.x === b.x || a.y === b.y) return [a.x, a.y, b.x, b.y]
  return [a.x, a.y, b.x, a.y, b.x, b.y]
}

/**
 * Lay out one IR document. The pass is pure and deterministic: identical input
 * produces identical output, and re-running on the result is a no-op.
 * @param ir - the parsed IR; geometry fields may be absent.
 * @param options - grid, spacing, and strategy tunables.
 * @returns the IR with positions, pin endpoints, and routing filled in.
 */
/** One module group: its zone key plus member components. */
type ModuleGroup = readonly [string, SchematicIrComponent[]]

/** Per-sheet zoning: main-zone module groups and the annotation margin set. */
interface SheetZone {
  readonly annotation: readonly SchematicIrComponent[]
  readonly groups: ReadonlyMap<string, SchematicIrComponent[]>
  readonly orderedGroups: readonly ModuleGroup[]
  readonly blockOf: ReadonlyMap<string, string>
  readonly sidesOf: ReadonlyMap<string, readonly PinSide[]>
}

/**
 * Zone one sheet: components cluster by declared functional block (component
 * `block` against `sheet.blocks`), each module runs the signal-flow layering
 * inside its own grid cell, and the cells pack row-major in declaration order
 * (undeclared names sorted, ungrouped last). A sheet without module
 * membership degenerates to one group — the flat layout.
 */
function zoneSheet(sheet: SchematicIrSheet): SheetZone {
  const main = sheet.components.filter(component => !ANNOTATION_KINDS.has(component.kind))
  const annotation = sheet.components.filter(component => ANNOTATION_KINDS.has(component.kind))

  const declaredOrder = new Map<string, number>()
  sheet.blocks?.forEach((block, index) => declaredOrder.set(block.name, index))
  const groups = new Map<string, SchematicIrComponent[]>()
  for (const component of main) {
    const key = component.block ?? ''
    const group = groups.get(key) ?? []
    group.push(component)
    groups.set(key, group)
  }
  // Grid order: declared modules in declaration order, undeclared names
  // alphabetically, and the ungrouped remainder last.
  const named = [...groups.keys()].filter(key => key !== '')
  const orderedGroups: ModuleGroup[] = [
    ...named.filter(key => declaredOrder.has(key))
      .sort((a, b) => (declaredOrder.get(a) as number) - (declaredOrder.get(b) as number)),
    ...named.filter(key => !declaredOrder.has(key)).sort((a, b) => a.localeCompare(b)),
    ...(groups.has('') ? [''] : []),
  ].map(key => [key, groups.get(key) as SchematicIrComponent[]] as const)
  // Component → module key for inter-module net detection; a net spanning
  // two groups routes through flags instead of a trunk so modules stay
  // visually separable.
  const blockOf = new Map<string, string>()
  for (const [key, group] of groups) for (const component of group) blockOf.set(component.id, key)
  const sidesOf = new Map<string, PinSide[]>()
  for (const component of sheet.components) {
    sidesOf.set(component.id, pinSides(component.pins))
  }
  return { annotation, groups, orderedGroups, blockOf, sidesOf }
}

/**
 * Per-component half-heights under one pin pitch: the synthesized pin rows
 * (split across both symbol sides) plus outline padding. Recomputed per
 * spacing rung because compression shrinks the pin pitch.
 */
function halfHeightsOf(
  components: readonly SchematicIrComponent[],
  sidesOf: ReadonlyMap<string, readonly PinSide[]>,
  pinPitch: number,
  grid: number,
): Map<string, number> {
  const halfHeightOf = new Map<string, number>()
  for (const component of components) {
    const sides = sidesOf.get(component.id) as PinSide[]
    const rows = Math.max(
      sides.filter(side => side === 'left').length,
      sides.length - sides.filter(side => side === 'left').length,
      1,
    )
    halfHeightOf.set(component.id, snap((rows * pinPitch) / 2 + BODY_HALF_PADDING, grid))
  }
  return halfHeightOf
}

/**
 * Place one module group relative to `origin` in signal-flow columns;
 * returns the group's bounding span for grid packing. A column that would
 * grow past `maxHeight` wraps into a continuation column one pitch to the
 * right, so a tall group widens instead of running off the page.
 */
function placeGroup(
  members: readonly SchematicIrComponent[],
  origin: SchematicPoint,
  positions: Map<string, SchematicPoint>,
  halfHeightOf: ReadonlyMap<string, number>,
  o: ResolvedLayoutOptions,
  maxHeight: number,
): { width: number; height: number } {
  const layers = layerOf([...members])
  const columns = new Map<number, SchematicIrComponent[]>()
  for (const component of members) {
    const layer = layers.get(component.id) as number
    const column = columns.get(layer) ?? []
    column.push(component)
    columns.set(layer, column)
  }
  for (const column of columns.values()) {
    column.sort((a, b) => componentKey(a).localeCompare(componentKey(b)))
  }
  let width = 0
  let height = 0
  for (const layer of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(layer) as SchematicIrComponent[]
    let cursor = origin.y
    let peak = 0
    let columnX = snap(origin.x + layer * o.columnPitch, o.grid)
    for (const component of column) {
      const half = halfHeightOf.get(component.id) as number
      if (cursor !== origin.y && cursor + 2 * half > origin.y + maxHeight) {
        peak = Math.max(peak, cursor - o.rowGap - origin.y)
        columnX = snap(columnX + o.columnPitch, o.grid)
        cursor = origin.y
      }
      if (!positions.has(component.id)) {
        positions.set(component.id, { x: snap(columnX + BODY_HALF_WIDTH, o.grid), y: snap(cursor + half, o.grid) })
      }
      cursor += 2 * half + o.rowGap
    }
    width = Math.max(width, columnX + 2 * BODY_HALF_WIDTH - origin.x)
    height = Math.max(height, peak, cursor - o.rowGap - origin.y)
  }
  return { width, height }
}

/** Content rect inside the page frame a sheet may occupy. */
interface PageRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** One packed row of module cells with its bounding height. */
interface PackedRow {
  readonly groups: readonly ModuleGroup[]
  readonly height: number
}

/**
 * Wrap module groups into rows: at most `columns` cells per row and a row
 * never extends past `usable.right` (a group wider than the row still lands
 * in its own row — the validator flags what cannot fit).
 */
function packRows(
  groups: readonly ModuleGroup[],
  spans: readonly { width: number; height: number }[],
  columns: number,
  usable: PageRect,
  gap: number,
): { rows: PackedRow[]; fits: boolean } {
  const rows: PackedRow[] = []
  let fits = true
  let current: ModuleGroup[] = []
  let x = usable.left
  let height = 0
  const flush = (): void => {
    if (x - gap > usable.right) fits = false
    rows.push({ groups: current, height })
    current = []
    x = usable.left
    height = 0
  }
  groups.forEach((group, index) => {
    const span = spans[index] as { width: number; height: number }
    if (current.length > 0 && (current.length === columns || x + span.width > usable.right)) flush()
    current.push(group)
    x += span.width + gap
    height = Math.max(height, span.height)
  })
  // Callers always pass a non-empty group list, so the tail row is live.
  flush()
  return { rows, fits }
}

/**
 * Stack packed rows into pages bounded by `usable.bottom`. `fits` is false
 * when a row alone is taller than a fresh page — pagination cannot fix that;
 * it signals the caller to keep compressing or accept the violation.
 */
function packPages(
  rows: readonly PackedRow[],
  usable: PageRect,
  gap: number,
): { pages: PackedRow[][]; fits: boolean } {
  const pages: PackedRow[][] = []
  let fits = true
  let current: PackedRow[] = []
  let y = usable.top
  for (const row of rows) {
    if (current.length > 0 && y + row.height > usable.bottom) {
      pages.push(current)
      current = []
      y = usable.top
    }
    if (y + row.height > usable.bottom) fits = false
    current.push(row)
    y += row.height + gap
  }
  // Callers always pass a non-empty row list, so the tail page is live.
  pages.push(current)
  return { pages, fits }
}


/** Derived sheet for one pagination page: members of its groups plus (on the
 * first page only) the source sheet's authored wires and annotations. */
function splitSheet(sheet: SchematicIrSheet, rows: readonly PackedRow[], index: number): SchematicIrSheet {
  const memberIds = new Set(rows.flatMap(row => row.groups.flatMap(([, members]) => members.map(component => component.id))))
  const groupNames = new Set(rows.flatMap(row => row.groups.map(([key]) => key)).filter(key => key !== ''))
  const blocks = sheet.blocks?.filter(block => groupNames.has(block.name))
  if (index === 0) {
    return {
      ...sheet,
      blocks,
      components: sheet.components.filter(component => memberIds.has(component.id) || ANNOTATION_KINDS.has(component.kind)),
    }
  }
  return {
    name: sheet.name === undefined ? undefined : `${sheet.name} ${index + 1}`,
    blocks,
    components: sheet.components.filter(component => memberIds.has(component.id)),
    wires: [],
    busEntries: [],
    junctions: [],
    attrs: [],
  }
}

/** Per-source-sheet placement decision: the (possibly split) sheets plus the
 * spacing rung and row packing each produced sheet was planned with. */
interface SheetPlan {
  readonly sheet: SchematicIrSheet
  readonly options: ResolvedLayoutOptions
  readonly rows?: readonly PackedRow[]
}

/**
 * Plan one source sheet against the page frame: measure every module group's
 * span, then walk the degradation ladder — compress module/column spacing
 * until the grid fits one page; if it still overflows, paginate the groups
 * onto additional sheets at default spacing. Sheets carrying authored
 * geometry (explicit positions) or hierarchy primitives (block/sheet
 * components) keep their geometry and rely on `OBJECT_OUT_OF_SHEET` instead.
 */
function planSheet(sheet: SchematicIrSheet, o: ResolvedLayoutOptions): SheetPlan[] {
  const authored = sheet.components.some(component =>
    component.position !== undefined || component.kind === 'block' || component.kind === 'sheet')
  if (authored) return [{ sheet, options: o }]

  const zone = zoneSheet(sheet)
  if (zone.orderedGroups.length === 0) return [{ sheet, options: o }]
  const framed = (sheet.blocks?.length ?? 0) > 0 || sheet.components.some(component => component.block !== undefined)
  const edgePad = framed ? PAGE_EDGE_FRAMED : PAGE_EDGE_FLAT
  const usable: PageRect = {
    left: o.margin.x,
    top: o.margin.y,
    right: o.pageSize.width - edgePad,
    bottom: o.pageSize.height - edgePad,
  }
  const columns = o.moduleColumns ?? Math.ceil(Math.sqrt(zone.orderedGroups.length))
  const usableHeight = usable.bottom - usable.top
  const measure = (options: ResolvedLayoutOptions): { pages: PackedRow[][]; fits: boolean } => {
    const halfHeightOf = halfHeightsOf(sheet.components, zone.sidesOf, options.pinPitch, options.grid)
    const spans = zone.orderedGroups.map(([, members]) =>
      placeGroup(members, { x: 0, y: 0 }, new Map(), halfHeightOf, options, usableHeight))
    const packed = packRows(zone.orderedGroups, spans, columns, usable, options.moduleGap)
    const stacked = packPages(packed.rows, usable, options.moduleGap)
    return { pages: stacked.pages, fits: packed.fits && stacked.fits }
  }

  for (const scale of SPACING_SCALES) {
    const options = compressSpacing(o, scale)
    const { pages, fits } = measure(options)
    if (fits && pages.length === 1) {
      return [{ sheet, options, rows: pages[0] as PackedRow[] }]
    }
  }
  // Still overflowing: a single group cannot split — keep the tightest
  // spacing so the violation stays minimal; multiple groups paginate at
  // default spacing so each delivered page stays readable.
  if (zone.orderedGroups.length === 1) {
    const options = compressSpacing(o, SPACING_SCALES[SPACING_SCALES.length - 1] as number)
    return [{ sheet, options, rows: measure(options).pages[0] as PackedRow[] }]
  }
  return measure(o).pages.map((pageRows, index) => ({
    sheet: splitSheet(sheet, pageRows, index),
    options: o,
    rows: pageRows,
  }))
}

/**
 * Lay out one IR document. The pass is pure and deterministic: identical input
 * produces identical output, and re-running on the result is a no-op. Each
 * source sheet is first planned against the page frame (`pageSize`, default
 * A4): the module grid compresses spacing before overflowing groups spill
 * onto additional sheets, so generated geometry stays inside the frame.
 * @param ir - the parsed IR; geometry fields may be absent.
 * @param options - grid, spacing, page-size, and strategy tunables.
 * @returns the IR with positions, pin endpoints, and routing filled in.
 */
export function layoutSchematic(ir: SchematicIr, options: SchematicLayoutOptions = {}): SchematicIr {
  const o = resolveOptions(options)
  // Pagination runs before the net census so a net crossing a pagination
  // split is seen as multi-sheet and routes through net ports.
  const plans = ir.sheets.flatMap(sheet => planSheet(sheet, o))

  // Global net census: a net declared on more than one sheet routes through
  // net ports rather than same-sheet flags.
  const netSheets = new Map<string, Set<number>>()
  plans.forEach((plan, sheetIndex) => {
    for (const component of plan.sheet.components) {
      for (const pin of component.pins) {
        if (pin.net === undefined) continue
        const set = netSheets.get(pin.net) ?? new Set<number>()
        set.add(sheetIndex)
        netSheets.set(pin.net, set)
      }
    }
  })

  return { sheets: plans.map(plan => layoutSheet(plan, netSheets)) }
}

/** Place, endpoint, and route one planned sheet. */
function layoutSheet(plan: SheetPlan, netSheets: ReadonlyMap<string, Set<number>>): SchematicIrSheet {
    const { sheet } = plan
    const o = plan.options
    const zone = zoneSheet(sheet)
    const { annotation, groups, orderedGroups, blockOf, sidesOf } = zone
    const halfHeightOf = halfHeightsOf(sheet.components, sidesOf, o.pinPitch, o.grid)

    const positions = new Map<string, SchematicPoint>()
    for (const component of sheet.components) {
      if (component.position !== undefined) positions.set(component.id, component.position)
    }

    const moduleColumns = o.moduleColumns ?? Math.ceil(Math.sqrt(Math.max(orderedGroups.length, 1)))
    const rows: readonly PackedRow[] = plan.rows ?? (() => {
      const chunked: PackedRow[] = []
      for (let i = 0; i < orderedGroups.length; i += moduleColumns) {
        chunked.push({ groups: orderedGroups.slice(i, i + moduleColumns), height: 0 })
      }
      return chunked
    })()
    const framed = (sheet.blocks?.length ?? 0) > 0 || sheet.components.some(component => component.block !== undefined)
    const edgePad = framed ? PAGE_EDGE_FRAMED : PAGE_EDGE_FLAT
    const rightEdge = o.pageSize.width - edgePad
    const bottomEdge = o.pageSize.height - edgePad
    const inFrame = (p: SchematicPoint): boolean =>
      p.x >= 0 && p.x <= o.pageSize.width && p.y >= 0 && p.y <= o.pageSize.height
    const clampFrame = (p: SchematicPoint): SchematicPoint => ({
      x: Math.min(Math.max(p.x, 0), o.pageSize.width),
      y: Math.min(Math.max(p.y, 0), o.pageSize.height),
    })

    let annotationX = o.margin.x
    let rowY = o.margin.y
    for (const row of rows) {
      let cellX = o.margin.x
      let rowHeight = 0
      for (const group of row.groups) {
        const box = placeGroup(group[1], { x: cellX, y: rowY }, positions, halfHeightOf, o, bottomEdge - rowY)
        cellX += box.width + o.moduleGap
        rowHeight = Math.max(rowHeight, box.height)
        annotationX = Math.max(annotationX, cellX - o.moduleGap)
      }
      rowY += rowHeight + o.moduleGap
    }
    // The annotation margin stacks beside the main zone; when a column
    // reaches the usable bottom it wraps right, and columns that would pass
    // the right edge clamp onto it (in-bounds, possibly crowded).
    let annotationColumn = annotationX + ANNOTATION_GAP + BODY_HALF_WIDTH
    let annotationCursor = o.margin.y
    for (const component of annotation) {
      const half = halfHeightOf.get(component.id) as number
      if (!positions.has(component.id)) {
        if (annotationCursor + 2 * half > bottomEdge && annotationCursor !== o.margin.y) {
          annotationColumn += 2 * BODY_HALF_WIDTH + ANNOTATION_GAP
          annotationCursor = o.margin.y
        }
        positions.set(component.id, {
          x: Math.min(snap(annotationColumn, o.grid), rightEdge),
          y: snap(annotationCursor + half, o.grid),
        })
      }
      annotationCursor += 2 * half + o.rowGap
    }

    // --- Pin endpoints: when the bound symbol's pin geometry is known, pins
    // sit on the real symbol offsets (transformed by rotation/mirror) and an
    // explicit endpoint within one grid step snaps onto its true pin; farther
    // deviations keep their value for `WIRE_NOT_ON_PIN` to report. Otherwise
    // endpoints fall back to synthesized rows on the assigned side.
    const laid: LaidComponent[] = sheet.components.map((component) => {
      const position = positions.get(component.id) as SchematicPoint
      const symbolPins = component.symbolUuid === undefined
        ? undefined
        : o.symbolPins.get(component.symbolUuid)
      const realPin = symbolPins === undefined
        ? undefined
        : new Map(symbolPins.map(symbolPin => [symbolPin.number, symbolPin]))
      const trueEndpoint = (pin: SchematicIrPin): SchematicPoint | undefined => {
        if (realPin === undefined || pin.number === undefined) return undefined
        const symbolPin = realPin.get(pin.number)
        if (symbolPin === undefined) return undefined
        const offset = transformSymbolPoint(
          { x: symbolPin.x, y: symbolPin.y },
          component.rotation,
          component.mirror,
        )
        return { x: position.x + offset.x, y: position.y + offset.y }
      }
      const sides = sidesOf.get(component.id) as PinSide[]
      const expectedPoints = component.pins.map(pin => trueEndpoint(pin))
      // Synthesized rows size themselves against the pins that actually need
      // one — pins with real or explicit endpoints do not consume a row.
      const synthesized = component.pins.map((pin, index) =>
        expectedPoints[index] === undefined && pin.endpoint === undefined ? sides[index] : undefined)
      const lefts = synthesized.filter(side => side === 'left').length
      const rights = synthesized.filter(side => side === 'right').length
      let li = 0
      let ri = 0
      const pins = component.pins.map((pin, index): PlacedPin => {
        const expected = expectedPoints[index]
        if (pin.endpoint !== undefined) {
          if (expected !== undefined
            && Math.abs(pin.endpoint.x - expected.x) <= o.grid
            && Math.abs(pin.endpoint.y - expected.y) <= o.grid) {
            return { ...pin, endpoint: expected }
          }
          return { ...pin, endpoint: pin.endpoint }
        }
        if (expected !== undefined) return { ...pin, endpoint: expected }
        const side = sides[index] as PinSide
        const rowIndex = side === 'left' ? li++ : ri++
        const rows = side === 'left' ? lefts : rights
        const y = position.y - ((rows - 1) * o.pinPitch) / 2 + rowIndex * o.pinPitch
        const x = position.x + (side === 'left' ? -1 : 1) * (BODY_HALF_WIDTH + o.pinStub)
        return { ...pin, endpoint: { x: snap(x, o.grid), y: snap(y, o.grid) } }
      })
      // Real pin offsets settle the routing side: a pin whose transformed x
      // offset is negative fans out left, positive right; a zero offset keeps
      // the electrically assigned side.
      const effectiveSides = component.pins.map((pin, index) => {
        if (realPin === undefined || pin.number === undefined) return sides[index] as PinSide
        const symbolPin = realPin.get(pin.number)
        if (symbolPin === undefined) return sides[index] as PinSide
        const dx = transformSymbolPoint(
          { x: symbolPin.x, y: symbolPin.y },
          component.rotation,
          component.mirror,
        ).x
        return dx < 0 ? 'left' as const : dx > 0 ? 'right' as const : sides[index] as PinSide
      })
      return { source: component, position, pins, sides: effectiveSides }
    })

    const components: SchematicIrComponent[] = laid.map(component => ({
      ...component.source,
      position: component.position,
      pins: [...component.pins],
    }))
    const wires: SchematicIrWire[] = sheet.wires.map(wire => ({ ...wire, dots: wire.dots?.map(line => [...line]) }))
    const junctions: SchematicIrJunction[] = sheet.junctions.map(junction => ({ ...junction }))
    const junctionKeys = new Set(junctions.map(junction => `${junction.point.x},${junction.point.y}`))
    const addJunction = (point: SchematicPoint): void => {
      const key = `${point.x},${point.y}`
      if (!junctionKeys.has(key)) {
        junctionKeys.add(key)
        junctions.push({ point })
      }
    }

    // --- Nets: `pin.net` is the logical connectivity declaration.
    const nets = new Map<string, { component: LaidComponent; pin: PlacedPin; side: PinSide }[]>()
    for (const component of laid) {
      component.pins.forEach((pin, index) => {
        if (pin.net === undefined) return
        const members = nets.get(pin.net) ?? []
        members.push({ component, pin, side: component.sides[index] as PinSide })
        nets.set(pin.net, members)
      })
    }

    const flagPositions = (net: string): SchematicPoint[] =>
      components
        .filter(component => FLAG_KINDS.has(component.kind) && component.netName === net && component.position !== undefined)
        .map(component => component.position as SchematicPoint)

    /** A wire carries `net` when it declares it, or when a flag of that net sits on it. */
    const wireCarries = (wire: SchematicIrWire, net: string, flags: readonly SchematicPoint[]): boolean =>
      wire.net === net || flags.some(point => onWire(point, wire))

    // Points a routed segment may not pass through: every pin endpoint, flag
    // position, and junction point, keyed to the net that owns it (or '' when
    // the point is unowned). A segment touching a foreign point would merge
    // two nets.
    const occupied = new Map<string, string>()
    const occupy = (point: SchematicPoint, net: string | undefined): void => {
      occupied.set(`${point.x},${point.y}`, net ?? '')
    }
    for (const component of laid) {
      for (const pin of component.pins) occupy(pin.endpoint, pin.net)
    }
    for (const component of components) {
      if (FLAG_KINDS.has(component.kind) && component.position !== undefined) {
        occupy(component.position, component.netName)
      }
    }
    for (const junction of junctions) occupy(junction.point, undefined)

    for (const net of [...nets.keys()].sort()) {
      const members = nets.get(net) as { component: LaidComponent; pin: PlacedPin; side: PinSide }[]
      const flags = flagPositions(net).sort((a, b) => a.x - b.x || a.y - b.y)
      const carrying = wires.filter(wire => wireCarries(wire, net, flags))
      const unrouted = members.filter(member => !carrying.some(wire => onWire(member.pin.endpoint, wire)))
      if (unrouted.length === 0) continue
      const crossSheet = (netSheets.get(net) as Set<number>).size > 1
      const powerClass = isPowerNet(net) || members.some(member => member.pin.powerName !== undefined)
      const crossModule = groups.size > 1
        && new Set(members.map(member => blockOf.get(member.component.source.id))).size > 1
      const useFlags = flags.length > 0 || powerClass || isGroundNet(net) || crossSheet || crossModule || members.length >= o.flagFanout
      const foreign: SchematicPoint[] = [...occupied.entries()]
        .filter(([, owner]) => owner !== net)
        .map(([key]) => {
          const [x, y] = key.split(',')
          return { x: Number(x), y: Number(y) }
        })
      /** Whether any generated segment passes through a point owned by another net. */
      const collides = (dots: number[][]): boolean =>
        foreign.some(point =>
          dots.some((seg) => {
            for (let i = 0; i + 3 < seg.length; i += 2) {
              if (onSegment(point, seg[i] as number, seg[i + 1] as number, seg[i + 2] as number, seg[i + 3] as number)) {
                return true
              }
            }
            return false
          }))

      const routeWithFlags = (): void => {
        // Flag strategy: every unrouted member gets a short stub and a nearby
        // flag of the same name; flags merge by name, so no trunk is needed.
        // Power nets hang up, ground-family nets hang down, and other nets
        // reach outward from the pin's side.
        const flagKind = crossSheet ? 'netport' : 'netflag'
        const stubDots: number[][] = []
        unrouted.forEach((member, index) => {
          const endpoint = member.pin.endpoint
          const direct: SchematicPoint = isGroundNet(net)
            ? { x: endpoint.x, y: snap(endpoint.y - FLAG_STUB, o.grid) }
            : powerClass
              ? { x: endpoint.x, y: snap(endpoint.y + FLAG_STUB, o.grid) }
              : {
                x: snap(endpoint.x + (member.side === 'left' ? -FLAG_STUB : FLAG_STUB), o.grid),
                y: endpoint.y,
              }
          // A flag that would land outside the page frame mirrors across the
          // pin endpoint; an endpoint itself out of bounds clamps the flag
          // onto the frame edge.
          let flagPosition = direct
          if (!inFrame(direct)) {
            const mirrored: SchematicPoint = isGroundNet(net) || powerClass
              ? { x: direct.x, y: snap(2 * endpoint.y - direct.y, o.grid) }
              : { x: snap(2 * endpoint.x - direct.x, o.grid), y: direct.y }
            flagPosition = inFrame(mirrored) ? mirrored : clampFrame(direct)
          }
          if (endpoint.x !== flagPosition.x || endpoint.y !== flagPosition.y) {
            stubDots.push(lPath(endpoint, flagPosition))
          }
          components.push({
            id: `layout:flag:${idPart(net)}:${index}`,
            kind: flagKind,
            netName: net,
            position: flagPosition,
            pins: [],
          })
        })
        if (stubDots.length > 0) {
          wires.push({ id: `layout:wire:${idPart(net)}:flags`, kind: 'wire', dots: stubDots, net })
        }
      }

      if (useFlags) {
        routeWithFlags()
        continue
      }

      const carrier = carrying.find(wire => wire.dots !== undefined && wire.dots.length > 0)
      if (carrier !== undefined) {
        // Route unrouted members onto the named carrier as L-stubs ending on
        // its first vertex.
        const carrierDots = carrier.dots as number[][]
        const anchorDots = carrierDots[0] as readonly number[]
        const anchor: SchematicPoint = { x: anchorDots[0] as number, y: anchorDots[1] as number }
        const dots = carrierDots.map(line => [...line])
        for (const member of unrouted) {
          dots.push(lPath(member.pin.endpoint, anchor))
        }
        if (collides(dots)) {
          routeWithFlags()
          continue
        }
        wires[wires.indexOf(carrier)] = { ...carrier, dots }
        continue
      }

      // Standalone trunk: one horizontal spine at the median member height
      // with a vertical stub per unrouted endpoint, carried either by a
      // declared net-only wire or by a generated one.
      const endpoints = unrouted
        .map(member => member.pin.endpoint)
        .sort((a, b) => a.y - b.y || a.x - b.x)
      const first = endpoints[0] as SchematicPoint
      const median = endpoints[Math.floor((endpoints.length - 1) / 2)] as SchematicPoint
      const trunkY = snap(median.y, o.grid)
      const xs = endpoints.map(point => point.x)
      const dots: number[][] = []
      const newJunctions: SchematicPoint[] = []
      if (endpoints.length === 1) {
        const dir = (unrouted[0] as { side: PinSide }).side === 'left' ? -1 : 1
        dots.push([first.x, first.y, snap(first.x + dir * 4 * o.pinStub, o.grid), first.y])
      } else {
        dots.push([Math.min(...xs), trunkY, Math.max(...xs), trunkY])
        for (const endpoint of endpoints) {
          if (endpoint.y === trunkY) continue
          dots.push([endpoint.x, endpoint.y, endpoint.x, trunkY])
          newJunctions.push({ x: endpoint.x, y: trunkY })
        }
      }
      if (collides(dots)) {
        routeWithFlags()
        continue
      }
      for (const point of newJunctions) addJunction(point)
      const declared = carrying[0]
      if (declared !== undefined) {
        wires[wires.indexOf(declared)] = { ...declared, dots }
      } else {
        wires.push({ id: `layout:wire:${idPart(net)}`, kind: 'wire', dots, net })
      }
    }

    return {
      ...sheet,
      components,
      wires,
      busEntries: sheet.busEntries,
      junctions,
      attrs: sheet.attrs,
    }
}
