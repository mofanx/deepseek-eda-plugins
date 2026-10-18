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
import { SCHEMATIC_PAGE_BUDGET, fittedPageSize, snapToGrid } from './budget.ts'
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
const MODULE_GAP = SCHEMATIC_PAGE_BUDGET.moduleGap
/**
 * Body half-width for the placement outline; the library APIs expose no
 * symbol geometry, so occupancy derives from the declared pin counts.
 */
const BODY_HALF_WIDTH = 60
/** Vertical padding above the outermost pin row inside the outline. */
const BODY_HALF_PADDING = 20
/**
 * Width-to-height ratio the module packer aims for when one signal-flow layer
 * stacks many siblings in a single column. The reference project's modules are
 * 1.4:1-1.7:1 (wide and short); one column of six 2-pin parts is 1:4.7 and
 * leaves 46% of its frame blank (t14). Splitting such a layer into balanced
 * sub-columns makes the block wide instead of tall without changing members.
 */
const MODULE_BLOCK_ASPECT = 1.4
/**
 * Edge allowance inside the page frame for sheets carrying module frames —
 * covers the pin stub + flag stub plus the frame padding and title headroom
 * the serializer adds around module members. The title block is five rows
 * (130 units) tall, so on A4 it reaches up to y=679 and the framed content
 * bound sits at 825−170=655, leaving 24 units of clearance under the block.
 */
const PAGE_EDGE_FRAMED = SCHEMATIC_PAGE_BUDGET.edgePadFramed
/** Edge allowance for flat sheets: pin stub plus generated flag stub. */
const PAGE_EDGE_FLAT = SCHEMATIC_PAGE_BUDGET.edgePadFlat
/**
 * Module-frame padding the serializer draws around grouped members, plus the
 * headroom its title band takes above them. Exported so the serializer and the
 * page fit below cannot drift apart: the fit box must cover the drawn frame,
 * or a fitted sheet would let the frame reach into the title block.
 */
export const SCHEMATIC_FRAME_PAD = 80
export const SCHEMATIC_FRAME_HEADROOM = 60
/**
 * Content coverage below which a planned page is fitted down to its content
 * instead of delivering a large empty sheet around a small cluster.
 */
const PAGE_FILL_TARGET = SCHEMATIC_PAGE_BUDGET.fillTarget
/** Narrowest/ shortest fitted sheet: the title block is 560 wide and 146 tall. */
/**
 * Margin a fitted sheet keeps above and left of its content. The framed edge
 * allowance (170) is only needed on the right and bottom, where the title block
 * sits and where the framed clearance of 24 must hold; the top and left edges
 * only carry the drawing border, so a small drawing margin keeps the fitted
 * sheet dense instead of padding it symmetrically.
 */
/**
 * Outward extent of everything the serializer draws around a planned cell: the
 * symbol body plus pin stub, then the module frame pad, then the net port or
 * flag routed past the pin endpoint. The fit box below has to cover all of it,
 * or a fitted sheet clips its own routing (and a page whose height is already
 * at the planned maximum would push its frame into the title block).
 */
const FITTED_OUTWARD_X = SCHEMATIC_PAGE_BUDGET.outwardX
const FITTED_OUTWARD_TOP = SCHEMATIC_PAGE_BUDGET.outwardTop
const FITTED_OUTWARD_BOTTOM = SCHEMATIC_PAGE_BUDGET.outwardBottom
/** Drawing margin a fitted sheet keeps above its content (the title block owns the bottom). */
const FITTED_MARGIN = SCHEMATIC_PAGE_BUDGET.fittedMargin
/**
 * Spacing compression ladder applied to column pitch and row gap when the
 * module grid overflows the page; each level retries the single-page pack
 * before layout falls back to pagination. The module gap is not part of the
 * ladder: the serializer pads each module frame by 80 units horizontally and
 * by 80 + 60 units vertically (body/stub + title headroom), so a gap below
 * 200 would make neighbouring dashed frames overlap — exactly the unreadable
 * result pagination exists to avoid. Overflow that would have needed a
 * tighter gap paginates instead.
 */
const SPACING_SCALES = [1, 0.6, 0.3]
/** Compression floors: below these, bodies/pin stubs would overlap. */
const MIN_COLUMN_PITCH = 160
const MIN_ROW_GAP = 30
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
  /** Frame-safe gap between module cells (never compressed). */
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
 * Apply one rung of the spacing-compression ladder: column pitch and row gap
 * shrink toward their floors so a slightly oversized module grid still fits
 * the page without splitting sheets. The module gap stays fixed so the drawn
 * module frames never overlap; a grid that only fits by shrinking that gap is
 * paginated instead.
 */
function compressSpacing(o: ResolvedLayoutOptions, scale: number): ResolvedLayoutOptions {
  if (scale === 1) return o
  return {
    ...o,
    columnPitch: Math.max(MIN_COLUMN_PITCH, o.columnPitch * scale),
    rowGap: Math.max(MIN_ROW_GAP, o.rowGap * scale),
    pinPitch: Math.max(MIN_PIN_PITCH, o.pinPitch * scale),
  }
}

const snap = snapToGrid

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

/** One net member: a placed pin plus the side it was assigned for routing. */
interface NetMember {
  readonly component: LaidComponent
  readonly pin: PlacedPin
  readonly side: PinSide
}

/** Approximate symbol outline used to keep wires and flags off component bodies. */
interface BodyRect {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
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

/** Twice the signed area of triangle (a, b, c); zero means collinear. */
const crossOf = (a: SchematicPoint, b: SchematicPoint, c: SchematicPoint): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

/**
 * Whether two segments touch or cross. A shared endpoint, a T-tap, and a
 * four-way crossing all count: a routed wire that ends on another net's wire
 * merges the nets in EasyEDA, and a crossing is visually ambiguous even when
 * the client does not join it.
 */
export function segmentsTouch(a: SchematicPoint, b: SchematicPoint, c: SchematicPoint, d: SchematicPoint): boolean {
  const d1 = crossOf(c, d, a)
  const d2 = crossOf(c, d, b)
  const d3 = crossOf(a, b, c)
  const d4 = crossOf(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  if (d1 === 0 && onSegment(a, c.x, c.y, d.x, d.y)) return true
  if (d2 === 0 && onSegment(b, c.x, c.y, d.x, d.y)) return true
  if (d3 === 0 && onSegment(c, a.x, a.y, b.x, b.y)) return true
  if (d4 === 0 && onSegment(d, a.x, a.y, b.x, b.y)) return true
  return false
}

/**
 * Whether segment `a`–`b` crosses through `rect` shrunk by `pad`. A segment
 * with an endpoint inside the rect is not a crossing: symbol pin geometry may
 * sit inside the estimated outline, and a stub that starts at a pin must stay
 * legal. Only a wire that passes clean through the body counts.
 */
export function segmentCrossesRect(a: SchematicPoint, b: SchematicPoint, rect: BodyRect, pad: number): boolean {
  const left = rect.left + pad
  const right = rect.right - pad
  const top = rect.top + pad
  const bottom = rect.bottom - pad
  if (right <= left || bottom <= top) return false
  const inside = (p: SchematicPoint): boolean => p.x > left && p.x < right && p.y > top && p.y < bottom
  if (inside(a) || inside(b)) return false
  return segmentsTouch(a, b, { x: left, y: top }, { x: right, y: top })
    || segmentsTouch(a, b, { x: right, y: top }, { x: right, y: bottom })
    || segmentsTouch(a, b, { x: right, y: bottom }, { x: left, y: bottom })
    || segmentsTouch(a, b, { x: left, y: bottom }, { x: left, y: top })
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
 * How many side-by-side sub-columns one layer needs to approach
 * {@link MODULE_BLOCK_ASPECT}. Uses the layer's average member height so a
 * column of tall symbols splits at the same visual ratio as one of short
 * parts. One- and two-member layers stay single: splitting them cannot make
 * the block shorter than one symbol.
 */
function targetColumnsOf(
  members: readonly SchematicIrComponent[],
  halfHeightOf: ReadonlyMap<string, number>,
  o: ResolvedLayoutOptions,
): number {
  if (members.length <= 2) return 1
  let total = 0
  for (const member of members) total += 2 * (halfHeightOf.get(member.id) as number)
  const step = total / members.length + o.rowGap
  const raw = Math.sqrt(MODULE_BLOCK_ASPECT * members.length * step / o.columnPitch)
  return Math.min(members.length, Math.max(1, Math.ceil(raw)))
}

/**
 * Cut one layer's members into contiguous sub-columns, balanced by count and
 * capped by the usable page height. `target === 1` reproduces a plain vertical
 * stack with a page-height wrap; module layers pass the aspect-derived target
 * so six same-layer parts become two balanced columns of three instead of one
 * tall column.
 */
function splitLayerColumns(
  members: readonly SchematicIrComponent[],
  halfHeightOf: ReadonlyMap<string, number>,
  o: ResolvedLayoutOptions,
  maxHeight: number,
  target: number,
): SchematicIrComponent[][] {
  const rowsPerColumn = Math.max(1, Math.ceil(members.length / target))
  const columns: SchematicIrComponent[][] = []
  let column: SchematicIrComponent[] = []
  let height = 0
  for (const member of members) {
    const half = halfHeightOf.get(member.id) as number
    if (column.length > 0) {
      const next = height + o.rowGap + 2 * half
      if (column.length >= rowsPerColumn || next > maxHeight) {
        columns.push(column)
        column = []
        height = 0
      }
    }
    height += (column.length > 0 ? o.rowGap : 0) + 2 * half
    column.push(member)
  }
  if (column.length > 0) columns.push(column)
  return columns
}

/**
 * Place one module group relative to `origin` in signal-flow columns;
 * returns the group's bounding span for grid packing. A module layer too tall
 * for its target aspect is split into balanced sub-columns (`compact`), and a
 * column that still exceeds `maxHeight` wraps into a continuation column one
 * pitch to the right, so a tall group widens instead of running off the page.
 */
function placeGroup(
  members: readonly SchematicIrComponent[],
  origin: SchematicPoint,
  positions: Map<string, SchematicPoint>,
  halfHeightOf: ReadonlyMap<string, number>,
  o: ResolvedLayoutOptions,
  maxHeight: number,
  compact = false,
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
  let x = origin.x
  let width = 0
  let height = 0
  for (const layer of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(layer) as SchematicIrComponent[]
    const target = compact ? targetColumnsOf(column, halfHeightOf, o) : 1
    for (const chunk of splitLayerColumns(column, halfHeightOf, o, maxHeight, target)) {
      let cursor = origin.y
      for (const component of chunk) {
        const half = halfHeightOf.get(component.id) as number
        if (!positions.has(component.id)) {
          positions.set(component.id, { x: snap(x + BODY_HALF_WIDTH, o.grid), y: snap(cursor + half, o.grid) })
        }
        cursor += 2 * half + o.rowGap
      }
      width = Math.max(width, x + 2 * BODY_HALF_WIDTH - origin.x)
      height = Math.max(height, cursor - o.rowGap - origin.y)
      x = snap(x + o.columnPitch, o.grid)
    }
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


/** Derived sheet for one pagination page: members of its cells plus (on the
 * first page only) the source sheet's authored wires and annotations. */
function splitSheet(
  sheet: SchematicIrSheet,
  cells: readonly PlannedCell[],
  index: number,
  blockTitles: ReadonlyMap<string, string>,
  allOwners: ReadonlySet<string>,
): SchematicIrSheet {
  const memberIds = new Set(cells.flatMap(cell => cell.members.map(component => component.id)))
  const groupNames = new Set(cells.map(cell => cell.key).filter(key => key !== ''))
  const blocks = sheet.blocks
    ?.filter(block => groupNames.has(block.name))
    .map(block => blockTitles.has(block.name) ? { ...block, title: blockTitles.get(block.name) as string } : block)
  const components = index === 0
    ? sheet.components.filter(component => memberIds.has(component.id) || ANNOTATION_KINDS.has(component.kind))
    : sheet.components.filter(component => memberIds.has(component.id))
  // Attributes are sheet-scoped rows in the serializer; an ATTR left on page 1
  // while its parent moved to page 3 becomes ORPHAN_ATTR and blocks delivery.
  // Keep each ATTR on the page that owns its component, pin-composite parent,
  // wire, or bus entry. An ATTR whose parent is nowhere stays on page 1 so the
  // validator still reports it instead of silently dropping the declaration.
  const owners = new Set<string>()
  for (const component of components) {
    owners.add(component.id)
    for (const pin of component.pins) owners.add(`${component.id}${pin.id}`)
  }
  // A paginated source sheet has no authored component positions (any authored
  // position keeps the sheet whole), so authored wire geometry and junctions
  // are unanchored: the members were re-placed elsewhere. Drop the geometry but
  // keep the wire rows: their ATTRs stay attached, the declared net keeps its
  // name, and the router emits fresh layout wires for the same net.
  const wires = index === 0
    ? sheet.wires.map(wire => wire.dots === undefined ? wire : { ...wire, dots: undefined })
    : []
  for (const wire of wires) owners.add(wire.id)
  // Bus entries reference a coordinate and a bus name, not a wire id, and carry
  // no net of their own. They stay on page 1 with their ATTRs (dropping them
  // would silently delete author data); a leaked entry can only show up as a
  // NET_NAME_CONFLICT error, which blocks delivery instead of shipping wrong.
  const busEntries = index === 0 ? sheet.busEntries : []
  for (const entry of busEntries) owners.add(entry.id)
  const attrs = sheet.attrs.filter(attr =>
    owners.has(attr.parentId) || (index === 0 && !allOwners.has(attr.parentId)))
  if (index === 0) {
    return { ...sheet, blocks, components, wires, busEntries, junctions: [], attrs }
  }
  return {
    name: sheet.name === undefined ? undefined : `${sheet.name} ${index + 1}`,
    blocks,
    components,
    wires: [],
    busEntries: [],
    junctions: [],
    attrs,
  }
}

/** One placed unit of a page plan: a module (or a page-sized shard of one)
 * together with the exact positions every member was planned at. */
interface PlannedCell {
  /** Module key (`component.block`), or `''` for the ungrouped remainder. */
  readonly key: string
  readonly members: readonly SchematicIrComponent[]
  readonly positions: ReadonlyMap<string, SchematicPoint>
  readonly width: number
  readonly height: number
  /** Placement band within a page, for row centring. */
  readonly band: number
}

/** Per-source-sheet placement decision: the (possibly split) sheets plus the
 * exact cell placement each produced sheet was planned with. Carrying the
 * planned positions (instead of re-running placement at delivery time) keeps
 * planning and delivery identical. */
interface SheetPlan {
  readonly sheet: SchematicIrSheet
  readonly options: ResolvedLayoutOptions
  readonly cells: readonly PlannedCell[]
}

/** Snapshot one cell's member positions out of the shared placement map. */
function cellPositions(
  members: readonly SchematicIrComponent[],
  positions: ReadonlyMap<string, SchematicPoint>,
): ReadonlyMap<string, SchematicPoint> {
  const own = new Map<string, SchematicPoint>()
  for (const member of members) {
    const point = positions.get(member.id)
    if (point !== undefined) own.set(member.id, point)
  }
  return own
}

/** Whether every planned cell stays inside the usable page rect. */
function cellsFit(cells: readonly PlannedCell[], usable: PageRect): boolean {
  for (const cell of cells) {
    for (const point of cell.positions.values()) {
      /* v8 ignore start -- defensive: rows are measured against this same rect, so a planned cell only overflows through a planner bug */
      if (point.x < 0 || point.y < 0 || point.x > usable.right || point.y > usable.bottom) return false
      /* v8 ignore stop */
    }
  }
  return true
}

/** Chunk module groups into rows of at most `columns` groups each. */
function chunkGroups(groups: readonly ModuleGroup[], columns: number): PackedRow[] {
  const rows: PackedRow[] = []
  for (let index = 0; index < groups.length; index += columns) {
    rows.push({ groups: groups.slice(index, index + columns), height: 0 })
  }
  return rows
}

/**
 * Place the rows of a one-page plan and return their cells. Placement is the
 * same routine the delivery pass uses, so the planned coordinates are final.
 * Components carrying authored positions keep them.
 */
function planCells(
  sheet: SchematicIrSheet,
  zone: SheetZone,
  options: ResolvedLayoutOptions,
  usable: PageRect,
  rows: readonly PackedRow[],
): PlannedCell[] {
  const halfHeightOf = halfHeightsOf(sheet.components, zone.sidesOf, options.pinPitch, options.grid)
  const positions = new Map<string, SchematicPoint>()
  for (const component of sheet.components) {
    if (component.position !== undefined) positions.set(component.id, component.position)
  }
  const cells: PlannedCell[] = []
  let rowY = usable.top
  for (const row of rows) {
    let cellX = usable.left
    let rowHeight = 0
    for (const [key, members] of row.groups) {
      const box = placeGroup(members, { x: cellX, y: rowY }, positions, halfHeightOf, options, usable.bottom - rowY, key !== '')
      cells.push({ key, members, positions: cellPositions(members, positions), width: box.width, height: box.height, band: 0 })
      cellX += box.width + options.moduleGap
      rowHeight = Math.max(rowHeight, box.height)
    }
    rowY += rowHeight + options.moduleGap
  }
  return cells
}

/** One page-sized shard of a module group: the members and their positions
 * relative to the shard origin (the shard is offset when packed onto a page). */
interface Shard {
  readonly key: string
  readonly members: readonly SchematicIrComponent[]
  readonly positions: ReadonlyMap<string, SchematicPoint>
  readonly width: number
  readonly height: number
}

/**
 * Split one module group into page-sized shards. The group's signal-flow
 * columns are laid out left to right, wrapped into a new band when the usable
 * width is reached, and cut into a new shard when the usable height is
 * reached. A single column taller than a page is cut into consecutive member
 * chunks first, so a wide or tall module paginates instead of running off the
 * frame. A component larger than the page remains its own oversize shard —
 * the validator owns that irreducible case.
 */
function shardGroup(
  key: string,
  members: readonly SchematicIrComponent[],
  o: ResolvedLayoutOptions,
  halfHeightOf: ReadonlyMap<string, number>,
  usableWidth: number,
  usableHeight: number,
): Shard[] {
  const layers = layerOf([...members])
  const columns = new Map<number, SchematicIrComponent[]>()
  for (const component of members) {
    const layer = layers.get(component.id) as number
    const column = columns.get(layer) ?? []
    column.push(component)
    columns.set(layer, column)
  }
  for (const column of columns.values()) column.sort((a, b) => componentKey(a).localeCompare(componentKey(b)))

  // Cut each signal-flow layer into page-height chunks, and split a layer that
  // would stand as one tall column into the same balanced sub-columns the
  // one-page packer uses. Paginated module frames are what the t13 review
  // measured as 1:4.7; splitting here is what makes a delivered page wide.
  const chunks: SchematicIrComponent[][] = []
  for (const layer of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(layer) as SchematicIrComponent[]
    const target = key === '' ? 1 : targetColumnsOf(column, halfHeightOf, o)
    chunks.push(...splitLayerColumns(column, halfHeightOf, o, usableHeight, target))
  }

  const shards: Shard[] = []
  let placed: SchematicIrComponent[] = []
  let positions = new Map<string, SchematicPoint>()
  let width = 0
  let height = 0
  const flush = (): void => {
    /* v8 ignore next -- groups are never empty, so a shard always has members */
    if (placed.length === 0) return
    shards.push({ key, members: placed, positions, width, height })
    placed = []
    positions = new Map()
    width = 0
    height = 0
  }
  const columnWidth = 2 * BODY_HALF_WIDTH
  let x = 0
  let y = 0
  let bandHeight = 0
  for (const chunk of chunks) {
    const columnHeight = chunk.reduce((sum, component) =>
      sum + 2 * (halfHeightOf.get(component.id) as number) + o.rowGap, 0) - o.rowGap
    if (x > 0 && x + columnWidth > usableWidth) {
      x = 0
      y += bandHeight + o.rowGap * 2
      bandHeight = 0
    }
    if (placed.length > 0 && y + columnHeight > usableHeight) {
      flush()
      x = 0
      y = 0
      bandHeight = 0
    }
    let cursor = y
    for (const component of chunk) {
      const half = halfHeightOf.get(component.id) as number
      positions.set(component.id, { x: snap(x + BODY_HALF_WIDTH, o.grid), y: snap(cursor + half, o.grid) })
      placed.push(component)
      cursor += 2 * half + o.rowGap
    }
    width = Math.max(width, x + columnWidth)
    height = Math.max(height, y + columnHeight)
    bandHeight = Math.max(bandHeight, columnHeight)
    x += o.columnPitch
  }
  flush()
  return shards
}

/**
 * Paginate a sheet that no spacing rung can fit on one page. Groups are laid
 * out at default (readable) spacing and split into page-sized shards; shards
 * then shelf-pack onto pages, so a single oversized module, a flat sheet, or a
 * module grid all paginate instead of overflowing the frame. Continuation
 * pages of a split module carry an `(n/m)` title suffix so the repeated frame
 * is unambiguous.
 */
/**
 * Display titles of the modules a paginated page carries, in placement order.
 * Cells for ungrouped members carry the empty key and contribute nothing.
 */
function pageModuleTitles(sheet: SchematicIrSheet, cells: readonly PlannedCell[]): string[] {
  const titles = new Set<string>()
  for (const cell of cells) {
    if (cell.key === '') continue
    titles.add(sheet.blocks?.find(block => block.name === cell.key)?.title ?? cell.key)
  }
  return [...titles]
}

/** Most module names one page name lists before falling back to the sheet name. */
const MAX_PAGE_NAME_MODULES = 3
/** Longest composed page name; beyond this the authored sheet name reads better. */
const MAX_PAGE_NAME_LENGTH = 40

/**
 * Page name derived from the modules a page carries. The reference project
 * names its pages after their modules (`CORE`, `POWER`, `DEVICE`), so a
 * single-module page takes that title and a mixed page lists them
 * (`MCU+POWER+IO`). A page with too many modules, or one whose composed name
 * would be unwieldy, returns `undefined` and keeps the sheet's own name.
 */
function pageModuleTitle(sheet: SchematicIrSheet, cells: readonly PlannedCell[]): string | undefined {
  const titles = pageModuleTitles(sheet, cells)
  if (titles.length === 0 || titles.length > MAX_PAGE_NAME_MODULES) return undefined
  const name = titles.join('+')
  return name.length <= MAX_PAGE_NAME_LENGTH ? name : undefined
}

/**
 * Content box of one planned page, padded to the frame the serializer draws
 * around grouped members (or to the symbol body model on flat sheets).
 */
function pageContentBox(
  cells: readonly PlannedCell[],
  framed: boolean,
  tight = false,
): { x1: number; y1: number; x2: number; y2: number } {
  const padX = framed && !tight ? FITTED_OUTWARD_X : BODY_HALF_WIDTH
  const padTop = framed && !tight ? FITTED_OUTWARD_TOP : BODY_HALF_PADDING * 2
  const padBottom = framed && !tight ? FITTED_OUTWARD_BOTTOM : BODY_HALF_PADDING * 2
  let x1 = Number.POSITIVE_INFINITY
  let y1 = Number.POSITIVE_INFINITY
  let x2 = Number.NEGATIVE_INFINITY
  let y2 = Number.NEGATIVE_INFINITY
  for (const cell of cells) {
    for (const point of cell.positions.values()) {
      x1 = Math.min(x1, point.x - padX)
      x2 = Math.max(x2, point.x + padX)
      y1 = Math.min(y1, point.y - padTop)
      y2 = Math.max(y2, point.y + padBottom)
    }
  }
  return { x1, y1, x2, y2 }
}

/**
 * Page size for one planned page: the planned frame, or — when the content
 * covers less than {@link PAGE_FILL_TARGET} of it — a sheet fitted to the
 * content box plus the layout margin and the framed edge allowance. The fitted
 * size is never larger than the planned frame and never narrower than the
 * title block, and the returned object is the planned size itself when no fit
 * applies so callers can keep reference equality.
 */
function fitPageSize(
  tightBox: { x1: number; y1: number; x2: number; y2: number },
  outwardBox: { x1: number; y1: number; x2: number; y2: number },
  o: ResolvedLayoutOptions,
  edgePad: number,
): SchematicPageSize {

  const tightArea = (tightBox.x2 - tightBox.x1) * (tightBox.y2 - tightBox.y1)
  if (tightArea >= PAGE_FILL_TARGET * o.pageSize.width * o.pageSize.height) return o.pageSize
  return fittedPageSize(outwardBox, o.pageSize, o.grid, edgePad)
}

/** Shards that fit side by side in one band before the width wraps. */
function bandCapacity(shards: readonly Shard[], usable: PageRect, gap: number): number {
  let count = 0
  let x = usable.left
  for (const shard of shards) {
    if (count > 0 && x + shard.width > usable.right) break
    x += shard.width + gap
    count += 1
  }
  return Math.max(1, count)
}

/**
 * Centre every partial band inside the widest band on the same page. A page
 * balanced 3 + 2 puts two modules on the first band and one on the second;
 * left-aligned, the lone module reads as an unfinished row. Centring keeps the
 * page's outer box (the widest band still defines it) while making the shorter
 * row look deliberate.
 */
function centreBands(cells: readonly PlannedCell[], o: ResolvedLayoutOptions): PlannedCell[] {
  const bands = new Map<number, PlannedCell[]>()
  for (const cell of cells) {
    const band = cell.band
    const list = bands.get(band) ?? []
    list.push(cell)
    bands.set(band, list)
  }
  if (bands.size <= 1) return [...cells]
  const widths = new Map<number, number>()
  for (const [band, list] of bands) {
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    for (const cell of list) {
      for (const point of cell.positions.values()) {
        minX = Math.min(minX, point.x)
        maxX = Math.max(maxX, point.x)
      }
    }
    widths.set(band, maxX - minX + 2 * BODY_HALF_WIDTH)
  }
  const widest = Math.max(...widths.values())
  return cells.map((cell) => {
    const band = cell.band
    const dx = snap((widest - (widths.get(band) as number)) / 2, o.grid)
    if (dx === 0) return cell
    return {
      ...cell,
      positions: new Map([...cell.positions].map(([id, point]) => [id, { x: point.x + dx, y: point.y }])),
    }
  })
}

/**
 * Shelf-pack shards into pages, wrapping a band at the usable width and
 * breaking a page at the usable height or at `pageLimit` modules. `pageLimit`
 * may be `Infinity` for a greedy measurement pass; the returned cells carry
 * their band index so {@link centreBands} can align partial rows afterwards.
 */
function packShards(
  shards: readonly Shard[],
  usable: PageRect,
  o: ResolvedLayoutOptions,
  bandLimit: number,
  pageLimit: number,
): PlannedCell[][] {
  const pages: PlannedCell[][] = []
  let cells: PlannedCell[] = []
  let x = usable.left
  let y = usable.top
  let bandHeight = 0
  let inBand = 0
  let band = 0
  const flushPage = (): void => {
    pages.push(cells)
    cells = []
    x = usable.left
    y = usable.top
    bandHeight = 0
    inBand = 0
    band = 0
  }
  for (const shard of shards) {
    if (cells.length > 0 && cells.length >= pageLimit) flushPage()
    const wrapsBand = x > usable.left && (x + shard.width > usable.right || inBand >= bandLimit)
    if (wrapsBand) {
      x = usable.left
      y += bandHeight + o.moduleGap
      bandHeight = 0
      inBand = 0
      band += 1
    }
    if (cells.length > 0 && y + shard.height > usable.bottom) flushPage()
    const placed = new Map<string, SchematicPoint>()
    for (const [id, point] of shard.positions) placed.set(id, { x: snap(point.x + x, o.grid), y: snap(point.y + y, o.grid) })
    cells.push({ key: shard.key, members: shard.members, positions: placed, width: shard.width, height: shard.height, band })
    x += shard.width + o.moduleGap
    bandHeight = Math.max(bandHeight, shard.height)
    inBand += 1
  }
  pages.push(cells)
  return pages
}

function planPaginated(sheet: SchematicIrSheet, zone: SheetZone, o: ResolvedLayoutOptions, usable: PageRect): SheetPlan[] {
  // Pagination may use a tighter column pitch than the one-page ladder: pages
  // exist to be readable, and 300 units still leaves 180 between symbol
  // bodies. Pin pitch is deliberately untouched so symbols keep their size.
  const pag: ResolvedLayoutOptions = {
    ...o,
    columnPitch: Math.max(MIN_COLUMN_PITCH, snap(o.columnPitch * 0.75, o.grid)),
  }
  const halfHeightOf = halfHeightsOf(sheet.components, zone.sidesOf, pag.pinPitch, pag.grid)
  const usableWidth = usable.right - usable.left
  const usableHeight = usable.bottom - usable.top
  const shards: Shard[] = []
  for (const [key, members] of zone.orderedGroups) {
    shards.push(...shardGroup(key, members, pag, halfHeightOf, usableWidth, usableHeight))
  }

  // Rebalance the bands before placing: a width-greedy pack puts four modules
  // on the first A3 band and leaves the fifth alone on a nearly empty sheet.
  // Spreading them over the same number of bands (ceil(N / capacity)) keeps the
  // page count and gives every page a usable share of the content.
  const capacity = bandCapacity(shards, usable, o.moduleGap)
  const bandCount = Math.max(1, Math.ceil(shards.length / capacity))
  const bandLimit = o.moduleColumns ?? Math.max(1, Math.ceil(shards.length / bandCount))
  // A page that leaves a partial last page would otherwise ship 4 + 1, which
  // the distribution rule rejects even though every page is dense. Measure the
  // greedy page count, then cap each page at an even share (3 + 2). If the even
  // share needs more pages than greedy, keep greedy: balance must not cost a
  // page.
  const greedy = packShards(shards, usable, o, bandLimit, Number.POSITIVE_INFINITY)
  const pageLimit = Math.ceil(shards.length / greedy.length)
  const packed = packShards(shards, usable, o, bandLimit, pageLimit)
  const pages = (packed.length <= greedy.length ? packed : greedy)
    .map(pageCells => centreBands(pageCells, o))

  // Fit underfilled pages to their content, then centre each page inside its
  // own sheet. A page that carries a single module on a wide A3 sheet otherwise
  // hugs the top-left corner of a large empty frame, while the reference
  // project keeps its modules near the page centre. Only planned cell positions
  // move: routing, module frames, and pin endpoints are derived from them
  // afterwards, so the whole page shifts together.
  const framed = (sheet.blocks?.length ?? 0) > 0 || sheet.components.some(component => component.block !== undefined)
  const edgePad = o.pageSize.width - usable.right
  const boxes = pages.map(pageCells => pageContentBox(pageCells, framed))
  const tightBoxes = pages.map(pageCells => pageContentBox(pageCells, framed, true))
  // Only module-grouped sheets are fitted: a flat sheet is a simple drawing
  // that keeps the frame its caller asked for (A4 for small sheets). The
  // decision uses the tight (symbol) box, which is the density the delivered
  // drawing is judged on, while the size uses the outward box so the frame and
  // its routing still fit on the converged sheet.
  const fittedSizes = boxes.map((box, index) =>
    framed ? fitPageSize(tightBoxes[index]!, box, o, edgePad) : o.pageSize)
  for (const [index, pageCells] of pages.entries()) {
    const size = fittedSizes[index] as SchematicPageSize
    const box = boxes[index]
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const cell of pageCells) {
      for (const point of cell.positions.values()) {
        minX = Math.min(minX, point.x)
        maxX = Math.max(maxX, point.x)
        minY = Math.min(minY, point.y)
        maxY = Math.max(maxY, point.y)
      }
    }
    // A fitted sheet keeps the drawing margin at the top but centres its outward
    // box across the delivered width: the box already carries the frame padding,
    // so equal side margins are what the reference sheet looks like. A planned
    // sheet centres the content inside the usable rect.
    const dx = box === undefined || size === o.pageSize
      ? snap((o.margin.x + size.width - edgePad - minX - maxX) / 2, o.grid)
      : snap((size.width - (box.x2 - box.x1)) / 2 - box.x1, o.grid)
    const dy = box === undefined || size === o.pageSize
      ? snap((o.margin.y + size.height - edgePad - minY - maxY) / 2, o.grid)
      : snap(FITTED_MARGIN - box.y1, o.grid)
    pages[index] = pageCells.map(cell => ({
      ...cell,
      positions: new Map([...cell.positions].map(([id, point]) => [id, { x: point.x + dx, y: point.y + dy }])),
    }))
  }

  // Count the pages each module appears on so a split frame is numbered.
  const pageCount = new Map<string, number>()
  for (const pageCells of pages) {
    for (const key of new Set(pageCells.map(cell => cell.key))) {
      if (key !== '') pageCount.set(key, (pageCount.get(key) ?? 0) + 1)
    }
  }
  const allOwners = new Set<string>()
  for (const pageCells of pages) {
    for (const cell of pageCells) {
      for (const member of cell.members) {
        allOwners.add(member.id)
        for (const pin of member.pins) allOwners.add(`${member.id}${pin.id}`)
      }
    }
  }
  const seen = new Map<string, number>()
  return pages.map((pageCells, index) => {
    const titles = new Map<string, string>()
    for (const key of new Set(pageCells.map(cell => cell.key))) {
      if (key === '') continue
      const total = pageCount.get(key) as number
      if (total <= 1) continue
      const ordinal = (seen.get(key) ?? 0) + 1
      seen.set(key, ordinal)
      const base = sheet.blocks?.find(block => block.name === key)?.title ?? key
      titles.set(key, `${base} (${ordinal}/${total})`)
    }
    const single = pages.length === 1
    return {
      sheet: single ? sheet : splitSheet(sheet, pageCells, index, titles, allOwners),
      options: fittedSizes[index] === o.pageSize ? o : { ...o, pageSize: fittedSizes[index] as SchematicPageSize },
      cells: pageCells,
    }
  })
}

/**
 * Plan one source sheet against the page frame: measure every module group's
 * span, then walk the degradation ladder — compress module/column spacing
 * until the grid fits one page; if it still overflows, paginate at default
 * spacing. Pagination shards each module into page-sized pieces, so a flat
 * sheet or a single oversized module no longer runs off the frame. Sheets
 * carrying authored geometry (explicit positions) or hierarchy primitives
 * (block/sheet components) keep their geometry and rely on
 * `OBJECT_OUT_OF_SHEET` instead.
 */
function planSheet(sheet: SchematicIrSheet, o: ResolvedLayoutOptions): SheetPlan[] {
  const authored = sheet.components.some(component =>
    component.position !== undefined || component.kind === 'block' || component.kind === 'sheet')
  const zone = zoneSheet(sheet)
  const framed = (sheet.blocks?.length ?? 0) > 0 || sheet.components.some(component => component.block !== undefined)
  const edgePad = framed ? PAGE_EDGE_FRAMED : PAGE_EDGE_FLAT
  const usable: PageRect = {
    left: o.margin.x,
    top: o.margin.y,
    right: o.pageSize.width - edgePad,
    bottom: o.pageSize.height - edgePad,
  }
  const columns = o.moduleColumns ?? Math.max(1, Math.ceil(Math.sqrt(Math.max(zone.orderedGroups.length, 1))))

  if (authored) {
    // Authored geometry is the caller's intent: keep the sheet together and
    // only fill the members that arrived without a position.
    return [{
      sheet,
      options: o,
      cells: planCells(sheet, zone, o, usable, chunkGroups(zone.orderedGroups, columns)),
    }]
  }
  if (zone.orderedGroups.length === 0) return [{ sheet, options: o, cells: [] }]

  const usableHeight = usable.bottom - usable.top
  const measure = (options: ResolvedLayoutOptions): { pages: PackedRow[][]; fits: boolean } => {
    const halfHeightOf = halfHeightsOf(sheet.components, zone.sidesOf, options.pinPitch, options.grid)
    const spans = zone.orderedGroups.map(([key, members]) =>
      placeGroup(members, { x: 0, y: 0 }, new Map(), halfHeightOf, options, usableHeight, key !== ''))
    const packed = packRows(zone.orderedGroups, spans, columns, usable, options.moduleGap)
    const stacked = packPages(packed.rows, usable, options.moduleGap)
    return { pages: stacked.pages, fits: packed.fits && stacked.fits }
  }

  for (const scale of SPACING_SCALES) {
    const options = compressSpacing(o, scale)
    const { pages, fits } = measure(options)
    if (!fits || pages.length !== 1) continue
    // Re-place with the real row offset so the delivered coordinates match the
    // plan; a row placed below the margin has less vertical room than the
    // single-page measurement assumed.
    const cells = planCells(sheet, zone, options, usable, pages[0] as PackedRow[])
    if (cellsFit(cells, usable)) return [{ sheet, options, cells }]
  }
  return planPaginated(sheet, zone, o, usable)
}

/**
 * Rewrite `block.sheetIndex` values after pagination. `sheetIndex` is a
 * document-wide ordinal, so a preceding sheet splitting into extra pages
 * shifts every later child. A block targets the first page a source sheet
 * produced: that page keeps the sheet's authored annotations (including the
 * interface netports), and the continuation pages remain reachable through
 * their numbered frames. An implicit block (no `sheetIndex`) whose designator,
 * net name, or id matched an authored sheet name is pinned to that sheet's
 * first page when the page was renamed, so a generated page name cannot break
 * the hierarchy. Ambiguous matches are left alone for the validator. Invalid
 * indices are left untouched for the validator.
 */
function remapBlockTargets(
  sheet: SchematicIrSheet,
  firstPageOfSheet: readonly number[],
  renamedTargets: ReadonlyMap<string, number>,
): SchematicIrSheet {
  let changed = false
  const components = sheet.components.map((component) => {
    if (component.kind !== 'block') return component
    if (component.sheetIndex !== undefined) {
      const target = firstPageOfSheet[component.sheetIndex]
      if (target === undefined || target === component.sheetIndex) return component
      changed = true
      return { ...component, sheetIndex: target }
    }
    const targets = new Set<number>()
    for (const name of [component.designator, component.netName, component.id]) {
      if (name === undefined) continue
      const target = renamedTargets.get(name)
      if (target !== undefined) targets.add(target)
    }
    if (targets.size !== 1) return component
    changed = true
    return { ...component, sheetIndex: [...targets][0] as number }
  })
  return changed ? { ...sheet, components } : sheet
}

/**
 * Lay out one IR document. The pass is pure and deterministic: identical input
 * produces identical output, and re-running on the result is a no-op. Each
 * source sheet is first planned against the page frame (`pageSize`, default
 * A4): the module grid compresses spacing before a page-sized split is
 * attempted; content that still does not fit is sharded along signal-flow
 * columns and packed onto additional sheets, so generated geometry stays
 * inside the frame even for a flat sheet or a single oversized module. A
 * module split across pages keeps its member `block` tags and numbers its
 * frame title `(n/m)`. Sheets with authored geometry keep it untouched.
 * @param ir - the parsed IR; geometry fields may be absent.
 * @param options - grid, spacing, page-size, and strategy tunables.
 * @returns the IR with positions, pin endpoints, and routing filled in.
 */
export function layoutSchematic(ir: SchematicIr, options: SchematicLayoutOptions = {}): SchematicIr {
  const o = resolveOptions(options)
  // Pagination runs before the net census so a net crossing a pagination
  // split is seen as multi-sheet and routes through net ports.
  const perSheet = ir.sheets.map(sheet => planSheet(sheet, o))
  const firstPageOfSheet: number[] = []
  let pageCount = 0
  for (const plans of perSheet) {
    firstPageOfSheet.push(pageCount)
    pageCount += plans.length
  }
  // Name every page. A page that carries exactly one module takes that module's
  // title (the reference project names pages CORE/POWER/DEVICE); a mixed or
  // ungrouped page keeps the authored sheet name and numbers its continuations.
  // Page-zero names are reserved up front so a continuation cannot steal the
  // name of another source sheet that is literally named `MAIN 2`.
  const pageZero: (string | undefined)[] = perSheet.map((plans, index) => {
    const authored = ir.sheets[index]?.name
    if (plans.length <= 1) return authored
    return pageModuleTitle(ir.sheets[index] as SchematicIrSheet, (plans[0] as SheetPlan).cells) ?? authored
  })
  // Names already claimed by an emitted page, plus the authored names of every
  // source sheet. No two pages may share a name, and a continuation must not
  // steal an authored name (a sheet literally named `MAIN 2`).
  const assigned = new Set<string>()
  const reserved = new Set<string>()
  for (const source of ir.sheets) if (source.name !== undefined) reserved.add(source.name)
  const plans = perSheet.flatMap((plansForSheet, sheetIndex) => {
    const authored = ir.sheets[sheetIndex]?.name
    return plansForSheet.map((plan, page) => {
      let name = page === 0 ? pageZero[sheetIndex] : undefined
      if (page === 0) {
        const base = name
        let ordinal = 2
        while (name !== undefined && assigned.has(name)) name = `${base} ${ordinal++}`
      } else {
        const module = pageModuleTitle(ir.sheets[sheetIndex] as SchematicIrSheet, plan.cells)
        if (module !== undefined) {
          name = module
          let ordinal = 2
          while (assigned.has(name)) name = `${module} ${ordinal++}`
        } else if (authored !== undefined) {
          let ordinal = page + 1
          while (assigned.has(`${authored} ${ordinal}`) || reserved.has(`${authored} ${ordinal}`)) ordinal += 1
          name = `${authored} ${ordinal}`
        }
      }
      let sheet = plan.sheet
      const fitted = plan.options.pageSize
      if (fitted.width !== o.pageSize.width || fitted.height !== o.pageSize.height) {
        sheet = { ...sheet, pageSize: fitted }
      }
      if (name !== undefined) {
        assigned.add(name)
        if (sheet.name !== name) sheet = { ...sheet, name }
      }
      return { ...plan, sheet }
    })
  })

  // A generated page name must not break a hierarchy binding that used the
  // authored name. Record which source sheets were renamed and where their
  // first page landed; ambiguous authored names stay unresolved so the
  // validator can still report the ambiguity.
  const renamedTargets = new Map<string, number>()
  const duplicatedNames = new Set<string>()
  for (const [index, source] of ir.sheets.entries()) {
    const name = source.name
    if (name === undefined) continue
    const firstPage = firstPageOfSheet[index] as number
    if (plans[firstPage]?.sheet.name === name) continue
    if (renamedTargets.has(name)) duplicatedNames.add(name)
    else renamedTargets.set(name, firstPage)
  }
  for (const name of duplicatedNames) renamedTargets.delete(name)

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

  return {
    sheets: plans.map(plan => layoutSheet({
      ...plan,
      sheet: remapBlockTargets(plan.sheet, firstPageOfSheet, renamedTargets),
    }, netSheets)),
  }
}

/** Place, endpoint, and route one planned sheet. */
function layoutSheet(plan: SheetPlan, netSheets: ReadonlyMap<string, Set<number>>): SchematicIrSheet {
    const { sheet } = plan
    const o = plan.options
    const zone = zoneSheet(sheet)
    const { annotation, groups, blockOf, sidesOf } = zone
    const halfHeightOf = halfHeightsOf(sheet.components, sidesOf, o.pinPitch, o.grid)

    // Planned cells are authoritative: the coordinates computed while sizing
    // the page are the coordinates delivered, so planning and emission cannot
    // drift apart. Authored positions win over planned ones.
    const positions = new Map<string, SchematicPoint>()
    for (const component of sheet.components) {
      if (component.position !== undefined) positions.set(component.id, component.position)
    }
    for (const cell of plan.cells) {
      for (const [id, point] of cell.positions) {
        if (!positions.has(id)) positions.set(id, point)
      }
    }

    const framed = (sheet.blocks?.length ?? 0) > 0 || sheet.components.some(component => component.block !== undefined)
    const edgePad = framed ? PAGE_EDGE_FRAMED : PAGE_EDGE_FLAT
    // Flags, ports, and annotations are placed after pagination, so they clamp
    // to the sheet this page is actually delivered on — a fitted sheet is
    // smaller than the planned frame and would otherwise let them spill off it.
    const pageSize = plan.options.pageSize
    const rightEdge = pageSize.width - edgePad
    const bottomEdge = pageSize.height - edgePad
    const inFrame = (p: SchematicPoint): boolean =>
      p.x >= 0 && p.x <= pageSize.width && p.y >= 0 && p.y <= pageSize.height
    const clampFrame = (p: SchematicPoint): SchematicPoint => ({
      x: Math.min(Math.max(p.x, 0), pageSize.width),
      y: Math.min(Math.max(p.y, 0), pageSize.height),
    })

    let annotationX = o.margin.x
    for (const cell of plan.cells) {
      for (const point of cell.positions.values()) annotationX = Math.max(annotationX, point.x + BODY_HALF_WIDTH)
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
    const nets = new Map<string, NetMember[]>()
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

    /**
     * A declaration-only row of wire kind: an authored wire whose geometry
     * pagination stripped (or that never had any). Only such a row may be
     * refilled with regenerated geometry; rewriting a `kind: 'bus'` row into a
     * wire would change what the builder creates.
     */
    const isDeclarableWire = (wire: SchematicIrWire): boolean =>
      wire.kind === 'wire' && (wire.dots === undefined || wire.dots.length === 0)

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
    // A bus entry is a wiring primitive too: the validator unions its point
    // with whatever it touches, so a generated segment through it would merge
    // the segment's net with the bus. Own it as a bus-scoped point (never equal
    // to a member net) so it always counts as foreign.
    for (const entry of sheet.busEntries) occupy(entry.point, `bus:${entry.id}`)

    // Approximate symbol bodies. The library exposes no body geometry, so the
    // declared pin count and the fixed outline width bound it; a generated
    // flag may not land inside a body (routing only checks foreign points, and
    // a flag dropped into a neighbouring symbol is visually unreadable even
    // when it is electrically legal).
    const bodyRects = laid
      .filter(component => component.source.kind === 'part')
      .map(component => {
        const half = halfHeightOf.get(component.source.id) as number
        return {
          left: component.position.x - BODY_HALF_WIDTH,
          right: component.position.x + BODY_HALF_WIDTH,
          top: component.position.y - half,
          bottom: component.position.y + half,
        }
      })
    const insideBody = (point: SchematicPoint): boolean =>
      bodyRects.some(body =>
        point.x > body.left + 10 && point.x < body.right - 10
        && point.y > body.top + 10 && point.y < body.bottom - 10)

    // Two power/ground nets whose pins share a column compete for the same
    // routing lane: a bus for one would cut the other's only way out (its pins
    // face the same side, and going the other way crosses the symbol). Only
    // aggregate a run when its column belongs to a single power net.
    const powerNetByX = new Map<string, string>()
    const contendedX = new Set<string>()
    for (const [name, members] of nets) {
      if (!isPowerNet(name) && !isGroundNet(name) && !members.some(member => member.pin.powerName !== undefined)) continue
      for (const member of members) {
        const key = `${member.pin.endpoint.x}`
        const owner = powerNetByX.get(key)
        if (owner === undefined) powerNetByX.set(key, name)
        else if (owner !== name) contendedX.add(key)
      }
    }

    for (const net of [...nets.keys()].sort()) {
      const members = nets.get(net) as NetMember[]
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
      /** Existing wires of other nets: a new segment must not touch or cross them. */
      const foreignWires = wires.filter(wire => wire.net !== net && wire.dots !== undefined)
      /** Whether any generated segment touches another net's point or wire. */
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
        || foreignWires.some((wire) => {
          for (const chain of wire.dots as readonly (readonly number[])[]) {
            for (let j = 0; j + 3 < chain.length; j += 2) {
              const c: SchematicPoint = { x: chain[j] as number, y: chain[j + 1] as number }
              const d: SchematicPoint = { x: chain[j + 2] as number, y: chain[j + 3] as number }
              for (const seg of dots) {
                for (let i = 0; i + 3 < seg.length; i += 2) {
                  const a: SchematicPoint = { x: seg[i] as number, y: seg[i + 1] as number }
                  const b: SchematicPoint = { x: seg[i + 2] as number, y: seg[i + 3] as number }
                  if (segmentsTouch(a, b, c, d)) return true
                }
              }
            }
          }
          return false
        })
        || dots.some((seg) => {
          for (let i = 0; i + 3 < seg.length; i += 2) {
            const a: SchematicPoint = { x: seg[i] as number, y: seg[i + 1] as number }
            const b: SchematicPoint = { x: seg[i + 2] as number, y: seg[i + 3] as number }
            if (bodyRects.some(body => segmentCrossesRect(a, b, body, o.pinStub))) return true
          }
          return false
        })

      const routeWithFlags = (): void => {
        // Flag strategy: every unrouted member gets a short stub and a flag of
        // the same name; flags merge by name, so no trunk is needed. Members
        // that line up on one axis (a column of power pins, a row of signal
        // pins) share one bus and one flag instead of one flag each. Ground
        // hangs above its pin, power below it, and other nets reach outward
        // from the pin's side. A stub that passes through a foreign point, a
        // foreign wire, or a symbol body would merge or hide a net, so the flag
        // tries the mirrored direction, then an elbow, before giving up.
        const flagKind = crossSheet ? 'netport' : 'netflag'
        const stubDots: number[][] = []
        const vertical = isGroundNet(net) || powerClass
        const ground = isGroundNet(net)
        const pending: NetMember[] = []
        // A high-fanout signal net (a clock or reset reaching many receivers on
        // the same side) shares a tapped bus and one flag just like a power
        // column; that is where per-pin flags hurt most. A low-fanout signal
        // keeps one flag per pin: a bus would trade a flag for wire without
        // meaningfully reducing the count.
        const aggregateSignals = !vertical && unrouted.length >= o.flagFanout
        if (vertical || aggregateSignals) {
          // Members stacked in one column share one bus and one flag. The bus
          // runs outside the pin column and every member taps it with a short
          // stub, so the bus never crosses the symbol's other pins. The
          // immediate flag lane may already hold single-pin stubs or signal
          // flags, so the bus steps outward one lane at a time until a clear
          // lane is found.
          const runs = new Map<string, NetMember[]>()
          for (const member of unrouted) {
            const key = `${member.pin.endpoint.x}`
            const run = runs.get(key) ?? []
            run.push(member)
            runs.set(key, run)
          }
          for (const key of [...runs.keys()].sort((a, b) => Number(a) - Number(b))) {
            // Members in a run share their x, so y alone orders the taps.
            const run = (runs.get(key) as NetMember[]).sort((a, b) => a.pin.endpoint.y - b.pin.endpoint.y)
            const first = run[0] as NetMember
            if (run.length < 2 || contendedX.has(key)) {
              pending.push(...run)
              continue
            }
            const outward = first.side === 'left' ? -1 : 1
            let minY = Infinity
            let maxY = -Infinity
            for (const member of run) {
              minY = Math.min(minY, member.pin.endpoint.y)
              maxY = Math.max(maxY, member.pin.endpoint.y)
            }
            let chosen: { dots: number[][]; flagPosition: SchematicPoint } | undefined
            // Coarse grids can map two nominal lanes onto one coordinate; keep
            // the first occurrence so the outward search stays monotone.
            const laneXs = new Set([1, 2, 3].map(lane =>
              snap(first.pin.endpoint.x + outward * lane * FLAG_STUB, o.grid)))
            for (const busX of laneXs) {
              const snapped = snap(ground ? minY - FLAG_STUB : maxY + FLAG_STUB, o.grid)
              const flagPosition: SchematicPoint = {
                x: busX,
                // The bus must reach past the outermost tap. A coarse grid can
                // round the offset flag end back inside the run, which would
                // leave that member's stub floating while a junction is still
                // emitted; clamp the flag end to the tap extreme.
                y: ground ? Math.min(snapped, minY) : Math.max(snapped, maxY),
              }
              const dots: number[][] = run.map(member =>
                [member.pin.endpoint.x, member.pin.endpoint.y, busX, member.pin.endpoint.y])
              dots.push([busX, ground ? flagPosition.y : minY, busX, ground ? maxY : flagPosition.y])
              if (inFrame(flagPosition) && !insideBody(flagPosition) && !collides(dots)) {
                chosen = { dots, flagPosition }
                break
              }
            }
            if (chosen === undefined) {
              pending.push(...run)
              continue
            }
            for (const member of run) {
              addJunction({ x: chosen.flagPosition.x, y: member.pin.endpoint.y })
            }
            stubDots.push(...chosen.dots)
            occupy(chosen.flagPosition, net)
            components.push({
              id: `layout:flag:${idPart(net)}:bus:${key}`,
              kind: flagKind,
              netName: net,
              position: chosen.flagPosition,
              pins: [],
            })
          }
        } else {
          pending.push(...unrouted)
        }
        pending.forEach((member, index) => {
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
            const mirrored: SchematicPoint = vertical
              ? { x: direct.x, y: snap(2 * endpoint.y - direct.y, o.grid) }
              : { x: snap(2 * endpoint.x - direct.x, o.grid), y: direct.y }
            flagPosition = inFrame(mirrored) ? mirrored : clampFrame(direct)
          }
          const candidates: SchematicPoint[] = [flagPosition]
          const outward = member.side === 'left' ? -1 : 1
          if (vertical) {
            // The straight mirror is the cleanest fallback. When sibling pins
            // stacked on the same side block both straight directions, step
            // outward first and then up/down: the stub becomes an elbow that
            // clears the pin column instead of pushing a perpendicular flag
            // through the symbol body.
            candidates.push({ x: direct.x, y: snap(2 * endpoint.y - direct.y, o.grid) })
            const outwardX = snap(endpoint.x + outward * FLAG_STUB, o.grid)
            candidates.push(
              { x: outwardX, y: flagPosition.y },
              { x: outwardX, y: snap(2 * endpoint.y - flagPosition.y, o.grid) },
            )
            candidates.push(
              { x: snap(endpoint.x + FLAG_STUB, o.grid), y: endpoint.y },
              { x: snap(endpoint.x - FLAG_STUB, o.grid), y: endpoint.y },
            )
          } else {
            candidates.push({ x: snap(2 * endpoint.x - direct.x, o.grid), y: direct.y })
            // Same elbow idea for a horizontal flag: stay on the outward
            // column, then offset vertically instead of pushing the flag
            // through the symbol.
            candidates.push(
              { x: direct.x, y: snap(endpoint.y - FLAG_STUB, o.grid) },
              { x: direct.x, y: snap(endpoint.y + FLAG_STUB, o.grid) },
            )
            candidates.push(
              { x: endpoint.x, y: snap(endpoint.y - FLAG_STUB, o.grid) },
              { x: endpoint.x, y: snap(endpoint.y + FLAG_STUB, o.grid) },
            )
          }
          const fits = (candidate: SchematicPoint, bodyFree: boolean): boolean =>
            inFrame(candidate)
            && (!bodyFree || !insideBody(candidate))
            && !collides([lPath(endpoint, candidate)])
          // First choice clears the body too. Only a pin that is itself out of
          // frame may overlap a body estimate (its symbol is clipped by the page
          // edge, so a body-free spot can be unreachable); an in-frame pin falls
          // through to the no-stub fallback below instead of hiding a flag
          // inside a symbol.
          const clear = candidates.find(candidate => fits(candidate, true))
            ?? (inFrame(endpoint) ? undefined : candidates.find(candidate => fits(candidate, false)))
          // Last resort: the flag sits on the pin itself with no stub. A stub
          // into a blocked lane would merge two nets, and clamping onto an
          // unchecked frame coordinate can land on a foreign flag: a crowded
          // flag is the only safe outcome left.
          flagPosition = clear ?? endpoint
          if (endpoint.x !== flagPosition.x || endpoint.y !== flagPosition.y) {
            stubDots.push(lPath(endpoint, flagPosition))
            if (endpoint.x !== flagPosition.x && endpoint.y !== flagPosition.y) {
              occupy({ x: flagPosition.x, y: endpoint.y }, net)
            }
          }
          occupy(flagPosition, net)
          components.push({
            id: `layout:flag:${idPart(net)}:${index}`,
            kind: flagKind,
            netName: net,
            position: flagPosition,
            pins: [],
          })
        })
        if (stubDots.length > 0) {
          // Prefer the page's declared net-only row (an authored wire whose
          // geometry pagination stripped): filling it keeps the wire id, its
          // ATTR, and its net in one primitive instead of leaving an empty row
          // the builder would have to skip.
          const declared = carrying.find(isDeclarableWire)
          if (declared !== undefined) {
            wires[wires.indexOf(declared)] = { ...declared, dots: stubDots }
          } else {
            wires.push({ id: `layout:wire:${idPart(net)}:flags`, kind: 'wire', dots: stubDots, net })
          }
        }
      }

      if (useFlags) {
        routeWithFlags()
        continue
      }

      // A declared bus row is not a wire carrier: appending L-stubs to it would
      // ship a BUS primitive while the validator sees connected wires (the
      // client draws a bus, the pins never join it). Fall through to a fresh
      // wire row instead.
      const carrier = carrying.find(wire =>
        wire.kind === 'wire' && wire.dots !== undefined && wire.dots.length > 0)
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
      const declared = carrying.find(isDeclarableWire)
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
