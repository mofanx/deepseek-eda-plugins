// r2t4: READ ONLY. Which net label sits at which row on the left of the MCU block?
// Lists Name attrs near x 220-260, y 740-820, plus the Pin Number attrs in the same band,
// so the close-up rows can be matched to nets without guessing from pixels.
import { HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'

const b = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const rows = await b.execute(`
const attrs = (await eda.sch_PrimitiveAttribute.getAll()) || [];
return attrs.filter(a => a.key === 'Name' || a.key === 'Pin Number')
  .map(a => ({ k: a.key, v: String(a.value), x: Math.round(a.x * 100) / 100, y: Math.round(a.y * 100) / 100,
    p: String(a.parentPrimitiveId ?? a.parent ?? ''), vis: a.valueVisible !== false }))
  .filter(a => a.y >= 735 && a.y <= 825)
`, { timeoutMs: 90_000 })

const left = rows.filter((r) => r.x < 300).sort((a, c) => a.y - c.y || a.x - c.x)
for (const r of left) console.log(`${String(r.k).padEnd(11)} ${String(r.v).padEnd(8)} x=${r.x} y=${r.y} vis=${r.vis} ${r.p}`)
