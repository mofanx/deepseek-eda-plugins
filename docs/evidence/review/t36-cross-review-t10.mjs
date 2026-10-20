// t36: independent recomputation of every number in t10's re-ranking (read-only).
//   A. flags: count by prefix, by Global Net Name parent, and by NON-EMPTY value
//      (t10 says 13; earlier runs said 14 - this settles which definition)
//   B. 55 net names: first-vertex rows, vertical pair gaps, densest row
//   C. attributes: total and invisible count
//   D. texts outside the inner frame
//   E. wire vertices and out-of-frame points
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gateFreshness } from './shared/freshness.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
gateFreshness(repoRoot)
const pkgDir = join(repoRoot, 'packages')

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const d = await bridge.execute(`
const g = (o, k) => { try { const f = o['getState_' + k]; return typeof f === 'function' ? f.call(o) : o[k] } catch (e) { return null } };
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const attrs = (await eda.sch_PrimitiveAttribute.getAll(undefined, false)) || [];
const wires = (await eda.sch_PrimitiveWire.getAll(undefined, false)) || [];
const texts = (await eda.sch_PrimitiveText.getAll(undefined, false)) || [];
const rects = (await eda.sch_PrimitiveRectangle.getAll(undefined, false)) || [];
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
return {
  main: cur && cur.uuid,
  pages,
  comps: comps.map(c => ({ id: g(c, 'PrimitiveId'), x: g(c, 'X'), y: g(c, 'Y'), name: g(c, 'Name'), des: g(c, 'Designator') })),
  attrs: attrs.map(a => ({ key: g(a, 'Key'), value: g(a, 'Value'), kv: g(a, 'KeyVisible'), vv: g(a, 'ValueVisible'), parent: g(a, 'ParentPrimitiveId') })),
  wires: wires.map(w => ({ net: g(w, 'Net'), line: g(w, 'Line') })),
  texts: texts.map(t => ({ x: g(t, 'X'), y: g(t, 'Y'), c: g(t, 'Content') })),
  rects: rects.map(r => ({ id: g(r, 'PrimitiveId'), x: g(r, 'TopLeftX'), y: g(r, 'TopLeftY'), w: g(r, 'Width'), h: g(r, 'Height') })),
};
`, { timeoutMs: 180_000 })

const out = { status: 'OK', main: d.main, pages: d.pages.length, comps: d.comps.length }

// A. flags
const FLAG = 'layout:flag:'
const flags = d.comps.filter((c) => String(c.id).startsWith(FLAG))
const gnn = d.attrs.filter((a) => a.key === 'Global Net Name')
const parents = new Set(gnn.map((a) => a.parent).filter(Boolean))
const flagIds = new Set(flags.map((f) => f.id))
const gnnOnFlags = gnn.filter((a) => flagIds.has(a.parent))
const gnnNonEmpty = gnnOnFlags.filter((a) => typeof a.value === 'string' && a.value.trim().length > 0)
const gnnEmpty = gnnOnFlags.filter((a) => !(typeof a.value === 'string' && a.value.trim().length > 0))
out.flags = {
  byPrefix: flags.length,
  byGlobalNetNameParent: parents.size,
  globalNetNameAttrs: gnn.length,
  globalNetNameOnFlagComponents: gnnOnFlags.length,
  withNonEmptyValue: gnnNonEmpty.length,
  emptyValue: gnnEmpty.length,
  emptyValueRows: gnnEmpty.map((a) => ({ parent: a.parent, value: a.value })),
  positions: flags.map((f) => [f.x, f.y]),
}
// flag pitch: consecutive pairs sharing x
const byX = new Map()
for (const f of flags) { const k = String(f.x); if (!byX.has(k)) byX.set(k, []); byX.get(k).push(f.y) }
out.flags.columns = [...byX.entries()].map(([x, ys]) => ({ x, n: ys.length, ys: [...ys].sort((a, b) => a - b) }))
const gaps = []
for (const [, ys] of byX) { const s = [...ys].sort((a, b) => a - b); for (let i = 1; i < s.length; i++) gaps.push(Math.round((s[i] - s[i - 1]) * 100) / 100) }
out.flags.gaps = { count: gaps.length, all10: gaps.every((g) => g === 10), distinct: [...new Set(gaps)].sort((a, b) => a - b) }

// B. net-name rows from wire first vertices
const netted = d.wires.filter((w) => typeof w.net === 'string' && w.net.length > 0)
const anchors = netted.map((w) => ({ net: w.net, x: w.line?.[0], y: w.line?.[1] })).filter((a) => typeof a.x === 'number' && typeof a.y === 'number')
const rows = new Map()
for (const a of anchors) { const k = String(a.y); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(a) }
const yv = [...rows.keys()].map(Number).sort((a, b) => a - b)
const dy = []
for (let i = 1; i < yv.length; i++) dy.push(Math.round((yv[i] - yv[i - 1]) * 100) / 100)
const closePairs = []
let sameRowPairs = 0
let crossRowClose = 0
for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length; j++) {
  const dyy = Math.abs(anchors[i].y - anchors[j].y)
  if (dyy === 0) sameRowPairs++
  if (dyy < 6) { closePairs.push(dyy); if (dyy > 0) crossRowClose++ }
}
const densest = [...rows.entries()].map(([y, list]) => ({ y: Number(y), n: list.length })).sort((a, b) => b.n - a.n)[0]
const sameRowDx = []
for (const [, list] of rows) {
  const xs = list.map((a) => a.x).sort((a, b) => a - b)
  for (let i = 1; i < xs.length; i++) sameRowDx.push(Math.round((xs[i] - xs[i - 1]) * 100) / 100)
}
out.netNames = {
  nettedWires: netted.length,
  anchors: anchors.length,
  distinctRows: yv.length,
  rowGapMin: dy.length ? Math.min(...dy) : null,
  rowGapMedian: dy.length ? dy[Math.floor(dy.length / 2)] : null,
  pairsCloserThan6: closePairs.length,
  sameRowPairs,
  crossRowClose,
  minHorizontalGapSameRow: sameRowDx.length ? Math.min(...sameRowDx) : null,
  densestRow: densest,
}

// C. attributes invisible
const invisible = d.attrs.filter((a) => a.kv !== true && a.vv !== true)
out.attributes = { total: d.attrs.length, invisible: invisible.length, invisiblePct: Math.round((invisible.length / d.attrs.length) * 100) }

// D. texts outside the inner frame
const inner = d.rects.find((r) => r.id === 'rect1')
const innerBox = inner ? { x1: inner.x, x2: inner.x + inner.w, y1: inner.y - inner.h, y2: inner.y } : null
const outside = innerBox ? d.texts.filter((t) => !(t.x >= innerBox.x1 && t.x <= innerBox.x2 && t.y >= innerBox.y1 && t.y <= innerBox.y2)) : []
out.texts = {
  total: d.texts.length,
  outsideInner: outside.length,
  outsideRows: outside.map((t) => ({ c: t.c, x: t.x, y: t.y, side: t.x <= innerBox.x1 || t.x >= innerBox.x2 ? 'x' : 'y' })),
  innerBox,
}

// E. wire vertices / out-of-frame points
const outer = d.rects.find((r) => r.id === 'rect0')
const outerBox = outer ? { x1: outer.x, x2: outer.x + outer.w, y1: outer.y - outer.h, y2: outer.y } : null
let pts = 0
let bad = 0
for (const w of d.wires) {
  const line = Array.isArray(w.line) ? w.line : []
  for (let i = 0; i + 1 < line.length; i += 2) {
    pts++
    const x = line[i]
    const y = line[i + 1]
    if (!(x >= outerBox.x1 && x <= outerBox.x2 && y >= outerBox.y1 && y <= outerBox.y2)) bad++
  }
}
out.wireGeometry = { vertices: pts, outsideOuter: bad, outerBox }

console.log(JSON.stringify(out, null, 1))
