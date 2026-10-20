// t31: classify the "text occludes something" pairs on the delivered MAIN page.
//
// READ-ONLY. Only get*/getAll calls. No page is created, nothing is modified.
// The script asserts at the end that the page list and MAIN's component count
// are exactly what they were at the start.
//
// Ground rule: a number is reported only when it is read back. Where the client
// exposes no accessor for the geometry a class needs, the class is reported as
// NOT MEASURABLE instead of being estimated from a font metric or a symbol-size
// table. The reason matters: the 119-pair figure being re-examined was itself
// produced with two such models (an assumed ink width and an assumed 21x9 body),
// and both of their inputs are unreadable on this HEAD.
//
// Usage: node docs/evidence/review/t31-overlap-classify.mjs
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../../..')
const pkgDir = join(repoRoot, 'packages')
const outDir = join(repoRoot, 'docs/evidence/current')

// ---------------------------------------------------------------- preflight
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

const gate = { src: newestMtime(join(pkgDir, 'eda-core/src'), '.ts'), lib: newestMtime(join(pkgDir, 'eda-core/lib'), '.js') }
gate.fresh = gate.lib >= gate.src
if (!gate.fresh) {
  console.error(JSON.stringify({ status: 'STALE_BUILD', ...gate, hint: 'run npx tsdown first' }, null, 1))
  process.exit(1)
}

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })

const get = async (p, keys) => {
  const o = {}
  for (const k of keys) {
    try {
      const v = await p[`getState_${k}`]()
      if (typeof v !== 'function') o[k] = v
    } catch (e) { o[k] = null }
  }
  return o
}

const data = await bridge.execute(`
const get = async (p, keys) => {
  const o = {};
  for (const k of keys) {
    try { o[k] = await p['getState_' + k]() } catch (e) { o[k] = null }
  }
  return o;
};
const list = async (m) => { try { return (await eda[m].getAll()) || [] } catch (e) { return [] } };
const out = {};
out.texts = [];
for (const p of await list('sch_PrimitiveText')) out.texts.push(await get(p, ['PrimitiveId','X','Y','FontSize','Content','Rotation','AlignMode']));
out.rects = [];
for (const p of await list('sch_PrimitiveRectangle')) out.rects.push(await get(p, ['PrimitiveId','TopLeftX','TopLeftY','Width','Height','LineWidth']));
out.wires = [];
for (const p of await list('sch_PrimitiveWire')) out.wires.push(await get(p, ['PrimitiveId','Net','Line','LineWidth']));
out.comps = [];
for (const p of await list('sch_PrimitiveComponent')) out.comps.push(await get(p, ['PrimitiveId','X','Y','Designator','Name']));
out.attrs = [];
for (const p of await list('sch_PrimitiveAttribute')) out.attrs.push(await get(p, ['PrimitiveId','Key','Value','X','Y','FontSize','ValueVisible','KeyVisible','ParentPrimitiveId']));
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
out.pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: p.uuid, name: p.name }));
out.main = cur && { uuid: cur.uuid, name: cur.name };
return out;
`, { timeoutMs: 240_000 })

const { texts, rects, wires, comps, attrs, pages, main } = data
const nums = (v) => (Array.isArray(v) ? v : []).filter((n) => typeof n === 'number' && Number.isFinite(n))
const boxes = rects
  .map((r) => ({ id: r.PrimitiveId, x1: r.TopLeftX, y1: r.TopLeftY, x2: r.TopLeftX + r.Width, y2: r.TopLeftY + r.Height, w: r.Width, h: r.Height, lw: r.LineWidth ?? 1 }))
  .filter((b) => [b.x1, b.y1, b.x2, b.y2].every(Number.isFinite))

const distToBox = (px, py, b) => {
  const dx = Math.max(b.x1 - px, 0, px - b.x2)
  const dy = Math.max(b.y1 - py, 0, py - b.y2)
  if (dx === 0 && dy === 0) return -Math.min(px - b.x1, b.x2 - px, py - b.y1, b.y2 - py) // inside: negative depth
  return Math.hypot(dx, dy)
}
const inside = (px, py, b) => px >= b.x1 && px <= b.x2 && py >= b.y1 && py <= b.y2
const overlap = (a, b) => {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)
  return w > 0 && h > 0 ? { w, h } : null
}
const round = (n) => Math.round(n * 100) / 100

const report = { status: 'OK', fresh: { src: new Date(gate.src).toISOString(), lib: new Date(gate.lib).toISOString() } }
report.scope = { main, pageCount: pages.length, compCount: comps.length, textCount: texts.length, rectCount: rects.length, wireCount: wires.length, attrCount: attrs.length }

// ---- what the client does and does not expose ------------------------------
report.accessors = {
  rect: ['TopLeftX', 'TopLeftY', 'Width', 'Height'],
  text: ['X', 'Y', 'FontSize', 'Content', 'Rotation', 'AlignMode'],
  attribute: ['X', 'Y', 'FontSize', 'Value', 'Key', 'ValueVisible', 'KeyVisible'],
  component: ['X', 'Y', 'Designator', 'Name'],
  wire: ['Line', 'Net', 'LineWidth'],
  missingForInkOverlap: ['text width', 'text height', 'component body box'],
}
report.visibleAttributes = attrs.filter((a) => a.ValueVisible === true || a.KeyVisible === true).length

// ---- class 1 (EXACT): rectangle vs rectangle -------------------------------
// Only two *module frames* crossing each other is a defect. The sheet's own
// outer/inner border pair and the grid ticks overlap by design, and a frame
// sitting inside the sheet is containment, not a collision.
const areaOf = (b) => b.w * b.h
const sheetIds = new Set([...boxes].sort((x, y) => areaOf(y) - areaOf(x)).slice(0, 2).map((b) => b.id))
const kindOf = (b) => (b.w === 0 || b.h === 0 ? 'tick' : sheetIds.has(b.id) ? 'sheet' : 'frame')
const rectCrossing = []
const rectByKind = {}
for (let i = 0; i < boxes.length; i++) {
  for (let j = i + 1; j < boxes.length; j++) {
    const o = overlap(boxes[i], boxes[j])
    if (!o) continue
    const ka = kindOf(boxes[i])
    const kb = kindOf(boxes[j])
    const pair = [ka, kb].sort().join('x')
    rectByKind[pair] = (rectByKind[pair] ?? 0) + 1
    if (ka === 'frame' && kb === 'frame') rectCrossing.push({ a: boxes[i].id, b: boxes[j].id, w: round(o.w), h: round(o.h), area: round(o.w * o.h) })
  }
}
report.rectVsRect = {
  overlapPairsByKind: rectByKind,
  frameVsFrameCrossing: rectCrossing.length,
  frameVsFrameArea: round(rectCrossing.reduce((s, p) => s + p.area, 0)),
  examples: rectCrossing.slice(0, 3),
  note: 'sheet border + grid ticks overlap by design; frame-vs-frame is the only defect class',
}

// ---- attribute key histogram (shows what actually carries text) ------------
const keyHist = {}
for (const a of attrs) keyHist[a.Key ?? '(null)'] = (keyHist[a.Key ?? '(null)'] ?? 0) + 1
report.attributeKeys = Object.entries(keyHist).sort((a, b) => b[1] - a[1]).slice(0, 8)
report.netAttributeCount = attrs.filter((a) => a.Key === 'NET').length

// ---- class 2 (EXACT): wire/router contact with a frame edge ----------------
const frameBoxes = boxes.filter((b) => b.w < 900 && b.h < 1200) // exclude the page border pair
const wireTouches = []
for (const w of wires) {
  const line = nums(w.Line)
  for (let i = 0; i + 1 < line.length; i += 2) {
    const px = line[i]
    const py = line[i + 1]
    let best = Infinity
    let who = null
    for (const b of frameBoxes) {
      const d = distToBox(px, py, b)
      if (Math.abs(d) < Math.abs(best)) { best = d; who = b.id }
    }
    if (Number.isFinite(best) && Math.abs(best) <= 0.5) wireTouches.push({ wire: w.PrimitiveId, net: w.Net, x: px, y: py, rect: who, d: round(best) })
  }
}
const touchWires = new Set(wireTouches.map((t) => t.wire))
report.wireOnFrameEdge = {
  verticesOnEdge: wireTouches.length,
  wiresAffected: touchWires.size,
  ofWires: wires.length,
  examples: wireTouches.slice(0, 3),
}

// ---- class 3 (EXACT): where the NET label anchor sits -----------------------
// serialize.ts:319 anchors the wire's NET attribute at the wire's first vertex.
const netAttrs = attrs.filter((a) => a.Key === 'NET')
const netAnchorRows = netAttrs.map((a) => {
  let best = Infinity
  let who = null
  for (const b of frameBoxes) {
    const d = distToBox(a.X, a.Y, b)
    if (Math.abs(d) < Math.abs(best)) { best = d; who = b.id }
  }
  return { id: a.PrimitiveId, net: a.Value, x: a.X, y: a.Y, nearestRect: who, d: round(best), insideFrame: frameBoxes.some((b) => inside(a.X, a.Y, b)) }
}).filter((r) => Number.isFinite(r.d))
report.netLabelAnchors = {
  count: netAnchorRows.length,
  onEdge: netAnchorRows.filter((r) => r.d >= -0.5 && r.d <= 0.5).length,
  insideFrame: netAnchorRows.filter((r) => r.insideFrame).length,
  nearestDistances: { min: round(Math.min(...netAnchorRows.map((r) => Math.abs(r.d)))), max: round(Math.max(...netAnchorRows.map((r) => Math.abs(r.d)))) },
  examples: netAnchorRows.slice(0, 3),
  verifiedAgainst: 'eda-core/src/serialize.ts:319 emits ATTR NET at the wire first vertex; the anchor is read back, not inferred',
}

// ---- class 4 (EXACT): two labels anchored on the same point ----------------
const anchors = [...texts.map((t) => ({ id: t.PrimitiveId, kind: 'text', x: t.X, y: t.Y })), ...attrs.filter((a) => a.ValueVisible === true).map((a) => ({ id: a.PrimitiveId, kind: 'attr', x: a.X, y: a.Y }))].filter((a) => Number.isFinite(a.x) && Number.isFinite(a.y))
const clusters = []
const used = new Set()
for (let i = 0; i < anchors.length; i++) {
  if (used.has(i)) continue
  const group = [anchors[i]]
  for (let j = i + 1; j < anchors.length; j++) {
    if (used.has(j)) continue
    if (Math.abs(anchors[i].x - anchors[j].x) <= 0.5 && Math.abs(anchors[i].y - anchors[j].y) <= 0.5) { group.push(anchors[j]); used.add(j) }
  }
  if (group.length > 1) { used.add(i); clusters.push(group) }
}
report.sharedAnchors = { clusters: clusters.length, items: clusters.reduce((s, c) => s + c.length, 0), examples: clusters.slice(0, 3).map((c) => c.map((g) => `${g.kind}:${g.id}@(${g.x},${g.y})`)) }

// ---- what cannot be measured ----------------------------------------------
report.notMeasurable = [
  {
    cls: 'text ink vs component body',
    why: 'no accessor returns a text width/height or a component body box; text exposes only X/Y/FontSize/Content, component only X/Y',
    consequence: 'the 119-pair figure (doc line 1820) cannot be reproduced from read-back; its worked example uses an assumed 28-unit ink width and an assumed 21x9 body, neither of which is readable',
    wouldNeed: 'a bbox accessor, or an agreed metric model (then it is a model, not a measurement)',
  },
  {
    cls: 'text ink vs frame title',
    why: 'same missing width; and nothing in the document marks which text is a frame title, so the role would be inferred from position rather than read',
    consequence: 'not classifiable as a distinct class from read-back alone',
    wouldNeed: 'an emitted role/attribute on title text, which we control',
  },
]

// ---- invariants -----------------------------------------------------------
// A second, cheap read AFTER the dump: the page list and MAIN's component count
// must be what the dump saw. Comparing the dump against itself would be a
// tautology and would pass even if this script had mutated something.
const after = await bridge.execute(`
const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
return { pageCount: pages.length, compCount: comps.length, mainStillThere: pages.includes(cur && cur.uuid) };
`, { timeoutMs: 60_000 })

report.invariants = {
  pageCountUnchanged: after.pageCount === pages.length,
  compCountUnchanged: after.compCount === comps.length,
  mainStillThere: after.mainStillThere === true,
  before: { pageCount: pages.length, compCount: comps.length },
  after,
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 't31-dataset.json'), JSON.stringify({ main, pages, texts, rects, wires, comps, attrs: attrs.map((a) => ({ ...a, Value: String(a.Value ?? '').slice(0, 40) })) }))
report.dataset = join(outDir, 't31-dataset.json')

console.log(JSON.stringify(report, null, 1))
process.exitCode = Object.values(report.invariants).every(Boolean) ? 0 : 1
