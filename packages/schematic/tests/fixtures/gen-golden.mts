import { writeFileSync } from 'node:fs'
import { layoutSchematic } from '../../src/layout.ts'

const doc = {
  sheets: [{
    components: [
      {
        id: 'u1', kind: 'part', designator: 'U1', lcsc: 'C25804',
        pins: [
          { id: 'p1', name: 'OUT', number: '3', electric: 'OUTPUT', net: 'SIG' },
          { id: 'p2', name: 'VCC', number: '8', electric: 'BI', net: 'VCC', powerName: 'VCC' },
          { id: 'p3', name: 'GND', number: '4', electric: 'BI', net: 'GND', powerName: 'GND' },
        ],
      },
      {
        id: 'r1', kind: 'part', designator: 'R1', lcsc: 'C25804',
        pins: [
          { id: 'p1', name: '1', number: '1', electric: 'BI', net: 'SIG' },
          { id: 'p2', name: '2', number: '2', electric: 'BI', net: 'VCC', powerName: 'VCC' },
        ],
      },
      {
        id: 'u2', kind: 'part', designator: 'U2', lcsc: 'C25804',
        pins: [
          { id: 'p1', name: 'IN', number: '1', electric: 'INPUT', net: 'SIG' },
          { id: 'p2', name: 'GND', number: '2', electric: 'BI', net: 'GND', powerName: 'GND' },
        ],
      },
    ],
    wires: [], busEntries: [], junctions: [], attrs: [],
  }],
}

const laid = layoutSchematic(doc as never)
writeFileSync(new URL('./layout-input.json', import.meta.url), JSON.stringify(doc, null, 2) + '\n')
writeFileSync(new URL('./layout-golden.json', import.meta.url), JSON.stringify(laid, null, 2) + '\n')
console.log(JSON.stringify(laid.sheets[0]?.components.map(c => ({ id: c.id, position: c.position })), null, 1))
console.log(JSON.stringify(laid.sheets[0]?.wires.map(w => ({ id: w.id, net: w.net, dots: w.dots }))))
console.log(JSON.stringify(laid.sheets[0]?.junctions))
