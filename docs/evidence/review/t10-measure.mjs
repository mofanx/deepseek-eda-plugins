// t10: measure the delivery metric after the budget/centering change.
import { SCHEMATIC_PAGE_A3, SCHEMATIC_PAGE_A4, SCHEMATIC_PAGE_BUDGET as B, fittedPageSize, layoutSchematic } from '../../../packages/schematic/lib/index.js'
import { measurePageFill } from '../../../packages/eda-core/lib/index.js'

const OUT = B

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

function report(label, ir, planned, pins, extra = {}) {
  const laid = layoutSchematic(ir, { pageSize: planned, ...(pins ? { symbolPins: new Map([['sym', pins]]) } : {}), ...extra })
  console.log(`\n### ${label}  planned=${planned.width}x${planned.height}`)
  for (const [i, sheet] of laid.sheets.entries()) {
    const m = measurePageFill(sheet, planned)
    const xs = sheet.components.map(c => c.position?.x ?? 0)
    const ys = sheet.components.map(c => c.position?.y ?? 0)
    const outward = { x1: Math.min(...xs) - OUT.outwardX, y1: Math.min(...ys) - OUT.outwardTop, x2: Math.max(...xs) + OUT.outwardX, y2: Math.max(...ys) + OUT.outwardBottom }
    const min = fittedPageSize(outward, planned)
    const atMin = m.pageSize.width === min.width && m.pageSize.height === min.height
    const parts = sheet.components.filter(c => c.id.startsWith('u')).length
    const left = m.box.x1
    const right = m.pageSize.width - m.box.x2
    console.log(`  p${i} ${sheet.name} size=${m.pageSize.width}x${m.pageSize.height}${m.fitted ? '*' : ''} parts=${parts} blocks=${(sheet.blocks ?? []).length} fill=${(m.fill * 100).toFixed(1)}% box=${m.box.x1},${m.box.y1}..${m.box.x2},${m.box.y2} min=${min.width}x${min.height} atMin=${atMin} margins L=${left} R=${right} T=${m.box.y1} B=${m.pageSize.height - m.box.y2}`)
  }
}

const t5 = t5Board()
report('t5 board (default)', t5.ir, SCHEMATIC_PAGE_A3, t5.pins)
report('t5 board moduleColumns=1', t5.ir, SCHEMATIC_PAGE_A3, t5.pins, { moduleColumns: 1 })
report('flat 5x6 A3', flatBoard(6), SCHEMATIC_PAGE_A3)
report('flat 5x6 A4', flatBoard(6), SCHEMATIC_PAGE_A4)
report('flat 5x12 A3', flatBoard(12), SCHEMATIC_PAGE_A3)
