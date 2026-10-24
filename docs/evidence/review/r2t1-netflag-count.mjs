// r2t1 step 1: READ ONLY. Which of the 14 flag-like Name attrs belongs to a real netflag
// component? t53 counts netflag by c.componentType, so use the same field.
import { HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'

const probe = `
const all = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const attrs = (await eda.sch_PrimitiveAttribute.getAll()) || [];
const comps = all.map(c => ({ id: String(c.primitiveId || c.id), type: String(c.componentType || ''),
  designator: c.designator ?? null, x: c.x, y: c.y }));
const names = attrs.filter(a => a.key === 'Name').map(a => ({ value: a.value,
  parent: a.parentPrimitiveId ?? a.parent ?? null, x: a.x, y: a.y,
  visible: a.valueVisible === undefined ? null : a.valueVisible !== false }));
return { comps, names };
`
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const r = await bridge.execute(probe, { timeoutMs: 60_000 })
const byId = new Map(r.comps.map(c => [c.id, c]))
console.log('component types:', JSON.stringify(r.comps.reduce((o, c) => { o[c.type] = (o[c.type] ?? 0) + 1; return o }, {})))
const flagNames = r.names.filter(n => String(n.parent ?? '').startsWith('layout:flag'))
console.log('flag-like Name attrs:', flagNames.length)
for (const n of flagNames) {
  const c = byId.get(n.parent)
  console.log(`  ${String(n.value).padEnd(8)} parent=${String(n.parent).padEnd(30)} compType=${c ? c.type : 'MISSING'} at=(${n.x},${n.y})`)
}
