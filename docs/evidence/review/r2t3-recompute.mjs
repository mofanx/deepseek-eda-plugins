/**
 * r2t3 — offline recompute from docs/evidence/current/t31-dataset.json
 * (a full read-only snapshot: 55 wires, 662 attrs, 21 comps, 39 texts).
 *
 * No bridge. Re-derives, independently of r2t1's report:
 *   - segments / fake diagonals under stride 2 vs stride 4
 *   - t38's per-net connectivity (compsByNet) under both strides, including
 *     distinctNets and disconnectedNets, because "midpoints unchanged" does not
 *     cover that second traversal (t38 L109-114)
 *   - the r9t1 funnel (188 / 32 / 45 / 68 / 13) and the step-2 47 / 34
 *   - t26's sample wire (first wire with a non-empty net) and its line length
 */
import { readFileSync } from 'node:fs'
import { serializeEasyEdaDocument } from '../../../packages/eda-core/lib/index.js'

const d = JSON.parse(readFileSync(new URL('../current/t31-dataset.json', import.meta.url), 'utf8'))
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const segs = (line, stride) => {
  const out = []
  for (let i = 0; i + 3 < line.length; i += stride) out.push([line[i], line[i + 1], line[i + 2], line[i + 3]])
  return out
}
const diag = (s) => s[0] !== s[2] && s[1] !== s[3]
const byStride = (stride) => {
  const all = []
  for (const w of d.wires) { const a = Array.isArray(w.Line) ? w.Line.map(num) : []; if (a.every((v) => v !== null)) all.push(...segs(a, stride).map((s) => ({ ...s, net: w.Net }))) }
  return all
}
const s2 = byStride(2)
const s4 = byStride(4)
const shape = (line, stride) => {
  const g = segs(line, stride)
  if (g.length === 0) return 'point'
  const h = g.every((s) => s[1] === s[3])
  const v = g.every((s) => s[0] === s[2])
  return `${g.length}x${h ? 'H' : v ? 'V' : 'poly'}`
}
const polyWires = d.wires.filter((w) => w.Line.length > 4).map((w) => ({ net: w.Net, len: w.Line.length, s2: shape(w.Line, 2), s4: shape(w.Line, 4) }))

// t38 compsByNet, exactly its union loop, for one stride
const connectivity = (stride) => {
  const out = {}
  for (const w of d.wires) {
    if (typeof w.Net !== 'string' || !w.Net) continue
    const line = w.Line
    const parent = new Map()
    const find = (k) => { let p = k; while (parent.get(p) !== p) p = parent.get(p); return p }
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb) }
    for (let i = 0; i + 1 < line.length; i += 2) { const k = `${line[i]},${line[i + 1]}`; if (!parent.has(k)) parent.set(k, k) }
    for (let i = 0; i + 3 < line.length; i += stride) union(`${line[i]},${line[i + 1]}`, `${line[i + 2]},${line[i + 3]}`)
    const roots = new Set([...parent.keys()].map(find))
    const cur = out[w.Net] ?? { wires: 0, components: 0 }
    out[w.Net] = { wires: cur.wires + 1, components: cur.components + roots.size }
  }
  return out
}
const c2 = connectivity(2)
const c4 = connectivity(4)
const diffNets = Object.keys(c2).filter((n) => c2[n].components !== c4[n].components).map((n) => ({ net: n, s2: c2[n].components, s4: c4[n].components }))
const disconnected2 = Object.entries(c2).filter(([, v]) => v.components > 1)
const disconnected4 = Object.entries(c4).filter(([, v]) => v.components > 1)

// r9t1 funnel, stride 4 with own-wire semantics
const distPointSeg = (px, py, s) => {
  const dx = s[2] - s[0], dy = s[3] - s[1]
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / l2))
  return { d: Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy)), t }
}
const attrs = d.attrs
const g = (a, k) => a[k]
const base = attrs.filter((a) => num(g(a, 'X')) !== null && num(g(a, 'Y')) !== null && String(g(a, 'Value') ?? '').trim() !== '' && g(a, 'ValueVisible') !== false)
const hit = (a, stride, skipOwn) => {
  const x = num(g(a, 'X')), y = num(g(a, 'Y')), p = String(g(a, 'ParentPrimitiveId') ?? '')
  let best = null
  for (const s of stride === 4 ? s4 : s2) {
    if (skipOwn && s.wire === undefined && p === s.net) continue
    const r = distPointSeg(x, y, s)
    if (!best || r.d < best.d) best = { ...r, seg: s }
  }
  return best && best.d <= 6 && best.t > 0.05 && best.t < 0.95 ? best : null
}
// wire id is not in the flattened segment list; rebuild per-wire to honor skipOwn
const wiresById = new Map(d.wires.map((w) => [w.PrimitiveId, w]))
const hitW = (a, stride, skipOwn) => {
  const x = num(g(a, 'X')), y = num(g(a, 'Y')), p = String(g(a, 'ParentPrimitiveId') ?? '')
  let best = null
  for (const w of d.wires) {
    if (skipOwn && w.PrimitiveId === p) continue
    for (const s of segs(w.Line, stride)) {
      const r = distPointSeg(x, y, s)
      if (!best || r.d < best.d) best = { ...r, seg: { ...s, wire: w.PrimitiveId, net: w.Net } }
    }
  }
  return best && best.d <= 6 && best.t > 0.05 && best.t < 0.95 ? best : null
}
const flagIds = new Set(d.comps.map((c) => c.PrimitiveId).filter((id) => String(id).startsWith('layout:flag:')))
const wireIds = new Set(d.wires.map((w) => w.PrimitiveId))
const netLabel = (a) => {
  const p = String(g(a, 'ParentPrimitiveId') ?? '')
  return g(a, 'Key') === 'Name' && String(g(a, 'Value') ?? '') !== '' && (flagIds.has(p) || wireIds.has(p))
}
const f = {
  attrs: attrs.length,
  withXY: attrs.filter((a) => num(g(a, 'X')) !== null && num(g(a, 'Y')) !== null).length,
  withValue: attrs.filter((a) => num(g(a, 'X')) !== null && num(g(a, 'Y')) !== null && String(g(a, 'Value') ?? '').trim() !== '').length,
  visible: base.length,
  hits4: base.filter((a) => hitW(a, 4, false)).length,
  skipOwn4: base.filter((a) => hitW(a, 4, true)).length,
  netLabels: attrs.filter(netLabel).length,
  candidates4: attrs.filter(netLabel).filter((a) => { const b = hitW(a, 4, true); return b && b.seg.net !== String(g(a, 'Value') ?? '') }).length,
  hits2: attrs.filter((a) => num(g(a, 'X')) !== null && num(g(a, 'Y')) !== null && String(g(a, 'Value') ?? '').trim() !== '' && hitW(a, 2, false)).length,
  visibleHits2: base.filter((a) => hitW(a, 2, false)).length,
}

const sample = d.wires.find((w) => typeof w.Net === 'string' && w.Net !== '')
// The REAL t26 fixture: its sample is the first netted wire (+3V3, 20 numbers).
const realIr = sample ? (() => {
  const ir = { sheets: [{ components: [], wires: [{ id: 'w', kind: 'wire', dots: [sample.Line], net: sample.Net }], busEntries: [], junctions: [], attrs: [] }] }
  const segsOut = serializeEasyEdaDocument(ir).split('\n').filter((l) => l.startsWith('{"type":"LINE"'))
  const isDiag = (l) => { const m = l.match(/"startX":(-?[\d.]+),"startY":(-?[\d.]+),"endX":(-?[\d.]+),"endY":(-?[\d.]+)/); return m && Number(m[1]) !== Number(m[3]) && Number(m[2]) !== Number(m[4]) }
  return { lines: segsOut.length, diagonals: segsOut.filter(isDiag).length }
})() : null
console.log(JSON.stringify({
  wires: d.wires.length,
  numbers: d.wires.reduce((n, w) => n + w.Line.length, 0),
  stride2: { segments: s2.length, diagonals: s2.filter(diag).length },
  stride4: { segments: s4.length, diagonals: s4.filter(diag).length },
  polyWires,
  t38_connectivity: {
    stride2: { distinctNets: Object.keys(c2).length, disconnected: disconnected2.map(([n, v]) => ({ net: n, components: v.components })) },
    stride4: { distinctNets: Object.keys(c4).length, disconnected: disconnected4.map(([n, v]) => ({ net: n, components: v.components })) },
    netsWithDifferentComponentCount: diffNets,
  },
  funnel: f,
  t26Sample: sample ? { net: sample.Net, len: sample.Line.length, asIrDots: realIr } : null,
}, null, 1))
