import { SCHEMATIC_PAGE_A3, layoutSchematic } from "../../../packages/schematic/lib/index.js"
import { computeBlockFrames } from "../../../packages/eda-core/lib/index.js"
import { measurePageFill } from "../../../packages/eda-core/lib/index.js"
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
  const size = sheet.pageSize
  const area = size.width * size.height
  const delivery = measurePageFill(sheet, SCHEMATIC_PAGE_A3)
  const pts = []
  for (const c of sheet.components) if (c.position) pts.push(c.position)
  const ax1 = Math.min(...pts.map(p=>p.x)) - 60, ax2 = Math.max(...pts.map(p=>p.x)) + 60
  const ay1 = Math.min(...pts.map(p=>p.y)) - 40, ay2 = Math.max(...pts.map(p=>p.y)) + 40
  const anchor = ((ax2-ax1)*(ay2-ay1))/area
  const frames = computeBlockFrames(sheet, size)
  const frameSum = frames.reduce((s,f)=>s+f.width*f.height,0)/area
  const frameUnion = frames.reduce((acc,f)=>({x1:Math.min(acc.x1,f.x),y1:Math.min(acc.y1,f.y),x2:Math.max(acc.x2,f.x+f.width),y2:Math.max(acc.y2,f.y+f.height)}),{x1:1e9,y1:1e9,x2:-1e9,y2:-1e9})
  const union = ((frameUnion.x2-frameUnion.x1)*(frameUnion.y2-frameUnion.y1))/area
  console.log(`${sheet.name} ${size.width}x${size.height} parts=${sheet.components.filter(c=>c.kind==="part").length} frames=${frames.length}`)
  console.log(`  delivery(ink) ${(delivery.fill*100).toFixed(1)}%  anchor ${(anchor*100).toFixed(1)}%  frameArea ${(frameSum*100).toFixed(1)}%  frameUnion ${(union*100).toFixed(1)}%`)
  console.log(`  ink box ${delivery.box.x1},${delivery.box.y1}..${delivery.box.x2},${delivery.box.y2}`)
}
