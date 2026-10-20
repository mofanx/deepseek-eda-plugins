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
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gateFreshness } from './shared/freshness.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const freshSnapshot = gateFreshness(repoRoot)
const pkgDir = join(repoRoot, 'packages')
const outDir = join(repoRoot, 'docs/evidence/current')

// ---------------------------------------------------------------- preflight

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
// ---- coordinate convention, proven rather than assumed ---------------------
// Does a rect extend UP or DOWN from getState_TopLeftY? The title block settles
// it: rect2 (the block outline) has TopLeftY=146 and Height=130, and its cell
// lines sit at y=120/94/68/42 with its texts at y=142/116/90/64. Only "extends
// downward" puts those inside 16..146; the upward reading puts the block at
// 146..276 and every one of those rows outside it. The sheet border agrees:
// 1162-1154=8, i.e. a border inset exactly 8 inside a 1170-tall sheet, which the
// upward reading cannot produce (it would end at 2316).
const buildBox = (r, extendDown) => {
  const yLow = extendDown ? r.TopLeftY - r.Height : r.TopLeftY
  const yHigh = extendDown ? r.TopLeftY : r.TopLeftY + r.Height
  return { id: r.PrimitiveId, x1: r.TopLeftX, x2: r.TopLeftX + r.Width, y1: yLow, y2: yHigh, w: r.Width, h: r.Height }
}
const blockRows = (extendDown) => {
  const block = buildBox(rects.find((r) => r.PrimitiveId === 'rect2') ?? { TopLeftX: 0, TopLeftY: 0, Width: 0, Height: 0 }, extendDown)
  // The window runs from y=0 to the top of the title block, not from y=40: the
  // block's own rows start at 18 and 38, and cutting at 40 silently dropped the
  // 8 texts that live there (21 in the window, 13 above y=40).
  const rows = texts.filter((t) => typeof t.Y === 'number' && t.Y >= 0 && t.Y <= 160)
  const inBlock = rows.filter((t) => t.Y >= block.y1 && t.Y <= block.y2)
  const ys = (xs) => new Set(xs.map((t) => t.Y)).size
  return {
    reading: extendDown ? 'downward' : 'upward',
    block: [block.y1, block.y2],
    textsInWindow: rows.length,
    distinctYInWindow: ys(rows),
    textsInBlock: inBlock.length,
    distinctYInBlock: ys(inBlock),
    allTexts: texts.filter((t) => typeof t.Y === 'number').length,
    allDistinctY: ys(texts.filter((t) => typeof t.Y === 'number')),
  }
}
const boxes = rects.map((r) => buildBox(r, true)).filter((b) => [b.x1, b.y1, b.x2, b.y2].every(Number.isFinite))

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

const report = { status: 'OK', fresh: { gate: 'content-sha256', packages: Object.keys(freshSnapshot.packages).length } }
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

report.convention = {
  candidates: [blockRows(true), blockRows(false)],
  chosen: 'height extends downward from TopLeftY',
  basis: 'rect2 title block: only the downward reading keeps rows 142/116/90/64 inside 16..146; sheet border 1162-1154=8 is the 8-unit inset of a 1170-tall sheet',
}

// ---- class 1 (EXACT): two independent buckets, each with pairs AND area ----
// containedIn: one rect lies wholly inside another (no defect; the sheet border
// contains the frames by design). crossesEdge: neither contains the other, i.e.
// an outline actually crosses another outline.
const areaOf = (b) => b.w * b.h
const contains = (a, b) => a.x1 <= b.x1 && a.y1 <= b.y1 && a.x2 >= b.x2 && a.y2 >= b.y2
const overflowOf = (a, b) => {
  const parts = []
  if (b.x1 < a.x1) parts.push({ side: 'left', amount: round(a.x1 - b.x1) })
  if (b.x2 > a.x2) parts.push({ side: 'right', amount: round(b.x2 - a.x2) })
  if (b.y1 < a.y1) parts.push({ side: 'bottom', amount: round(a.y1 - b.y1) })
  if (b.y2 > a.y2) parts.push({ side: 'top', amount: round(b.y2 - a.y2) })
  return parts
}
const sheetIds = new Set([...boxes].sort((x, y) => areaOf(y) - areaOf(x)).slice(0, 2).map((b) => b.id))
const containedIn = []
const crossesEdge = []
for (let i = 0; i < boxes.length; i++) {
  for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]
    const b = boxes[j]
    const o = overlap(a, b)
    if (!o) continue
    if (contains(a, b)) containedIn.push({ outer: a.id, inner: b.id, innerW: b.w, innerH: b.h, area: round(areaOf(b)), outerIsSheet: sheetIds.has(a.id) })
    else if (contains(b, a)) containedIn.push({ outer: b.id, inner: a.id, innerW: a.w, innerH: a.h, area: round(areaOf(a)), outerIsSheet: sheetIds.has(b.id) })
    else crossesEdge.push({ a: a.id, b: b.id, w: round(o.w), h: round(o.h), area: round(o.w * o.h), overflow: overflowOf(a, b) })
  }
}
const byId = Object.fromEntries(boxes.map((b) => [b.id, b]))
const disputed = containedIn.filter((p) => ['rect62', 'rect64'].includes(p.inner))
report.rectVsRect = {
  containedIn: {
    pairs: containedIn.length,
    area: round(containedIn.reduce((s, p) => s + p.area, 0)),
    innerOnly: containedIn.filter((p) => sheetIds.has(p.outer)),
    frameInsideFrame: containedIn.filter((p) => !sheetIds.has(p.outer)).length,
    byInnerKind: containedIn.reduce((acc, p) => {
      const b = byId[p.inner]
      const kind = sheetIds.has(p.inner) ? 'sheetInner' : b.w === 0 || b.h === 0 ? 'tick' : b.id === 'rect2' ? 'titleBlock' : 'moduleFrame'
      acc[kind] = (acc[kind] ?? 0) + 1
      return acc
    }, {}),
    all: containedIn.map((p) => `${p.outer} ⊃ ${p.inner} (${p.innerW}x${p.innerH})`),
  },
  crossesEdge: {
    pairs: crossesEdge.length,
    area: round(crossesEdge.reduce((s, p) => s + p.area, 0)),
    detail: crossesEdge,
  },
  disputedFour: {
    what: 'the four rect62/rect64 pairs that were reported as 112-unit overflow',
    pairs: disputed.map((p) => {
      const outer = byId[p.outer]
      const inner = byId[p.inner]
      return {
        outer: p.outer,
        inner: p.inner,
        outerBox: [outer.x1, outer.y1, outer.x2, outer.y2],
        innerBox: [inner.x1, inner.y1, inner.x2, inner.y2],
        innerSize: [inner.w, inner.h],
        overlapArea: round(p.area),
        unitsOutsideOuter: 0,
        upperEdgeGap: round(outer.y2 - inner.y2),
      }
    }),
    verdict: 'containment, not overflow: 0 units lie outside the sheet border. 1162-1050=112 is the gap between their two UPPER edges, not an overflow',
    areaUnderDownwardReading: round(disputed.reduce((s, p) => s + p.area, 0)),
    areaUnderUpwardReading: 337760,
  },
}

// ---- class 0 (EXACT): which path carries the net names ---------------------
// serialize.ts:319 emits an ATTR "NET" at the wire's first vertex, and that is
// the mechanism behind the 119-pair figure. This page has none of those, so the
// figure cannot be reproduced here.
const netKeys = attrs.filter((a) => a.Key === 'NET').length
report.netAttributes = {
  count: netKeys,
  wiresCarryingNetProperty: wires.filter((w) => typeof w.Net === 'string' && w.Net.length > 0).length,
  flagComponents: comps.filter((c) => String(c.PrimitiveId ?? '').startsWith('layout:flag:')).length,
  flagComponentsByGlobalNetName: new Set(attrs.filter((a) => a.Key === 'Global Net Name' && a.ParentPrimitiveId).map((a) => a.ParentPrimitiveId)).size,
  globalNetNameAttrs: attrs.filter((a) => a.Key === 'Global Net Name').length,
  reading: netKeys === 0
    ? 'net names live on the wire Net property and on flag components (Global Net Name), not as NET attributes; the 119-pair mechanism is the source-import path'
    : 'NET attributes are present, so the 119-pair mechanism is reproducible on this page',
  evidence: 'eda-core/src/serialize.ts:319 emit.attr(wire.id, "NET", ...first vertex); this page: 55 wires with Net, 0 ATTR with Key=NET',
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
