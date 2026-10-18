// t10: what geometry does a laid page actually expose? Needed to define THE
// delivery fill metric (ink bbox / delivered page area) in one place.
import { SCHEMATIC_PAGE_A3, layoutSchematic } from '../../../packages/schematic/lib/index.js'

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
      id, kind: 'part', designator: id.toUpperCase(), deviceUuid: 'dev', symbolUuid: 'sym', block,
      pins: [
        { id: 'p1', name: 'P1', number: '1', electric: 'BI', net: `${block}-A${i}` },
        { id: 'p2', name: 'P2', number: '2', electric: 'BI', net: `${block}-B${i}` },
      ],
    })
    if (i > 0) wires.push({ id: `w${id}`, kind: 'wire', net: `${block}-A${i}`, dots: [[0, 0, 10, 0]] })
  }
}
const ir = { sheets: [{ name: 'MAIN', components, wires, busEntries: [], junctions: [], attrs: [], blocks: names.map(name => ({ name, title: name })) }] }
const laid = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([['sym', pins]]) })

for (const sheet of laid.sheets) {
  const xs = sheet.components.map(c => c.position?.x ?? 0)
  const ys = sheet.components.map(c => c.position?.y ?? 0)
  const parts = sheet.components.filter(c => c.id.startsWith('u'))
  const px = parts.map(c => c.position.x)
  const py = parts.map(c => c.position.y)
  console.log(`\n=== ${sheet.name} pageSize=${sheet.pageSize ? sheet.pageSize.width + 'x' + sheet.pageSize.height : 'planned'} components=${sheet.components.length} parts=${parts.length}`)
  console.log(`  all comps  x ${Math.min(...xs)}..${Math.max(...xs)}  y ${Math.min(...ys)}..${Math.max(...ys)}`)
  console.log(`  parts only x ${Math.min(...px)}..${Math.max(...px)}  y ${Math.min(...py)}..${Math.max(...py)}`)
  console.log(`  sheet keys: ${Object.keys(sheet).join(',')}`)
  console.log(`  blocks: ${JSON.stringify(sheet.blocks ?? null)}`)
  console.log(`  component[0] keys: ${Object.keys(sheet.components[0]).join(',')}`)
  console.log(`  component[0]: ${JSON.stringify(sheet.components[0]).slice(0, 400)}`)
  console.log(`  wires: ${JSON.stringify((sheet.wires ?? []).slice(0, 2))}`)
}
