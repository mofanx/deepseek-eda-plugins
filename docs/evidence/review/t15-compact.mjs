// t15: measure the compact module packer against the t14 fixture. t14 found
// every module frame was 180x840 (1:4.7) with a 120x680 tight box — 46% blank
// inside the frame — because a six-part layer stayed one column. The packer now
// splits a layer into balanced sub-columns targeting a 1.4:1 block, so the same
// six parts should land in two columns of three. This script reports the new
// frame geometry and page fill; it does not assert, it records.
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
  const size = sheet.pageSize ?? SCHEMATIC_PAGE_A3
  const fill = measurePageFill(sheet, SCHEMATIC_PAGE_A3)
  console.log(`\n${sheet.name} ${size.width}x${size.height} fitted=${fill.fitted} fill=${(fill.fill * 100).toFixed(1)}%`)
  for (const frame of computeBlockFrames(sheet, size)) {
    const inside = sheet.components.filter(component => component.kind === 'part'
      && component.position !== undefined
      && component.position.x >= frame.x && component.position.x <= frame.x + frame.width
      && component.position.y >= frame.y && component.position.y <= frame.y + frame.height)
    const xs = inside.map(component => component.position.x)
    const ys = inside.map(component => component.position.y)
    // Same tight box t14 used: symbol body +/-60 across, +/-40 down.
    const tightW = (Math.max(...xs) - Math.min(...xs)) + 120
    const tightH = (Math.max(...ys) - Math.min(...ys)) + 80
    const frameArea = frame.width * frame.height
    const tightArea = tightW * tightH
    console.log(`  frame ${frame.title ?? frame.name} ${frame.width}x${frame.height} aspect=1:${(frame.height / frame.width).toFixed(1)} parts=${inside.length} tight=${tightW}x${tightH} tight/frame=${(100 * tightArea / frameArea).toFixed(1)}% blank=${(100 * (1 - tightArea / frameArea)).toFixed(1)}%`)
  }
}

// t14 baseline for the same fixture (kept here so the delta is in one place):
//   frame 180x840 (1:4.7), tight 120x680, tight/frame 54.0%, blank 46.0%.
console.log('\nt14 baseline: frame 180x840 aspect=1:4.7 tight=120x680 blank=46.0%')
