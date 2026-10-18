/**
 * The delivery fill metric: how much of the sheet a page actually draws on.
 * One function, one definition, used by the acceptance regression and by any
 * evidence script — the t9 review found the same tail page reported as 30.8%,
 * 33.2%, and 40.0% because three different boxes were in play, and a target of
 * 35% straddles that spread, so the metric has to be named and fixed.
 *
 * The box is the bounding box of everything the page draws — module frames,
 * component bodies, pin endpoints — over the area of the sheet the page is
 * delivered on. That is the same *kind* of measurement as the reference
 * capture's pixel metric (`content ink bbox area / page area`, see
 * `docs/evidence/review/fill-measure.json`), so the two are comparable; the
 * reference masks its title block out of the content region, and this box
 * excludes the page frame and title block by construction because neither is
 * content geometry.
 * @module @deepseek-ai/dsh-plugin-eda-core/measure
 */

import type { SchematicIrSheet, SchematicPageSize } from '@deepseek-ai/dsh-plugin-eda-sch'
import { computeBlockFrames } from './blocks.ts'

/** Axis-aligned rectangle in sheet units (top-left origin, y downwards). */
export interface SchematicInkBox {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

/** Delivery measurement of one page. */
export interface SchematicPageFill {
  /** Sheet the page is delivered on (`sheet.pageSize` when the layout fitted it). */
  readonly pageSize: SchematicPageSize
  /** Whether the page converged onto its own content instead of the planned frame. */
  readonly fitted: boolean
  /** Bounding box of the drawn content, in sheet units. */
  readonly box: SchematicInkBox
  /** `box` area over the delivered sheet area, in `[0, 1]`. */
  readonly fill: number
}

/**
 * Measure one laid-out page with the delivery metric.
 * @param sheet - a laid-out sheet (positions and pin endpoints assigned).
 * @param planned - the frame the caller asked for, used when the page was not fitted.
 * @returns the delivered size, the ink box, and its coverage.
 */
export function measurePageFill(sheet: SchematicIrSheet, planned: SchematicPageSize): SchematicPageFill {
  const pageSize = sheet.pageSize ?? planned
  let x1 = Number.POSITIVE_INFINITY
  let y1 = Number.POSITIVE_INFINITY
  let x2 = Number.NEGATIVE_INFINITY
  let y2 = Number.NEGATIVE_INFINITY
  const grow = (ax: number, ay: number, bx: number, by: number): void => {
    x1 = Math.min(x1, ax)
    y1 = Math.min(y1, ay)
    x2 = Math.max(x2, bx)
    y2 = Math.max(y2, by)
  }
  // Module frames are clamped to the sheet and kept off the title block by
  // their own geometry, so they are the outer edge of the drawing.
  for (const frame of computeBlockFrames(sheet, pageSize)) {
    grow(frame.x, frame.y, frame.x + frame.width, frame.y + frame.height)
  }
  for (const component of sheet.components) {
    const position = component.position
    if (position === undefined) continue
    grow(position.x, position.y, position.x, position.y)
    for (const pin of component.pins) {
      const endpoint = pin.endpoint
      if (endpoint === undefined) continue
      grow(endpoint.x, endpoint.y, endpoint.x, endpoint.y)
    }
  }
  if (!Number.isFinite(x1) || !Number.isFinite(y1)) {
    const empty = { x1: 0, y1: 0, x2: 0, y2: 0 }
    return { pageSize, fitted: sheet.pageSize !== undefined, box: empty, fill: 0 }
  }
  const box = { x1, y1, x2, y2 }
  return {
    pageSize,
    fitted: sheet.pageSize !== undefined,
    box,
    fill: ((x2 - x1) * (y2 - y1)) / (pageSize.width * pageSize.height),
  }
}
