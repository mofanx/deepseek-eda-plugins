/**
 * Sheet-symbol graphics for `kind: 'block'` components: the labelled box an
 * EasyEDA projection draws on the parent page, with one pin-name label per
 * interface pin. The drawings are non-electrical — a block component has no
 * library binding the client could render, the child's same-named `netport`
 * components carry the interface across pages — so the records never join
 * the netlist diff or the component-count oracle.
 * @module @deepseek-ai/dsh-plugin-eda-core/hierarchy
 */

import type { SchematicIrComponent, SchematicIrSheet, SchematicPoint } from '@deepseek-ai/dsh-plugin-eda-sch'

/** One pin-name label inside a sheet-symbol box, in IR sheet coordinates. */
export interface EasyEdaSheetSymbolPin {
  readonly pinId: string
  /** Label text: `name`, then `net`, then `number`. */
  readonly name: string
  /** Label anchor; sits `LABEL_INSET` inside the box edge the pin touches. */
  readonly x: number
  readonly y: number
  /** Horizontal anchor emitted into the TEXT record's `align` field. */
  readonly align: 'LEFT_TOP' | 'RIGHT_TOP'
}

/** The drawn box for one `kind: 'block'` component, in IR sheet coordinates. */
export interface EasyEdaSheetSymbolBox {
  readonly componentId: string
  /** Box title: `designator`, then `netName`, then the component id. */
  readonly title: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly titleX: number
  readonly titleY: number
  readonly pins: readonly EasyEdaSheetSymbolPin[]
}

const GRID = 10
/** Headroom inside the box reserved for the title text. */
const TITLE_HEADROOM = 40
const BODY_PAD = 10
const LABEL_INSET = 8
const MIN_WIDTH = 60
const MIN_HEIGHT = 60
/** Vertical spacing for endpoint-less pins stacked on the left edge. */
const PIN_STEP = 30

/**
 * Compute the drawn box for every `kind: 'block'` component on the sheet.
 * The outermost pin endpoints land on the box edges so wires terminate
 * flush; pins are labelled inside the nearer edge in declaration order,
 * endpoint-less pins stacked down the left edge.
 * @param sheet - the laid-out sheet.
 * @returns one box per block component, in component declaration order.
 */
export function computeSheetSymbolBoxes(sheet: SchematicIrSheet): readonly EasyEdaSheetSymbolBox[] {
  const boxes: EasyEdaSheetSymbolBox[] = []
  for (const component of sheet.components) {
    if (component.kind !== 'block') continue
    boxes.push(boxOf(component))
  }
  return boxes
}

function boxOf(component: SchematicIrComponent): EasyEdaSheetSymbolBox {
  const title = component.designator ?? component.netName ?? component.id
  const placed = component.pins
    .map((pin, index) => ({ pin, index, endpoint: pin.endpoint }))
    .filter((entry): entry is { pin: SchematicIrComponent['pins'][number]; index: number; endpoint: SchematicPoint } => entry.endpoint !== undefined)

  let x1: number
  let x2: number
  let y1: number
  let y2: number
  if (placed.length === 0) {
    const { x = 0, y = 0 } = component.position ?? {}
    x1 = Math.floor(x / GRID) * GRID
    x2 = x1 + MIN_WIDTH
    y1 = Math.floor(y / GRID) * GRID
    y2 = y1 + TITLE_HEADROOM + MIN_HEIGHT
  } else {
    const minX = Math.min(...placed.map(e => e.endpoint.x))
    const maxX = Math.max(...placed.map(e => e.endpoint.x))
    const minY = Math.min(...placed.map(e => e.endpoint.y))
    const maxY = Math.max(...placed.map(e => e.endpoint.y))
    // Edges track the endpoint span exactly so the extreme pins sit on the
    // box outline; degenerate spans widen away from the placed edge.
    x1 = minX
    x2 = maxX === minX ? minX + MIN_WIDTH : maxX
    y1 = minY - TITLE_HEADROOM
    y2 = maxY === minY ? minY + MIN_HEIGHT - TITLE_HEADROOM : maxY + BODY_PAD
  }

  const pins: EasyEdaSheetSymbolPin[] = []
  const unplaced = component.pins
    .map((pin, index) => ({ pin, index, endpoint: pin.endpoint }))
    .filter(entry => entry.endpoint === undefined)
  for (const { pin, endpoint } of placed) {
    const side = endpoint.x - x1 <= x2 - endpoint.x ? 'left' : 'right'
    pins.push({
      pinId: pin.id,
      name: pin.name ?? pin.net ?? pin.number ?? pin.id,
      x: side === 'left' ? x1 + LABEL_INSET : x2 - LABEL_INSET,
      y: endpoint.y,
      align: side === 'left' ? 'LEFT_TOP' : 'RIGHT_TOP',
    })
  }
  for (const [slot, { pin }] of unplaced.entries()) {
    pins.push({
      pinId: pin.id,
      name: pin.name ?? pin.net ?? pin.number ?? pin.id,
      x: x1 + LABEL_INSET,
      y: y1 + TITLE_HEADROOM + BODY_PAD + slot * PIN_STEP,
      align: 'LEFT_TOP',
    })
  }
  return {
    componentId: component.id,
    title,
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
    titleX: x1 + LABEL_INSET,
    titleY: y1 + BODY_PAD,
    pins,
  }
}
