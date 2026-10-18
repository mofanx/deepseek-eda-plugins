// t12: the final delivery metric + rule, measured through the package API.
import { SCHEMATIC_PAGE_A3, SCHEMATIC_PAGE_A4, layoutSchematic } from '../../../packages/schematic/lib/index.js'
import { checkPageBudget, describePageBudget } from '../../../packages/eda-core/lib/index.js'

function t5Board() {
  const names = ['MCU', 'POWER', 'IO', 'MEM', 'CLK']
  const pins = [{ number: '1', name: 'P1', x: 20, y: -10 }, { number: '2', name: 'P2', x: 20, y: 10 }]
  const components = []
  const wires = []
  let n = 0
  for (const block of names) {
    for (let i = 0; i < 6; i++) {
      const id = `u${++n}`
      components.push({ id, kind: 'part', designator: id.toUpperCase(), deviceUuid: 'dev', symbolUuid: 'sym', block,
        pins: [{ id: 'p1', name: 'P1', number: '1', electric: 'BI', net: `${block}-A${i}` }, { id: 'p2', name: 'P2', number: '2', electric: 'BI', net: `${block}-B${i}` }] })
      if (i > 0) wires.push({ id: `w${id}`, kind: 'wire', net: `${block}-A${i}`, dots: [[0, 0, 10, 0]] })
    }
  }
  return { ir: { sheets: [{ name: 'MAIN', components, wires, busEntries: [], junctions: [], attrs: [], blocks: names.map(name => ({ name, title: name })) }] }, pins }
}

function flatBoard(perModule) {
  const components = []
  const wires = []
  const blocks = ['MCU', 'POWER', 'IO', 'MEM', 'CLK'].map(name => ({ name, title: name }))
  let n = 0
  for (const block of blocks) {
    for (let i = 0; i < perModule; i++) {
      const id = `u${++n}`
      components.push({ id, kind: 'part', designator: id.toUpperCase(), deviceUuid: `dev-${id}`, block: block.name,
        pins: [{ id: 'p1', name: 'P1', number: '1', electric: 'INPUT', net: `${block.name}-A${i}` }, { id: 'p2', name: 'P2', number: '2', electric: 'OUTPUT', net: `${block.name}-B${i}` }] })
      if (i > 0) { wires.push({ id: `w${id}`, kind: 'wire', net: `${block.name}-A${i}`, dots: [[0, 0, 10, 0]] }); wires.push({ id: `wb${id}`, kind: 'bus', net: `${block.name}-B${i}`, dots: [[0, 0, 10, 0]] }) }
    }
  }
  return { sheets: [{ components, wires, busEntries: [], junctions: [], attrs: [], blocks }] }
}

function show(label, sheets, planned) {
  const report = checkPageBudget(sheets, planned)
  console.log(`\n### ${label}`)
  console.log('  ' + describePageBudget(report))
  for (const page of report.pages) {
    console.log(`  ${page.name || '?'} blocks=${page.blocks} box=${page.box.x1},${page.box.y1}..${page.box.x2},${page.box.y2} margins L=${page.box.x1} R=${page.pageSize.width - page.box.x2}`)
  }
  for (const violation of report.violations) console.log(`  VIOLATION ${violation.rule}: ${violation.detail}`)
}

const t5 = t5Board()
const laid = layoutSchematic(t5.ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([['sym', t5.pins]]) })
show('t5 board (delivered, converged)', laid.sheets, SCHEMATIC_PAGE_A3)
show('t5 board, pageSize stripped (no convergence)', laid.sheets.map(s => ({ ...s, pageSize: undefined })), SCHEMATIC_PAGE_A3)
const laidOne = layoutSchematic(t5.ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([['sym', t5.pins]]), moduleColumns: 1 })
show('t5 board, moduleColumns=1 (one module per page)', laidOne.sheets, SCHEMATIC_PAGE_A3)
const flat6 = layoutSchematic(flatBoard(6), { pageSize: SCHEMATIC_PAGE_A3 })
show('flat 5x6 A3', flat6.sheets, SCHEMATIC_PAGE_A3)
const flat6a4 = layoutSchematic(flatBoard(6), { pageSize: SCHEMATIC_PAGE_A4 })
show('flat 5x6 A4', flat6a4.sheets, SCHEMATIC_PAGE_A4)
const flat12 = layoutSchematic(flatBoard(12), { pageSize: SCHEMATIC_PAGE_A3 })
show('flat 5x12 A3', flat12.sheets, SCHEMATIC_PAGE_A3)
