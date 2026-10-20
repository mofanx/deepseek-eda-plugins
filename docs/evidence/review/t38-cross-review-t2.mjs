// t38: recompute t2's crowding numbers under BOTH anchor models (read-only).
//   Model A: first vertex (this is what serialize.ts:317-320 emits on the
//            source path, and the only anchor rule our code actually states).
//   Model B: midpoint of the longest segment (the model t2 uses).
// Also: wire shape inventory, per-net connectivity, page/component invariants.
import { gateFreshness } from './shared/freshness.mjs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../../..')
const pkgDir = join(repoRoot, 'packages')
gateFreshness(repoRoot)

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const d = await bridge.execute(`
const g = (o, k) => { try { const f = o['getState_' + k]; return typeof f === 'function' ? f.call(o) : o[k] } catch (e) { return null } };
const wires = (await eda.sch_PrimitiveWire.getAll(undefined, false)) || [];
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const texts = (await eda.sch_PrimitiveText.getAll(undefined, false)) || [];
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
return {
  wires: wires.map(w => ({ net: g(w, 'Net'), line: g(w, 'Line') })),
  comps: comps.map(c => ({ id: g(c, 'PrimitiveId'), type: g(c, 'ComponentType') })),
  texts: texts.map(t => ({ c: g(t, 'Content'), y: g(t, 'Y') })),
  pages: ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).length,
  main: cur && cur.uuid,
};
`, { timeoutMs: 180_000 })

const r2 = (n) => Math.round(n * 100) / 100
const segsOf = (line) => {
  const out = []
  for (let i = 0; i + 3 < line.length; i += 2) out.push([line[i], line[i + 1], line[i + 2], line[i + 3]])
  return out
}
// Model A: first point. Model B: midpoint of the longest segment.
const anchorOf = (w, model) => {
  const line = Array.isArray(w.line) ? w.line : []
  if (line.length < 2) return null
  if (model === 'first') return { x: line[0], y: line[1] }
  const segs = segsOf(line)
  if (!segs.length) return { x: line[0], y: line[1] }
  let best = segs[0]
  let bestLen = -1
  for (const s of segs) {
    const len = Math.hypot(s[2] - s[0], s[3] - s[1])
    if (len > bestLen) { bestLen = len; best = s }
  }
  return { x: r2((best[0] + best[2]) / 2), y: r2((best[1] + best[3]) / 2) }
}
const shapeOf = (w) => {
  const segs = segsOf(Array.isArray(w.line) ? w.line : [])
  if (segs.length === 0) return 'point'
  const horizontal = segs.every((s) => s[1] === s[3])
  const vertical = segs.every((s) => s[0] === s[2])
  const kind = horizontal ? 'H' : vertical ? 'V' : 'poly'
  return segs.length === 1 ? `1x${kind}` : `${segs.length}x${kind}`
}
const metrics = (model) => {
  const anchors = d.wires.filter((w) => typeof w.net === 'string' && w.net).map((w) => ({ net: w.net, ...anchorOf(w, model) })).filter((a) => a && typeof a.x === 'number')
  const rows = new Map()
  for (const a of anchors) { const k = String(a.y); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(a) }
  const yv = [...rows.keys()].map(Number).sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < yv.length; i++) gaps.push(r2(yv[i] - yv[i - 1]))
  let close = 0
  let sameRow = 0
  let crossRow = 0
  for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length; j++) {
    const dy = Math.abs(anchors[i].y - anchors[j].y)
    if (dy < 6) { close++; if (dy === 0) sameRow++; else crossRow++ }
  }
  const dxs = []
  let dxUnder28 = 0
  let dxUnder30 = 0
  for (const [, list] of rows) {
    const xs = list.map((a) => a.x).sort((a, b) => a - b)
    for (let i = 1; i < xs.length; i++) {
      const dx = r2(xs[i] - xs[i - 1])
      dxs.push(dx)
      if (dx < 28) dxUnder28++
      if (dx < 30) dxUnder30++
    }
  }
  const sorted = [...gaps].sort((a, b) => a - b)
  return {
    anchors: anchors.length,
    rows: yv.length,
    pairsUnder6: close,
    sameRowPairs: sameRow,
    crossRowPairs: crossRow,
    rowGapMin: sorted[0],
    rowGapMedian: sorted[Math.floor(sorted.length / 2)],
    densestRow: [...rows.entries()].map(([y, l]) => ({ y: Number(y), n: l.length })).sort((a, b) => b.n - a.n)[0],
    sameRowDxMin: dxs.length ? Math.min(...dxs) : null,
    sameRowDxDistinct: [...new Set(dxs)].sort((a, b) => a - b),
    dxUnder28,
    dxUnder30,
    row805: (rows.get('805') ?? []).map((a) => ({ net: a.net, x: a.x })).sort((a, b) => a.x - b.x),
  }
}

// per-net connectivity: count connected components over segment endpoints
const compsByNet = (() => {
  const out = {}
  for (const w of d.wires) {
    if (typeof w.net !== 'string' || !w.net) continue
    const line = Array.isArray(w.line) ? w.line : []
    const parent = new Map()
    const find = (k) => { let p = k; while (parent.get(p) !== p) p = parent.get(p); return p }
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb) }
    for (let i = 0; i + 1 < line.length; i += 2) { const k = `${line[i]},${line[i + 1]}`; if (!parent.has(k)) parent.set(k, k) }
    for (let i = 0; i + 3 < line.length; i += 2) union(`${line[i]},${line[i + 1]}`, `${line[i + 2]},${line[i + 3]}`)
    const roots = new Set([...parent.keys()].map(find))
    const cur = out[w.net] ?? { wires: 0, components: 0 }
    out[w.net] = { wires: cur.wires + 1, components: cur.components + roots.size }
  }
  return out
})()
const disconnected = Object.entries(compsByNet).filter(([, v]) => v.components > 1)

const shapes = {}
for (const w of d.wires) { const s = shapeOf(w); shapes[s] = (shapes[s] ?? 0) + 1 }

const out = {
  status: 'OK',
  main: d.main,
  pages: d.pages,
  comps: d.comps.length,
  wires: d.wires.length,
  nettedWires: d.wires.filter((w) => typeof w.net === 'string' && w.net).length,
  distinctNets: Object.keys(compsByNet).length,
  disconnectedNets: disconnected.map(([net, v]) => ({ net, ...v })),
  shapes,
  modelA_firstVertex: metrics('first'),
  modelB_longestMidpoint: metrics('mid'),
}
console.log(JSON.stringify(out, null, 1))
