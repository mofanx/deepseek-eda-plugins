// t9 audit of the t7 acceptance rule: is the "structural ceiling" clause a free
// pass? The rule under test (packages/eda-core/tests/page-budget.spec.ts,
// `expectWithinBudget`) says a page is acceptable when
//
//   fill >= 0.35
//     OR ( ceiling < 0.35 AND fill >= 0.9 * ceiling AND size <= minSize + 1 grid )
//
// This script lays the same five-module board out twice -- once with the
// production options, once with `moduleColumns: 1`, which forces the old
// one-module-per-page pagination -- and applies the rule verbatim. If the
// one-module pages pass, the ceiling clause cannot tell "the page is genuinely
// full" from "the page holds too little content", and the rule is a free pass.
//
// The bundle is the tsdown output, verified current (t4 markers present) before
// the run; the gate itself is run against src separately.

import { writeFileSync } from 'node:fs'
import { SCHEMATIC_PAGE_A3, layoutSchematic } from '../../../packages/schematic/lib/index.js'

const EDGE_PAD = 170
const FITTED_MARGIN = 60
const OUT_X = 180
const OUT_TOP = 200
const OUT_BOTTOM = 140
const MIN_W = 592
const MIN_H = 300
const METRIC_X = 60
const METRIC_Y = 40
const GRID = 10

function board() {
  const names = ['MCU', 'POWER', 'IO', 'MEM', 'CLK']
  const pins = [
    { number: '1', name: 'P1', x: 20, y: -10 },
    { number: '2', name: 'P2', x: 20, y: 10 },
  ]
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

function audit(pages, planned) {
  return pages.map((sheet, index) => {
    const size = sheet.pageSize ?? planned
    const xs = []
    const ys = []
    const ax = []
    const ay = []
    for (const c of sheet.components) {
      const { x, y } = c.position ?? { x: 0, y: 0 }
      xs.push(x - METRIC_X, x + METRIC_X)
      ys.push(y - METRIC_Y, y + METRIC_Y)
      ax.push(x)
      ay.push(y)
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
    const outwardWidth = Math.max(...ax) - Math.min(...ax) + 2 * OUT_X
    const outwardHeight = Math.max(...ay) - Math.min(...ay) + OUT_TOP + OUT_BOTTOM
    const minSize = {
      width: Math.min(planned.width, Math.max(MIN_W, Math.ceil((outwardWidth + FITTED_MARGIN + EDGE_PAD) / GRID) * GRID)),
      height: Math.min(planned.height, Math.max(MIN_H, Math.ceil((outwardHeight + FITTED_MARGIN + EDGE_PAD) / GRID) * GRID)),
    }
    const contentArea = (box.x2 - box.x1) * (box.y2 - box.y1)
    const fill = contentArea / (size.width * size.height)
    const ceiling = contentArea / (minSize.width * minSize.height)
    const passTarget = fill >= 0.35
    const passCap = ceiling < 0.35 && fill >= 0.9 * ceiling && size.width <= minSize.width + GRID && size.height <= minSize.height + GRID
    return {
      index,
      name: sheet.name ?? '',
      parts: sheet.components.length,
      blocks: (sheet.blocks ?? []).length,
      size: `${size.width}x${size.height}`,
      fitted: sheet.pageSize !== undefined,
      fill: +(fill * 100).toFixed(1),
      ceiling: +(ceiling * 100).toFixed(1),
      minSize: `${minSize.width}x${minSize.height}`,
      verdict: passTarget ? 'PASS (>=35%)' : passCap ? 'PASS (ceiling clause)' : 'FAIL',
    }
  })
}

const { ir, pins } = board()
const results = []
for (const [label, extra] of [['production (default)', {}], ['moduleColumns: 1', { moduleColumns: 1 }]]) {
  const laid = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([['sym', pins]]), ...extra })
  const rows = audit(laid.sheets, SCHEMATIC_PAGE_A3)
  results.push({ variant: label, pages: rows })
  console.log(`\n### ${label}`)
  for (const row of rows) {
    console.log(`  p${row.index} ${row.name} parts=${row.parts} blocks=${row.blocks} size=${row.size}${row.fitted ? '*' : ''} fill=${row.fill}% cap=${row.ceiling}% min=${row.minSize} -> ${row.verdict}`)
  }
}
writeFileSync('docs/evidence/review/t9-rule-audit.json', JSON.stringify({
  rule: 'fill >= 35% OR (ceiling < 35% AND fill >= 90% of ceiling AND size <= minSize + 1 grid)',
  note: 'same five-module board as page-budget.spec.ts; moduleColumns:1 reproduces the old one-module-per-page pagination',
  results,
}, null, 1))
