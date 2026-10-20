// t30: independent cross-review of t2 (t29-flag-stagger-readback.mjs).
//
// Read-only. Nothing here is created, modified or deleted; the only bridge calls
// are get*(). It answers three questions the review asks:
//   1. is the read-back instrument real (does the document expose x / y / font
//      size, and is a bounding box actually available)?
//   2. do t2's reported numbers fall out of its own construction + constants,
//      i.e. are they reproducible arithmetic rather than observation?
//   3. is any probe page still on the page list after t2's cleanup?
//
// It deliberately does NOT re-place flags: t2's pages already could not be
// deleted, and adding two more would be a worse residue.
//
// Usage: node docs/evidence/review/t30-cross-review-t2.mjs
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gateFreshness } from './shared/freshness.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const freshSnapshot = gateFreshness(repoRoot)
const pkgDir = join(repoRoot, 'packages')

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const out = { status: 'OK', freshness: { gate: 'content-sha256', packages: Object.keys(freshSnapshot.packages).length } }

// ---- A. instrument check on the real page (read-only) ----------------------
out.instrument = await bridge.execute(`
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: p.uuid, name: p.name }));
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const probe = [];
for (const c of comps.slice(0, 2)) {
  let id = null;
  try { id = typeof c.getState_PrimitiveId === 'function' ? c.getState_PrimitiveId() : (c.id || null) } catch (e) {}
  const has = {
    X: typeof c.getState_X === 'function',
    Y: typeof c.getState_Y === 'function',
    BB: typeof c.getState_BoundingBox === 'function',
  };
  let x = null, y = null, bb = null, bbErr = null;
  try { if (has.X) x = await c.getState_X() } catch (e) {}
  try { if (has.Y) y = await c.getState_Y() } catch (e) {}
  try { if (has.BB) bb = await c.getState_BoundingBox() } catch (e) { bbErr = String((e && e.message) || e) }
  probe.push({ id, has, x, y, bb, bbErr });
}
const attrs = (await eda.sch_PrimitiveAttribute.getAll()) || [];
const names = [];
for (const a of attrs) {
  let key = null;
  try { key = typeof a.getState_Key === 'function' ? a.getState_Key() : a.key } catch (e) {}
  if (key !== 'Name') continue;
  let fs = null, val = null, parent = null;
  try { fs = typeof a.getState_FontSize === 'function' ? await a.getState_FontSize() : null } catch (e) {}
  try { val = typeof a.getState_Value === 'function' ? await a.getState_Value() : null } catch (e) {}
  try { parent = typeof a.getState_ParentPrimitiveId === 'function' ? await a.getState_ParentPrimitiveId() : null } catch (e) {}
  // Does the ATTRIBUTE expose a box? §14.22 read "该属性 bbox" from here, so if
  // this still works the text band could be measured instead of assumed.
  const hasABB = typeof a.getState_BoundingBox === 'function';
  let abb = null, abbErr = null;
  try { if (hasABB) abb = await a.getState_BoundingBox() } catch (e) { abbErr = String((e && e.message) || e) }
  names.push({ fs, val, parent, hasABB, abb, abbErr });
  if (names.length >= 4) break;
}
return { main: cur && { uuid: cur.uuid, name: cur.name }, pages, compCount: comps.length, attrCount: attrs.length, probe, names };
`, { timeoutMs: 90_000 })

// ---- B. recompute t2's numbers from its own construction -------------------
// Copied verbatim from t29 lines 124-130 and 79-80.
const FS = 6
const RATIO = 3.26
const NETS = Array.from({ length: 48 }, (_, i) => `MCU-${i + 1}`)
const control = NETS.map((net, i) => ({ net, x: 200, y: 100 + i * 10 }))
const staggered = NETS.map((net, i) => ({
  net,
  x: i % 2 === 0 ? 400 : 470,
  y: 100 + (i % 2 === 0 ? 0 : 5) + Math.floor(i / 2) * 20,
}))

const gaps = (rows) => {
  const sorted = [...rows].sort((a, b) => a.y - b.y)
  const g = []
  for (let i = 1; i < sorted.length; i++) g.push(sorted[i].y - sorted[i - 1].y)
  const s = [...g].sort((a, b) => a - b)
  return { count: g.length, min: s[0] ?? null, median: s.length ? s[Math.floor(s.length / 2)] : null, distinct: [...new Set(g)].sort((a, b) => a - b) }
}
const pairs = (rows, boxOf) => {
  const boxes = rows.map((r) => ({ ...boxOf(r), net: r.net }))
  const hits = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const xo = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const yo = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (xo > 0 && yo > 0) hits.push({ a: a.net, b: b.net, xOverlap: xo, yOverlap: yo })
    }
  }
  return hits
}
const row = (p) => ({ net: p.net, x: p.x, y: p.y })
const textBox = (r) => ({ x: r.x, y: r.y, w: FS * RATIO, h: FS })
const glyphBox = (r) => ({ x: r.x, y: r.y - 5.5, w: 6, h: 11 })

const controlRows = control.map(row)
const staggeredRows = staggered.map(row)
const colA = staggeredRows.filter((_, i) => i % 2 === 0)
const colB = staggeredRows.filter((_, i) => i % 2 === 1)

out.recomputed = {
  ySequence: { control: controlRows.map((r) => r.y), staggered: staggeredRows.map((r) => r.y) },
  yGaps: {
    control: gaps(controlRows),
    staggeredA: gaps(colA),
    staggeredB: gaps(colB),
  },
  clearance: { control: 10 - FS, staggeredSameColumn: 20 - FS, ratioControl: (10 - FS) / 10, ratioStaggered: (20 - FS) / 20 },
  overlapPairs: {
    controlText: pairs(controlRows, textBox).length,
    controlGlyph: pairs(controlRows, glyphBox).length,
    staggeredText: pairs(staggeredRows, textBox).length,
    staggeredGlyph: pairs(staggeredRows, glyphBox).length,
  },
  sensitivity: {
    // How tall would the glyph have to be before the 10-unit pitch stops colliding?
    controlCollidesWhileGlyphTallerThan: 10,
    // Text band height at which the control layout would start overlapping.
    controlTextOverlapsAboveFontSize: 10,
  },
}

// ---- C. residue ------------------------------------------------------------
const main = out.instrument?.main?.uuid
out.residue = (out.instrument?.pages ?? []).filter((p) => p.uuid !== main).map((p) => ({ uuid: p.uuid, name: p.name }))
out.componentsOnMain = out.instrument?.compCount ?? null

console.log(JSON.stringify(out, null, 1))
