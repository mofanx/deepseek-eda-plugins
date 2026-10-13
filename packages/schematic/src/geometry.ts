/**
 * Symbol-geometry helpers shared by the layout stage and the validator: the
 * transform that maps a symbol-local pin offset onto the sheet under the
 * component's `rotation`/`mirror`.
 * @module @deepseek-ai/dsh-plugin-eda-sch/geometry
 */

import type { SchematicPoint } from './types.ts'

/**
 * Apply a component transform to a symbol-local point: `mirror` is a
 * horizontal flip (x negated) applied first, then `rotation` turns
 * counterclockwise in sheet space. Coordinates round to integers.
 * @param point - the symbol-local offset (e.g. a {@link SchematicSymbolPin}'s `x`/`y`).
 * @param rotation - the component's rotation in degrees; `undefined` or `0` is identity.
 * @param mirror - the component's mirror flag; `undefined` or `false` is identity.
 * @returns the transformed sheet-space offset.
 */
export function transformSymbolPoint(
  point: SchematicPoint,
  rotation: number | undefined,
  mirror: boolean | undefined,
): SchematicPoint {
  const x = mirror === true ? -point.x : point.x
  if (rotation === undefined || rotation === 0) return { x, y: point.y }
  const rad = (rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: Math.round(x * cos - point.y * sin),
    y: Math.round(x * sin + point.y * cos),
  }
}
