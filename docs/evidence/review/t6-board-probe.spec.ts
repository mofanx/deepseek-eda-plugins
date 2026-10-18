// t6 temporary probe: run the t5-shaped board through the CURRENT source tree and
// record the delivered page size + fill per page. Deleted after the review.
// Mirrors docs/evidence/tools/t5-board.mjs but imports from src (vitest resolves
// TS), because packages/*/lib/index.js is a tsdown bundle that `tsc -b` does not
// refresh.
import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { SCHEMATIC_PAGE_A3, layoutSchematic } from '../src/index.js'
import { titleBlockTop } from '../../eda-core/src/index.js'

function board() {
  const names = ['MCU', 'POWER', 'IO', 'MEM', 'CLK']
  const pins = [{ name: 'P1', number: '1' }, { name: 'P2', number: '2' }]
  const components = []
  const wires = []
  let n = 0
  for (const block of names) {
    for (let i = 0; i < 6; i++) {
      const id = `u${++n}`
      components.push({
        id,
        kind: 'part',
        designator: id.toUpperCase(),
        deviceUuid: 'dev',
        symbolUuid: 'sym',
        block,
        pins: [0, 1].map(k => ({
          id: `${id}p${k}`,
          name: pins[k].name,
          number: pins[k].number,
          electric: 'BI',
          net: k === 0 ? `${block}-A${i}` : `${block}-B${i}`,
        })),
      })
      if (i > 0) wires.push({ id: `w${id}`, kind: 'wire', net: `${block}-A${i}`, dots: [[0, 0, 10, 0]] })
    }
  }
  return {
    ir: { sheets: [{ name: 'MAIN', components, wires, busEntries: [], junctions: [], attrs: [], blocks: names.map(name => ({ name, title: name })) }] },
    pins,
  }
}

it('records the t5-shaped board on the current source tree', () => {
  const { ir, pins } = board()
  const laid = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([['sym', pins]]) })
  const rows = laid.sheets.map((sheet, index) => {
    const xs = []
    const ys = []
    for (const c of sheet.components) {
      const { x, y } = c.position ?? { x: 0, y: 0 }
      xs.push(x - 60, x + 60)
      ys.push(y - 40, y + 40)
    }
    for (const w of sheet.wires) {
      for (const [x1, y1, x2, y2] of w.dots ?? []) {
        if ([x1, y1, x2, y2].every(v => typeof v === 'number' && Number.isFinite(v))) {
          xs.push(x1, x2)
          ys.push(y1, y2)
        }
      }
    }
    const box = { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
    const size = sheet.pageSize ?? SCHEMATIC_PAGE_A3
    return {
      index,
      name: sheet.name ?? '',
      parts: sheet.components.length,
      blocks: (sheet.blocks ?? []).length,
      pageSize: `${size.width}x${size.height}`,
      fitted: sheet.pageSize !== undefined,
      box,
      fill: Number((((box.x2 - box.x1) * (box.y2 - box.y1)) / (size.width * size.height) * 100).toFixed(1)),
      withinSheet: box.x1 >= 0 && box.y1 >= 0 && box.x2 <= size.width && box.y2 <= titleBlockTop(size),
    }
  })
  writeFileSync('docs/evidence/review/t6-board-t4.json', JSON.stringify({ note: 't5-shaped board (5 modules x 6 parts, 2 pins) through the current src tree', rows }, null, 1))
  expect(rows.length).toBeGreaterThan(0)
})
