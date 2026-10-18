// t12: find a legitimately capped page — below the 35% target, at its minimum
// feasible sheet, above the floor, and not the pagination's fault. That is the
// only case the ceiling clause is allowed to pass, so the rule needs one.
import { SCHEMATIC_PAGE_A3, layoutSchematic } from '../../../packages/schematic/lib/index.js'
import { checkPageBudget, describePageBudget } from '../../../packages/eda-core/lib/index.js'

function board(modules, perModule) {
  const names = ['MCU', 'POWER', 'IO', 'MEM', 'CLK', 'SENSOR', 'RADIO'].slice(0, modules)
  const components = []
  const wires = []
  let n = 0
  for (const block of names) {
    for (let i = 0; i < perModule; i++) {
      const id = `u${++n}`
      components.push({ id, kind: 'part', designator: id.toUpperCase(), deviceUuid: `dev-${id}`, block,
        pins: [{ id: 'p1', name: 'P1', number: '1', electric: 'INPUT', net: `${block}-A${i}` }, { id: 'p2', name: 'P2', number: '2', electric: 'OUTPUT', net: `${block}-B${i}` }] })
      if (i > 0) wires.push({ id: `w${id}`, kind: 'wire', net: `${block}-A${i}`, dots: [[0, 0, 10, 0]] })
    }
  }
  return { sheets: [{ name: 'MAIN', components, wires, busEntries: [], junctions: [], attrs: [], blocks: names.map(name => ({ name, title: name })) }] }
}

for (const [modules, perModule] of [[1, 12], [1, 18], [1, 24], [2, 12], [2, 18], [3, 18]]) {
  const laid = layoutSchematic(board(modules, perModule), { pageSize: SCHEMATIC_PAGE_A3 })
  const report = checkPageBudget(laid.sheets, SCHEMATIC_PAGE_A3)
  const below = report.pages.filter(page => page.fill < 0.35)
  console.log(`${modules}x${perModule}: ${describePageBudget(report)}`)
  for (const violation of report.violations) console.log(`    VIOLATION ${violation.rule}: ${violation.detail}`)
  if (below.length > 0) console.log(`    below-target pages: ${below.map(p => `${p.name} ${(p.fill * 100).toFixed(1)}% atMin=${p.atMinimum} ceil=${(p.ceiling * 100).toFixed(1)}%`).join(', ')}`)
}
