// t14: quantify the visual difference t11/t13 captured — our module frames are
// tall and narrow (live t13: 200x820 each) with a lot of blank inside them,
// while the reference's blocks are wide and short. Cause to check: the packing
// puts every module in a single column, independent of the free page width.
import { SCHEMATIC_PAGE_A3, layoutSchematic } from '../../../packages/schematic/lib/index.js'
import { computeBlockFrames, measurePageFill } from '../../../packages/eda-core/lib/index.js'

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
const ir = { sheets: [{ name: 'MAIN', components, wires, busEntries: [], junctions: [], attrs: [], blocks: names.map(name => ({ name, title: name })) }] }
const laid = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([['sym', pins]]) })

for (const sheet of laid.sheets) {
  const size = sheet.pageSize
  const fill = measurePageFill(sheet, SCHEMATIC_PAGE_A3)
  console.log(`\n${sheet.name} ${size.width}x${size.height} fill=${(fill.fill * 100).toFixed(1)}%`)
  for (const frame of computeBlockFrames(sheet, size)) {
    const inside = sheet.components.filter(component => component.kind === 'part'
      && component.position !== undefined
      && component.position.x >= frame.x && component.position.x <= frame.x + frame.width
      && component.position.y >= frame.y && component.position.y <= frame.y + frame.height)
    const xs = inside.map(component => component.position.x)
    const ys = inside.map(component => component.position.y)
    // Tight box the layout judges density with: symbol body +/-60 across, +/-40 down.
    const tightW = (Math.max(...xs) - Math.min(...xs)) + 120
    const tightH = (Math.max(...ys) - Math.min(...ys)) + 80
    const frameArea = frame.width * frame.height
    const tightArea = tightW * tightH
    console.log(`  frame ${frame.title ?? frame.name} ${frame.width}x${frame.height} aspect=1:${(frame.height / frame.width).toFixed(1)} parts=${inside.length} tight=${tightW}x${tightH} tight/frame=${(100 * tightArea / frameArea).toFixed(1)}% blank=${(100 * (1 - tightArea / frameArea)).toFixed(1)}%`)
  }
}

// Reference side, from t11-reference-metric.json (same-kind box, live capture).
console.log('\nreference blocks (t11-reference-metric.json rectBox, live):')
for (const [name, box] of [['CORE', [150, 360, 1200, 1120]], ['DEVICE', [195, 212, 1609, 1130]], ['POWER', [220, 780, 760, 1090]]]) {
  const w = box[2] - box[0]
  const h = box[3] - box[1]
  console.log(`  ${name} ${w}x${h} aspect=${(w / h).toFixed(1)}:1`)
}
