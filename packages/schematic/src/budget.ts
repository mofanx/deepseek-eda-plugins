/**
 * Delivery budget for schematic sheets: every number the page fit and the
 * acceptance regression are judged by (docs §14.2). This module is the single
 * source of truth — the layout fits pages with it and the regression measures
 * them with it, so the two cannot drift apart (the t7 rule restated these
 * constants inside the test, which is exactly the drift risk t8 flagged).
 * @module @deepseek-ai/dsh-plugin-eda-sch/budget
 */

import type { SchematicPageSize } from './types.ts'

/** Axis-aligned rectangle in sheet units, y growing downwards. */
export interface SchematicContentBox {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

/**
 * The delivery budget. `fillTarget` is the coverage a delivered page must
 * reach; a page below it is only acceptable when it already sits on the
 * smallest sheet the budget allows for its content and that sheet still cannot
 * reach the target — and never below `fillFloor`, the point where a sheet is
 * more empty than drawn.
 */
export const SCHEMATIC_PAGE_BUDGET = Object.freeze({
  /** Coverage every delivered page must reach, or prove its shape cannot. */
  fillTarget: 0.35,
  /** Hard lower bound: below this the sheet is more empty than drawn. */
  fillFloor: 0.25,
  /**
   * Edge allowance inside a framed sheet (right and bottom). The title block is
   * five rows (130 units) tall, so on A4 it reaches up to y=679 and the framed
   * content bound sits at 825−170=655, leaving 24 units of clearance.
   */
  edgePadFramed: 170,
  /** Edge allowance for flat sheets: pin stub plus generated flag stub. */
  edgePadFlat: 80,
  /**
   * Drawing margin a fitted sheet keeps around its outward content box. The
   * framed edge allowance is only needed where the title block sits, so a small
   * drawing margin keeps the fitted sheet dense instead of padding it
   * symmetrically.
   */
  fittedMargin: 60,
  /**
   * Outward extent of everything the serializer draws around a planned cell:
   * the symbol body plus pin stub, then the module frame pad, then the net port
   * or flag routed past the pin endpoint. The fit box has to cover all of it,
   * or a fitted sheet clips its own routing.
   */
  outwardX: 180,
  outwardTop: 200,
  outwardBottom: 140,
  /** Smallest fitted sheet: the title block is 560 wide and 146 tall. */
  minFittedWidth: 592,
  minFittedHeight: 300,
  /** Placement grid. */
  grid: 10,
  /** Gap between functional-module cells in the placement grid. */
  moduleGap: 200,
})

/** Round to the placement grid. The layout's `snap` is this function. */
export function snapToGrid(value: number, grid: number = SCHEMATIC_PAGE_BUDGET.grid): number {
  return Math.round(value / grid) * grid
}

/**
 * Smallest sheet the budget allows for a content box: the box plus the fitted
 * margin and the framed edge allowance, clamped to the planned frame and never
 * smaller than the sheet the title block still fits on. A page delivered at
 * this size is as tight as the budget can make it — that is the condition under
 * which a page below {@link SCHEMATIC_PAGE_BUDGET.fillTarget} is judged on its
 * shape rather than on its pagination.
 */
export function fittedPageSize(
  box: SchematicContentBox,
  planned: SchematicPageSize,
  grid: number = SCHEMATIC_PAGE_BUDGET.grid,
  edgePad: number = SCHEMATIC_PAGE_BUDGET.edgePadFramed,
): SchematicPageSize {
  const b = SCHEMATIC_PAGE_BUDGET
  return {
    width: Math.min(planned.width, Math.max(b.minFittedWidth, snapToGrid(box.x2 - box.x1 + b.fittedMargin + edgePad, grid))),
    height: Math.min(planned.height, Math.max(b.minFittedHeight, snapToGrid(box.y2 - box.y1 + b.fittedMargin + edgePad, grid))),
  }
}

/**
 * Coverage of a content box on a sheet: the delivery fill ratio both the
 * regression and the evidence scripts report (docs §14.2).
 */
/**
 * Outward box of a set of anchor points: the box the fit budget is applied to.
 * The layout fits pages with the outward box (anchors plus the routing
 * allowance), so a rule that measured the *ink* box and then fitted that would
 * compute a minimum smaller than the page the layout can actually deliver.
 */
export function outwardContentBox(points: readonly { readonly x: number; readonly y: number }[]): SchematicContentBox {
  const b = SCHEMATIC_PAGE_BUDGET
  let x1 = Number.POSITIVE_INFINITY
  let y1 = Number.POSITIVE_INFINITY
  let x2 = Number.NEGATIVE_INFINITY
  let y2 = Number.NEGATIVE_INFINITY
  for (const point of points) {
    x1 = Math.min(x1, point.x)
    y1 = Math.min(y1, point.y)
    x2 = Math.max(x2, point.x)
    y2 = Math.max(y2, point.y)
  }
  if (!Number.isFinite(x1)) return { x1: 0, y1: 0, x2: 0, y2: 0 }
  return { x1: x1 - b.outwardX, y1: y1 - b.outwardTop, x2: x2 + b.outwardX, y2: y2 + b.outwardBottom }
}

export function contentCoverage(box: SchematicContentBox, size: SchematicPageSize): number {
  return ((box.x2 - box.x1) * (box.y2 - box.y1)) / (size.width * size.height)
}
