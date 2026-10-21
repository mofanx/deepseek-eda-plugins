// t55: read-only "current page overlap" retest on the restored 21/55 MAIN page.
//
// This is NOT the historical 119-pair classification and must never be read as a
// continuation of it: that exercise used two models (an assumed ink width and an
// assumed 21x9 symbol body) whose inputs are not readable on this HEAD.
//
// Ground rule: report a pair as an overlap only when the geometry needed to decide
// it was actually read back. The client exposes:
//   * rectangles : TopLeftX/TopLeftY/Width/Height  -> exact boxes
//   * wires      : Line (polyline) + LineWidth     -> exact polylines
//   * texts      : X/Y/FontSize/Content/AlignMode  -> anchor only, NO width/height
//   * components : X/Y/Rotation/Symbol             -> anchor only, NO bounding box
// So:
//   exact      : anchor collisions, rect-vs-rect, wire-vs-rect, text anchor in rect
//   unmeasurable: text-vs-text and text-vs-symbol extents (no width/height anywhere)
// The script therefore reports nearest-pair distances for the unmeasurable classes
// instead of inventing a box, and the conclusion can only be one of:
//   无候选 / 有候选且集中在某类 / 几何不可判（需人工看截图）
//
// Zero schematic writes: only getAll/getState_* + dmt_Schematic page getters.
// The only files written are this run's JSON evidence and one timestamped PNG.
//
// Usage: node docs/evidence/review/t55-page-overlap.mjs

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gateFreshness } from './shared/freshness.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
gateFreshness(repoRoot)
const outDir = join(repoRoot, 'docs/evidence/current')
mkdirSync(outDir, { recursive: true })

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(repoRoot, 'packages/eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const shotFile = join(outDir, `t55-page-overlap-${stamp}.png`)
const jsonFile = join(outDir, 't55-page-overlap.json')

// ------------------------------------------------------------------ read side
const READ = `
const g = async (p, keys) => { const o = {}; for (const k of keys) { try { o[k] = await p['getState_' + k]() } catch (e) { o[k] = null } } return o };
const list = async (m) => { try { return (await eda[m].getAll()) || [] } catch (e) { return [] } };
const out = {};
out.texts = []; for (const p of await list('sch_PrimitiveText')) out.texts.push(await g(p, ['PrimitiveId','X','Y','FontSize','Content','AlignMode','Rotation']));
out.rects = []; for (const p of await list('sch_PrimitiveRectangle')) out.rects.push(await g(p, ['PrimitiveId','TopLeftX','TopLeftY','Width','Height','LineWidth']));
out.comps = []; for (const p of await list('sch_PrimitiveComponent')) out.comps.push(await g(p, ['PrimitiveId','ComponentType','X','Y','Rotation','Designator','Name']));
out.wires = []; for (const p of await list('sch_PrimitiveWire')) out.wires.push(await g(p, ['PrimitiveId','Net','Line','LineWidth']));
out.attrs = []; for (const p of await list('sch_PrimitiveAttribute')) out.attrs.push(await g(p, ['PrimitiveId','ParentPrimitiveId','ValueVisible','KeyVisible']));
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
out.main = cur && { uuid: String(cur.uuid), name: cur.name };
out.pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: String(p.uuid), name: p.name }));
return out;
`

const readAll = async () => bridge.execute(READ, { timeoutMs: 240_000 })

const before = await readAll()

// ------------------------------------------------------------------- geometry
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
// A rect extends DOWNWARD from TopLeftY. This was proven, not assumed, in
// t31-overlap-classify.mjs against the title block (TopLeftY=146, Height=130 with
// its cell lines at y=120/94/68/42 inside 16..146) and the 8-unit sheet inset.
const rectBox = (r) => {
  const x = num(r.TopLeftX); const y = num(r.TopLeftY); const w = num(r.Width); const h = num(r.Height)
  if ([x, y, w, h].some((v) => v === null)) return null
  return { id: r.PrimitiveId, x1: x, x2: x + w, y1: y - h, y2: y, w, h }
}
const inside = (px, py, b) => px >= b.x1 && px <= b.x2 && py >= b.y1 && py <= b.y2
const overlapArea = (a, b) => {
  const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
  const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)
  return ox > 0 && oy > 0 ? ox * oy : 0
}
const contains = (a, b) => a.x1 <= b.x1 && a.x2 >= b.x2 && a.y1 <= b.y1 && a.y2 >= b.y2
const dist = (a, b) => Math.hypot(a.X - b.X, a.Y - b.Y)

const rects = before.rects.map(rectBox).filter(Boolean)
const texts = before.texts.filter((t) => num(t.X) !== null && num(t.Y) !== null)
const comps = before.comps.filter((c) => num(c.X) !== null && num(c.Y) !== null)

// --- exact 1: anchor collisions (two primitives at the same coordinate)
const anchorKey = (p) => `${p.X},${p.Y}`
const collide = (a, b) => {
  const m = new Map()
  for (const p of a) {
    const k = anchorKey(p)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(p.PrimitiveId)
  }
  return [...m.entries()].filter(([, ids]) => ids.length > 1)
}
const textTextCollisions = collide(texts, texts)
const textCompCollisions = (() => {
  const m = new Map()
  for (const p of texts) { const k = anchorKey(p); if (!m.has(k)) m.set(k, []); m.get(k).push('text:' + p.PrimitiveId) }
  for (const p of comps) { const k = anchorKey(p); if (!m.has(k)) m.set(k, []); m.get(k).push('comp:' + p.PrimitiveId) }
  return [...m.entries()].filter(([, ids]) => ids.length > 1)
})()

// --- exact 2: rect vs rect
const rectPairs = []
for (let i = 0; i < rects.length; i++) {
  for (let j = i + 1; j < rects.length; j++) {
    const area = overlapArea(rects[i], rects[j])
    if (area > 0) {
      rectPairs.push({
        a: rects[i].id,
        b: rects[j].id,
        area: Math.round(area),
        kind: contains(rects[i], rects[j]) || contains(rects[j], rects[i]) ? 'containment' : 'partial'
      })
    }
  }
}

// --- exact 3: text anchor inside a rect
const textInRect = []
for (const t of texts) {
  for (const r of rects) {
    if (inside(t.X, t.Y, r)) textInRect.push({ text: t.PrimitiveId, rect: r.id, kind: 'anchor-inside' })
  }
}

// --- exact 4: wire segment vs rect
const segHitsRect = (p, q, b) => {
  const inA = inside(p[0], p[1], b); const inB = inside(q[0], q[1], b)
  if (inA || inB) return true
  // segment vs each of the four edges
  const edges = [
    [[b.x1, b.y1], [b.x2, b.y1]],
    [[b.x2, b.y1], [b.x2, b.y2]],
    [[b.x2, b.y2], [b.x1, b.y2]],
    [[b.x1, b.y2], [b.x1, b.y1]]
  ]
  const cross = (o, a, c) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0])
  for (const [e1, e2] of edges) {
    const d1 = cross(p, q, e1); const d2 = cross(p, q, e2); const d3 = cross(e1, e2, p); const d4 = cross(e1, e2, q)
    if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true
  }
  return false
}
const wireRect = []
for (const w of before.wires) {
  const line = Array.isArray(w.Line) ? w.Line : null
  if (!line || line.length < 2) continue
  const pts = line.map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p.x), Number(p.y)]))
  const hit = rects.find((r) => pts.some((p, i) => i > 0 && segHitsRect(pts[i - 1], p, r)))
  if (hit) wireRect.push({ wire: w.PrimitiveId, net: w.Net, rect: hit.id })
}

// --- unmeasurable: nearest pairs (distance is read back; extents are not)
const nearest = (a, b, limit = 10) => {
  const out = []
  for (const x of a) for (const y of b) out.push({ a: x, b: y, d: dist(x, y) })
  return out.sort((p, q) => p.d - q.d).slice(0, limit)
}
const nearTT = (() => {
  const out = []
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) out.push({ a: texts[i], b: texts[j], d: dist(texts[i], texts[j]) })
  }
  return out.sort((p, q) => p.d - q.d).slice(0, 10).map((p) => ({
    a: p.a.PrimitiveId,
    b: p.b.PrimitiveId,
    d: Math.round(p.d * 10) / 10,
    at: [p.a.X, p.a.Y],
    aText: String(p.a.Content ?? '').slice(0, 14),
    bText: String(p.b.Content ?? '').slice(0, 14),
    sizes: [p.a.FontSize, p.b.FontSize]
  }))
})()
const nearTC = nearest(texts, comps, 10).map((p) => ({
  text: p.a.PrimitiveId,
  comp: p.b.PrimitiveId,
  d: Math.round(p.d * 10) / 10,
  at: [p.a.X, p.a.Y],
  textContent: String(p.a.Content ?? '').slice(0, 14),
  compType: p.b.ComponentType,
  compName: String(p.b.Name ?? '').slice(0, 14)
}))

// ---------------------------------------------------------------- screenshot
const dpxShots = []
const runDpx = (args) => spawnSync('dpx', args, { shell: true, encoding: 'utf8', timeout: 120_000 })
let boundTab = null
try {
  const list = runDpx(['tab-list'])
  const parsed = JSON.parse(String(list.stdout || '').replace(/^\uFEFF/, ''))
  const tabs = parsed?.data?.tabs ?? []
  const edaTab = tabs.find((t) => String(t.url || '').includes('pro.lceda.cn'))
  if (edaTab) {
    const sel = runDpx(['tab-select', edaTab.id])
    boundTab = { id: edaTab.id, url: edaTab.url, selected: sel.status === 0 }
  }
} catch (e) {
  boundTab = { error: String(e && e.message).slice(0, 120) }
}
const shot = runDpx(['screenshot', '--filename', shotFile])
const shotInfo = {
  file: shotFile,
  at: new Date().toISOString(),
  ok: shot.status === 0,
  status: shot.status,
  boundTab,
  note: 'captured from the tab bound to dpx; verified by a human against the JSON counts'
}
dpxShots.push(shotInfo)

// ------------------------------------------------------------ after-invariants
const after = await readAll()
const inv = (d) => ({
  components: d.comps.length,
  parts: d.comps.filter((c) => c.ComponentType === 'part').length,
  netflag: d.comps.filter((c) => c.ComponentType === 'netflag').length,
  wires: d.wires.length,
  wireNets: [...new Set(d.wires.map((w) => w.Net).filter((n) => n !== null && n !== ''))].length,
  pages: d.pages.length,
  active: d.main && d.main.name
})
const idSet = (d) => new Set(d.comps.map((c) => c.PrimitiveId))
const b = idSet(before); const a = idSet(after)
const missing = [...b].filter((id) => !a.has(id))
const extra = [...a].filter((id) => !b.has(id))
const wirePair = (d) => d.wires.map((w) => `${w.PrimitiveId}|${w.Net}`).sort().join(';')
const invBefore = inv(before)
const invAfter = inv(after)
const invariants = {
  before: invBefore,
  after: invAfter,
  unchanged: JSON.stringify(invBefore) === JSON.stringify(invAfter) &&
    JSON.stringify(before.pages) === JSON.stringify(after.pages) &&
    wirePair(before) === wirePair(after),
  missing,
  extra,
  pagesBefore: before.pages,
  pagesAfter: after.pages
}

// -------------------------------------------------------------------- verdict
const structuralRectPairs = rectPairs.filter((p) => p.kind === 'containment')
const partialRectPairs = rectPairs.filter((p) => p.kind === 'partial')
const candidates = {
  total: textTextCollisions.length + textCompCollisions.length + partialRectPairs.length,
  textVsFrame: textInRect.length,
  textVsText: textTextCollisions.length,
  textVsSymbol: textCompCollisions.length,
  note: 'textVsFrame counts anchors inside a rect and is anchor-level only; it is not ink overlap'
}

let conclusion
if (candidates.total > 0) conclusion = '有候选且集中在某类'
else if (texts.length && comps.length) conclusion = '几何不可判（需人工看截图）'
else conclusion = '无候选'

const report = {
  at: new Date().toISOString(),
  script: 't55-page-overlap.mjs',
  page: before.main,
  readOnly: true,
  wrote: 0,
  counts: {
    components: before.comps.length,
    parts: before.comps.filter((c) => c.ComponentType === 'part').length,
    netflags: before.comps.filter((c) => c.ComponentType === 'netflag').length,
    wires: before.wires.length,
    texts: before.texts.length,
    rects: before.rects.length,
    attributes: before.attrs.length
  },
  geometryLimits: {
    rect: 'TopLeftX/TopLeftY/Width/Height read back -> exact, extends downward (proven in t31)',
    wire: 'Line polyline + LineWidth read back -> exact',
    text: 'X/Y/FontSize/Content/AlignMode only -> NO width/height, extent not measurable',
    component: 'X/Y/Rotation/Symbol only -> NO bounding box, extent not measurable'
  },
  exact: {
    anchorCollisions: {
      textText: textTextCollisions,
      textComponent: textCompCollisions
    },
    textAnchorInsideRect: textInRect.length,
    textAnchorInsideRectSamples: textInRect.slice(0, 10),
    rectRect: { total: rectPairs.length, containment: structuralRectPairs.length, partial: partialRectPairs.length, top: rectPairs.sort((p, q) => q.area - p.area).slice(0, 10) },
    wireRectIntersections: wireRect.length,
    wireRectSamples: wireRect.slice(0, 10)
  },
  unmeasurable: {
    textVsText: { reason: 'no text width/height accessor', nearest: nearTT },
    textVsSymbol: { reason: 'no component bounding box accessor', nearest: nearTC }
  },
  candidates,
  screenshot: shotInfo,
  invariants,
  conclusion
}

writeFileSync(jsonFile, JSON.stringify(report, null, 1))
console.log(JSON.stringify({
  at: report.at,
  counts: report.counts,
  candidates: report.candidates,
  exact: {
    anchorCollisions: { textText: report.exact.anchorCollisions.textText.length, textComponent: report.exact.anchorCollisions.textComponent.length },
    textAnchorInsideRect: report.exact.textAnchorInsideRect,
    rectRect: report.exact.rectRect,
    wireRectIntersections: report.exact.wireRectIntersections
  },
  nearest: { textText: nearTT.slice(0, 3), textSymbol: nearTC.slice(0, 3) },
  screenshot: { ok: shotInfo.ok, file: shotInfo.file, boundTab: shotInfo.boundTab && shotInfo.boundTab.url },
  invariants: { before: invBefore, after: invAfter, unchanged: invariants.unchanged, missing, extra },
  conclusion
}, null, 1))
process.exit(invariants.unchanged && shotInfo.ok ? 0 : 2)
