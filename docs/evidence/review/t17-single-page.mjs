// t17: the single-page path never converged. A board that fits one planned
// sheet returned the planned frame untouched, so a lone module was delivered on
// a full 1655x1170 A3 page at ~30% fill — below the repo's own 35% target — while
// the same content shrank to its own sheet as soon as it paginated.
//
// Run from the repo root after `pnpm build` (reads packages/*/lib):
//   node docs/evidence/review/t17-single-page.mjs
//
// Fixture: 1 module (MCU), 12 two-pin parts, no authored geometry, A3 planned.
import { SCHEMATIC_PAGE_A3, SCHEMATIC_PAGE_BUDGET, layoutSchematic } from '../../../packages/schematic/lib/index.js'
import { computeBlockFrames, measurePageFill } from '../../../packages/eda-core/lib/index.js'

const pins = [{ number: '1', name: 'P1', x: 20, y: -10 }, { number: '2', name: 'P2', x: 20, y: 10 }]
const components = []
const wires = []
for (let i = 0; i < 12; i++) {
  const id = `u${i + 1}`
  components.push({ id, kind: 'part', designator: id.toUpperCase(), deviceUuid: 'dev', symbolUuid: 'sym', block: 'MCU',
    pins: [{ id: 'p1', name: 'P1', number: '1', electric: 'BI', net: `A${i}` }, { id: 'p2', name: 'P2', number: '2', electric: 'BI', net: `B${i}` }] })
  if (i > 0) wires.push({ id: `w${id}`, kind: 'wire', net: `A${i}`, dots: [[0, 0, 10, 0]] })
}
const ir = { sheets: [{ name: 'MAIN', components, wires, busEntries: [], junctions: [], attrs: [], blocks: [{ name: 'MCU', title: 'MCU' }] }] }
const laid = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([['sym', pins]]) })

const target = SCHEMATIC_PAGE_BUDGET.fillTarget
console.log(`planned ${SCHEMATIC_PAGE_A3.width}x${SCHEMATIC_PAGE_A3.height} target=${target * 100}% floor=${SCHEMATIC_PAGE_BUDGET.fillFloor * 100}%`)
for (const sheet of laid.sheets) {
  const size = sheet.pageSize ?? SCHEMATIC_PAGE_A3
  const fill = measurePageFill(sheet, SCHEMATIC_PAGE_A3)
  const xs = sheet.components.filter(c => c.kind === 'part' && c.position).map(c => c.position.x)
  const ys = sheet.components.filter(c => c.kind === 'part' && c.position).map(c => c.position.y)
  // The tight box fitPageSize judges density with: symbol body +/-60 across,
  // +/-40 down (BODY_HALF_WIDTH 60, BODY_HALF_PADDING*2 40).
  const tightW = Math.max(...xs) - Math.min(...xs) + 120
  const tightH = Math.max(...ys) - Math.min(...ys) + 80
  const plannedArea = SCHEMATIC_PAGE_A3.width * SCHEMATIC_PAGE_A3.height
  console.log(`\n${sheet.name} delivered ${size.width}x${size.height} fitted=${sheet.pageSize !== undefined}`)
  console.log(`  delivery fill     = ${(100 * fill.fill).toFixed(1)}%   ink ${fill.box.x2 - fill.box.x1}x${fill.box.y2 - fill.box.y1}`)
  console.log(`  fill on planned   = ${(100 * (fill.box.x2 - fill.box.x1) * (fill.box.y2 - fill.box.y1) / plannedArea).toFixed(1)}%`)
  console.log(`  tight on planned  = ${(100 * tightW * tightH / plannedArea).toFixed(1)}%  (>= ${target * 100}% keeps the planned page, else converge)`)
  for (const frame of computeBlockFrames(sheet, size)) console.log(`  frame ${frame.width}x${frame.height} at ${frame.x},${frame.y}`)
}
