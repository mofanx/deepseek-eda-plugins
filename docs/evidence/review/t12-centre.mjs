import { SCHEMATIC_PAGE_A3, SCHEMATIC_PAGE_BUDGET as B, layoutSchematic, outwardContentBox } from "../../../packages/schematic/lib/index.js"
const names = ["MCU","POWER","IO","MEM","CLK"]
const pins = [{ number:"1", name:"P1", x:20, y:-10 }, { number:"2", name:"P2", x:20, y:10 }]
const components = []; const wires = []; let n = 0
for (const block of names) { for (let i=0;i<6;i++){ const id=`u${++n}`
  components.push({ id, kind:"part", designator:id.toUpperCase(), deviceUuid:"dev", symbolUuid:"sym", block,
    pins:[{id:"p1",name:"P1",number:"1",electric:"BI",net:`${block}-A${i}`},{id:"p2",name:"P2",number:"2",electric:"BI",net:`${block}-B${i}`}] })
  if (i>0) wires.push({ id:`w${id}`, kind:"wire", net:`${block}-A${i}`, dots:[[0,0,10,0]] }) } }
const ir = { sheets:[{ name:"MAIN", components, wires, busEntries:[], junctions:[], attrs:[], blocks:names.map(name=>({name,title:name})) }] }
const laid = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([["sym", pins]]) })
for (const sheet of laid.sheets) {
  const anchors = sheet.components.map(c=>c.position).filter(Boolean)
  const pts = []
  for (const c of sheet.components) { if (c.position) pts.push(c.position); for (const p of c.pins) if (p.endpoint) pts.push(p.endpoint) }
  const a = outwardContentBox(anchors); const e = outwardContentBox(pts)
  const size = sheet.pageSize
  console.log(`${sheet.name} size=${size.width}x${size.height}`)
  console.log(`  anchors   x ${Math.min(...anchors.map(p=>p.x))}..${Math.max(...anchors.map(p=>p.x))}  outward ${a.x1}..${a.x2} -> L=${a.x1} R=${size.width-a.x2} diff=${a.x1-(size.width-a.x2)}`)
  console.log(`  +endpoint x ${Math.min(...pts.map(p=>p.x))}..${Math.max(...pts.map(p=>p.x))}  outward ${e.x1}..${e.x2} -> L=${e.x1} R=${size.width-e.x2} diff=${e.x1-(size.width-e.x2)}`)
}
