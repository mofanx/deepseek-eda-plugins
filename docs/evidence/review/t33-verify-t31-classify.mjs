// t33: independent read-only recomputation of the t31 overlap classification.
//
// This does not import or call t31's script. It reads the same page with its own
// single execute call and recomputes every class from the raw state, so the
// numbers can be checked against t1's claim rather than trusted.
//
// Read-only: every call is a getter. Page and component counts are read before
// and after, and the run fails if either changed.
//
// Usage: node docs/evidence/review/t33-verify-t31-classify.mjs
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../../..')
const pkgDir = join(repoRoot, 'packages')

function newestMtime(dir, ext) {
  let newest = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue
        walk(full)
      } else if (e.name.endsWith(ext)) newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  if (existsSync(dir)) walk(dir)
  return newest
}

const gateSrc = newestMtime(join(pkgDir, 'eda-core/src'), '.ts')
const gateLib = newestMtime(join(pkgDir, 'eda-core/lib'), '.js')
const freshness = { src: new Date(gateSrc).toISOString(), lib: new Date(gateLib).toISOString(), fresh: gateLib >= gateSrc }
if (!freshness.fresh) {
  console.error(JSON.stringify({ status: 'STALE_BUILD', freshness }, null, 1))
  process.exit(1)
}

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function call(code, timeoutMs = 90_000) {
  let last
  for (let i = 0; i < 3; i++) {
    try {
      return await bridge.execute(code, { timeoutMs })
    } catch (e) {
      last = e
      await sleep(1000)
    }
  }
  throw last
}

// One read, everything the classification needs, nothing written.
const raw = await call(`
const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
const comps = ((await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []).length;
const rects = [];
for (const r of ((await eda.sch_PrimitiveRectangle.getAll()) || [])) {
  rects.push({ id: r.getState_PrimitiveId(), x: r.getState_TopLeftX(), y: r.getState_TopLeftY(), w: r.getState_Width(), h: r.getState_Height() });
}
const texts = [];
for (const t of ((await eda.sch_PrimitiveText.getAll()) || [])) {
  texts.push({ id: t.getState_PrimitiveId(), x: t.getState_X(), y: t.getState_Y(), content: t.getState_Content(), fs: t.getState_FontSize() });
}
const wires = [];
for (const w of ((await eda.sch_PrimitiveWire.getAll()) || [])) {
  let line = null;
  try { line = w.getState_Line() } catch (e) {}
  let dots = null;
  try { dots = w.getState_Dots ? w.getState_Dots() : null } catch (e) {}
  let net = null;
  try { net = w.getState_Net() } catch (e) {}
  wires.push({ id: w.getState_PrimitiveId(), net, line, dots });
}
const keys = {};
const visVar = { valueVisibleTrue: 0, keyVisibleTrue: 0, nonEmptyValue: 0, both: 0 };
for (const a of ((await eda.sch_PrimitiveAttribute.getAll()) || [])) {
  let key = null, vv = null, kv = null, val = null;
  try { key = a.getState_Key() } catch (e) {}
  try { vv = a.getState_ValueVisible() } catch (e) {}
  try { kv = a.getState_KeyVisible() } catch (e) {}
  try { val = a.getState_Value() } catch (e) {}
  keys[String(key)] = (keys[String(key)] || 0) + 1;
  if (vv === true) visVar.valueVisibleTrue += 1;
  if (kv === true) visVar.keyVisibleTrue += 1;
  if (typeof val === 'string' && val !== '') visVar.nonEmptyValue += 1;
  if (vv === true && typeof val === 'string' && val !== '') visVar.both += 1;
}
return { pages, comps, rects, texts, wires, attrKeys: keys, attrVis: visVar, main: (await eda.dmt_Schematic.getCurrentSchematicPageInfo()).uuid };
`)

// ---- recomputation ---------------------------------------------------------
const eps = 0.001
const onEdge = (px, py, r) => {
  const x0 = r.x
  const x1 = r.x + r.w
  const y0 = r.y
  const y1 = r.y + r.h
  const withinX = px >= x0 - eps && px <= x1 + eps
  const withinY = py >= y0 - eps && py <= y1 + eps
  if (withinX && (Math.abs(py - y0) <= eps || Math.abs(py - y1) <= eps)) return true
  if (withinY && (Math.abs(px - x0) <= eps || Math.abs(px - x1) <= eps)) return true
  return false
}
const intersections = (a, b) => {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return ox > 0 && oy > 0 ? { ox, oy, area: ox * oy } : null
}

const rects = raw.rects.filter((r) => [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number'))

// class A: frame x frame
const rectPairs = []
for (let i = 0; i < rects.length; i++) {
  for (let j = i + 1; j < rects.length; j++) {
    const hit = intersections(rects[i], rects[j])
    if (hit) rectPairs.push({ a: rects[i].id, b: rects[j].id, ...hit })
  }
}
// containment is not a crossing: report both so the definition is visible
const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h
const nested = rectPairs.filter((p) => {
  const A = rects.find((r) => r.id === p.a)
  const B = rects.find((r) => r.id === p.b)
  return (A && B) && (contains(A, B) || contains(B, A))
})

// class B: wire vertices exactly on a rectangle edge
// getState_Line() returns a FLAT coordinate list for a polyline, not a list of
// segments: "+3V3" came back as 20 numbers = 10 points. Treating it as one
// segment silently collapses a 10-point path to 2 endpoints, which is exactly
// the mistake this file made on its first run (reported 2 vertices where the
// truth is 11). Both shapes are accepted here.
const pointsOf = (w) => {
  const out = []
  const arr = w.line
  if (Array.isArray(arr)) {
    if (Array.isArray(arr[0])) {
      for (const s of arr) {
        if (!Array.isArray(s)) continue
        if (s.length >= 4) out.push([s[0], s[1]], [s[2], s[3]])
        else if (s.length >= 2) out.push([s[0], s[1]])
      }
    } else {
      for (let i = 0; i + 1 < arr.length; i += 2) {
        if (typeof arr[i] === 'number' && typeof arr[i + 1] === 'number') out.push([arr[i], arr[i + 1]])
      }
    }
  }
  if (Array.isArray(w.dots)) for (const s of w.dots) if (Array.isArray(s) && s.length >= 2) out.push([s[0], s[1]])
  return out
}
const vertexHits = []
const vertexStats = {}
for (const w of raw.wires) {
  const pts = pointsOf(w)
  const hits = []
  for (const [px, py] of pts) {
    for (const r of rects) {
      if (onEdge(px, py, r)) {
        hits.push({ wire: w.id, net: w.net, x: px, y: py, rect: r.id })
        vertexHits.push({ wire: w.id, net: w.net, x: px, y: py, rect: r.id })
      }
    }
  }
  if (hits.length) {
    vertexStats[w.id] = {
      pathVertices: pts.length,
      onEdgePathVisits: hits.length,
      distinctOnEdge: new Set(hits.map((h) => `${h.x},${h.y}`)).size,
      edges: [...new Set(hits.map((h) => h.rect))],
    }
  }
}
const hitWires = new Set(vertexHits.map((h) => h.wire))

// class C: visible text sharing one anchor
const anchors = new Map()
for (const t of raw.texts) {
  if (typeof t.x !== 'number' || typeof t.y !== 'number') continue
  const k = `${t.x},${t.y}`
  if (!anchors.has(k)) anchors.set(k, [])
  anchors.get(k).push(t)
}
const clusters = [...anchors.entries()].filter(([, list]) => list.length > 1).map(([k, list]) => ({ anchor: k, n: list.length, ids: list.map((t) => t.id) }))

const out = {
  status: 'OK',
  freshness,
  readback: {
    pages: raw.pages.length,
    comps: raw.comps,
    rects: rects.length,
    texts: raw.texts.length,
    wires: raw.wires.length,
    attrs: Object.values(raw.attrKeys).reduce((a, b) => a + b, 0),
    netAttributeCount: raw.attrKeys.NET || 0,
    attrVisVariants: raw.attrVis,
    attrTopKeys: Object.entries(raw.attrKeys).sort((a, b) => b[1] - a[1]).slice(0, 6),
  },
  classes: {
    frameVsFrame: { intersectingPairs: rectPairs.length, nestedOrContaining: nested.length, totalArea: rectPairs.reduce((s, p) => s + p.area, 0) },
    wireVertexOnFrameEdge: { vertices: vertexHits.length, distinctVertices: new Set(vertexHits.map((h) => `${h.wire}@${h.x},${h.y}`)).size, wires: hitWires.size, ofWires: raw.wires.length, perWire: vertexStats, areaAvailable: false },
    textSameAnchorCluster: { clusters: clusters.length, textsInClusters: clusters.reduce((s, c) => s + c.n, 0), areaAvailable: false },
    textVsSymbolBody: { measurable: false, reason: 'text primitives expose no width/height and components expose no body box' },
    textVsFrameTitle: { measurable: false, reason: 'no title-block box distinct from the frame rectangle' },
  },
  instances: {
    rects: rects.slice(0, 3).map((r) => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, computedRight: r.x + r.w, computedBottom: r.y + r.h })),
    vertexHits: vertexHits.slice(0, 3),
  },
}

// ---- read-only proof: second read must match the first ---------------------
const after = await call(`
return {
  pages: (((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [])).length,
  comps: (((await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [])).length,
  main: (await eda.dmt_Schematic.getCurrentSchematicPageInfo()).uuid,
};
`)
out.invariants = {
  before: { pages: raw.pages.length, comps: raw.comps, main: raw.main },
  after: { pages: after.pages, comps: after.comps, main: after.main },
  unchanged: raw.pages.length === after.pages && raw.comps === after.comps && raw.main === after.main,
}
out.status = out.invariants.unchanged ? 'OK' : 'PAGE_CHANGED'

console.log(JSON.stringify(out, null, 1))
process.exitCode = out.status === 'OK' ? 0 : 1
