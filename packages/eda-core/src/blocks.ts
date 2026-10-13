/**
 * Functional-module frame geometry: the labelled bounding box an EasyEDA
 * projection draws around one sheet `block` group. Pure over the laid-out IR —
 * member positions and pin endpoints carry the geometry, and the frames are
 * non-electrical decoration that never joins the netlist diff.
 * @module @deepseek-ai/dsh-plugin-eda-core/blocks
 */

import type { SchematicIrSheet } from '@deepseek-ai/dsh-plugin-eda-sch'

/** One module frame in IR sheet coordinates (top-left origin). */
export interface EasyEdaBlockFrame {
  /** Module name matching member `block` values. */
  readonly name: string
  /** Display title (`block.title` when declared, else the name). */
  readonly title: string
  /** Frame rectangle top-left corner. */
  readonly x: number
  readonly y: number
  /** Frame rectangle size. */
  readonly width: number
  readonly height: number
  /** Title anchor inside the frame's reserved headroom. */
  readonly titleX: number
  readonly titleY: number
}

const GRID = 10
/**
 * Margin beyond member geometry: covers the symbol body plus the 40-unit
 * stub a layout-generated flag hangs off an edge pin.
 */
const FRAME_PAD = 80
/** Headroom inside the frame reserved for the title text. */
const TITLE_HEADROOM = 60
const TITLE_INSET_X = 20
const TITLE_INSET_Y = 10

/**
 * Compute one labelled frame per module present on the sheet. Members are
 * components whose `block` names the module; the rectangle bounds their
 * positions and pin endpoints, padded and snapped outward to the grid, with
 * a title strip reserved above the top edge. Frame order mirrors the layout
 * stage: declared `blocks` first in declaration order, then free-form names
 * alphabetically.
 * @param sheet - the laid-out sheet (positions and pin endpoints assigned).
 * @returns the frames to draw, or an empty list when nothing is grouped.
 */
export function computeBlockFrames(sheet: SchematicIrSheet): readonly EasyEdaBlockFrame[] {
  const members = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>()
  for (const component of sheet.components) {
    if (component.block === undefined || component.position === undefined) continue
    const box = members.get(component.block) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    box.minX = Math.min(box.minX, component.position.x)
    box.minY = Math.min(box.minY, component.position.y)
    box.maxX = Math.max(box.maxX, component.position.x)
    box.maxY = Math.max(box.maxY, component.position.y)
    for (const pin of component.pins) {
      if (pin.endpoint === undefined) continue
      box.minX = Math.min(box.minX, pin.endpoint.x)
      box.minY = Math.min(box.minY, pin.endpoint.y)
      box.maxX = Math.max(box.maxX, pin.endpoint.x)
      box.maxY = Math.max(box.maxY, pin.endpoint.y)
    }
    members.set(component.block, box)
  }
  if (members.size === 0) return []
  const titleOf = new Map(sheet.blocks?.map(block => [block.name, block.title ?? block.name]) ?? [])
  const declaredOrder = new Map(sheet.blocks?.map((block, index) => [block.name, index]) ?? [])
  const names = [...members.keys()].sort((a, b) => {
    const ai = declaredOrder.get(a)
    const bi = declaredOrder.get(b)
    if (ai !== undefined && bi !== undefined) return ai - bi
    if (ai !== undefined) return -1
    if (bi !== undefined) return 1
    return a.localeCompare(b)
  })
  return names.map((name) => {
    const box = members.get(name) as { minX: number; minY: number; maxX: number; maxY: number }
    const x = Math.floor((box.minX - FRAME_PAD) / GRID) * GRID
    const y = Math.floor((box.minY - FRAME_PAD - TITLE_HEADROOM) / GRID) * GRID
    return {
      name,
      title: titleOf.get(name) ?? name,
      x,
      y,
      width: Math.ceil((box.maxX + FRAME_PAD) / GRID) * GRID - x,
      height: Math.ceil((box.maxY + FRAME_PAD) / GRID) * GRID - y,
      titleX: x + TITLE_INSET_X,
      titleY: y + TITLE_INSET_Y,
    }
  })
}
