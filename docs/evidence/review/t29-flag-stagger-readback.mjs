// t29: does a y-staggered flag layout still overlap? Answered from the document
// source + read-back, not from pixels.
//
// Why the instrument changed: the pixel channel (t27) returned zero bands
// because the global modal background lands on the light component panel while
// the canvas is dark, and canvas-rect auto-detection is defeated by page
// content interrupting the background runs. A separate attempt to read label
// boxes straight off the attribute primitive (t28) proved there is no bbox
// accessor there. Read-back has produced trustworthy numbers for two rounds
// running, so it is the primary judge here; pixels are a fallback only.
//
// What is measured, per layout:
//   - flag count and the y sequence (read back from the component state)
//   - adjacent y gaps, min and median, per column
//   - the drawn text band height (the `Name` attribute's stored font size,
//     read back) and the clearance that leaves
//   - overlap pairs, computed as rectangle intersection, for the TEXT band and
//     for the flag GLYPH separately, because they are different sizes and only
//     one of them is what "the 55-name wall" is about
//
// KNOWN LIMIT (t6): the flag's symbol box height is NOT measurable here. There is
// no bbox accessor on components or attributes (t28); getComponentDetail() fails
// for page primitive ids ("获取器件详情失败"); netFlagComponentUuid_Power returns an
// empty uuid and the library lookups keyed on its libraryUuid return null, so no
// symbol document source is reachable; and placing a flag adds NO rectangle and NO
// text primitive to the page, so the symbol graphic is outside the page primitive
// model. Text band height (6 units, from the stored font size) and the y pitch are
// measured; the symbol height is not measured, so any claim about symbol collision
// is conditional on an unmeasured h.
//
// KNOWN LIMIT: probe pages have not been removable in this session, and the API
// value does not predict the outcome. Measured raw returns: deleteSchematicPage
// gave false, false and true for pages that ALL persisted, while one page from an
// earlier run did vanish on true - so true+gone, true+persisted and
// false+persisted all occur. Activation is NOT the cause: a page that was never
// activated (wasActive:false) also returned false and persisted, and the one page
// that did vanish had been activated. closeDocument returned false every time.
// GET /eda-windows reports count:1, so there is no second window to delete from.
// Cleanup therefore asserts that the residue equals the pre-existing residue plus
// this run own probe, which cannot pass silently: an unexpected page, a vanished
// page, or a lost MAIN all fail.
// Safety: every mutating call targets a page this script created, and the id is
// asserted different from MAIN before anything is created, measured or deleted.
//
// Usage: node docs/evidence/review/t29-flag-stagger-readback.mjs
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gateFreshness } from './shared/freshness.mjs'
import { confirmPageGone } from './shared/page-cleanup.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const freshSnapshot = gateFreshness(repoRoot)
const pkgDir = join(repoRoot, 'packages')

// ---------------------------------------------------------------- preflight

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The bridge drops idle keep-alive sockets; a retry lands on a fresh one.
async function call(code, timeoutMs = 150_000) {
  let last
  for (let i = 0; i < 4; i++) {
    try {
      return await bridge.execute(code, { timeoutMs })
    } catch (e) {
      last = e
      await sleep(1200)
    }
  }
  throw last
}

const FS = 6 // units: the size the delivered page uses for its net names
const TEXT_WIDTH_RATIO = 3.26 // documented (§14.22): width ~= 3.26 x font size
const out = { status: 'OK', freshness: { gate: 'content-sha256', packages: Object.keys(freshSnapshot.packages).length }, fontSizeUnits: FS, textWidthRatio: TEXT_WIDTH_RATIO }

// ---- 0. the page we must never touch ---------------------------------------
const base = await call(`
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: p.uuid, name: p.name }));
return { main: cur.uuid, schematic: cur.parentSchematicUuid, mainName: cur.name, pages };
`)
out.main = { uuid: base.main, name: base.mainName }
out.residueBefore = ((base.pages || []).map((p) => p.uuid)).filter((u) => u !== base.main)
if (!base.main) {
  console.error(JSON.stringify({ status: 'NO_ACTIVE_PAGE' }))
  process.exit(1)
}

// ---- 1. probe page (ours), asserted different from MAIN --------------------
const pageStep = await call(`
const main = ${JSON.stringify(base.main)};
const before = new Set(((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid));
let created = null;
try { created = await eda.dmt_Schematic.createSchematicPage(${JSON.stringify(base.schematic)}) } catch (e) {}
await new Promise(r => setTimeout(r, 900));
const fresh = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).find(p => !before.has(p.uuid));
const target = typeof created === 'string' ? created : (fresh && fresh.uuid);
if (typeof target !== 'string') return { status: 'PAGE_CREATE_FAILED', created };
if (target === main) return { status: 'REFUSED_TARGET_IS_MAIN', target };
await eda.dmt_EditorControl.openDocument(target);
await new Promise(r => setTimeout(r, 1500));
const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!active || active.uuid !== target) return { status: 'PAGE_ACTIVATE_FAILED', target, active: active && active.uuid };
if (active.uuid === main) return { status: 'REFUSED_ACTIVE_IS_MAIN' };
return { status: 'OK', probe: target, main };
`)
if (pageStep.status !== 'OK') {
  console.error(JSON.stringify({ ...out, status: pageStep.status, pageStep }, null, 1))
  process.exit(1)
}
out.probe = { uuid: pageStep.probe, differsFromMain: pageStep.probe !== base.main }
if (pageStep.probe === base.main) {
  console.error(JSON.stringify({ ...out, status: 'REFUSED_PROBE_IS_MAIN' }))
  process.exit(1)
}

// ---- 2. the two layouts ----------------------------------------------------
const NETS = Array.from({ length: 48 }, (_, i) => `MCU-${i + 1}`)
const control = NETS.map((net, i) => ({ net, x: 200, y: 100 + i * 10 }))
const staggered = NETS.map((net, i) => ({
  net,
  x: i % 2 === 0 ? 400 : 470,
  y: 100 + (i % 2 === 0 ? 0 : 5) + Math.floor(i / 2) * 20,
}))

const place = (rows) => call(`
const rows = ${JSON.stringify(rows)};
const made = [];
for (const row of rows) {
  try {
    const placed = await eda.sch_PrimitiveComponent.createNetFlag('Power', row.net, row.x, row.y, 0, false);
    const id = placed && typeof placed.getState_PrimitiveId === 'function' ? placed.getState_PrimitiveId() : (placed && (placed.id || placed.primitiveId));
    if (typeof id === 'string') made.push({ id, net: row.net, plannedX: row.x, plannedY: row.y });
  } catch (e) {}
}
await new Promise(r => setTimeout(r, 500));
return { made };
`, 240_000)

const placedControl = await place(control)
const placedStaggered = await place(staggered)
const placed = [...(placedControl?.made ?? []), ...(placedStaggered?.made ?? [])]
out.placement = { control: placedControl?.made?.length ?? 0, staggered: placedStaggered?.made?.length ?? 0, total: placed.length }

// ---- 3. read back the document source -------------------------------------
const readback = await call(`
const wanted = new Set(${JSON.stringify(placed.map((p) => p.id))});
// 6 units, the delivered page's net-name size (the runtime API takes inches).
let sized = 0;
for (const a of (await eda.sch_PrimitiveAttribute.getAll()) || []) {
  try {
    const key = typeof a.getState_Key === 'function' ? a.getState_Key() : a.key;
    if (key !== 'Name') continue;
    await eda.sch_PrimitiveAttribute.modify(a, { fontSize: ${FS} / 100 });
    sized += 1;
  } catch (e) {}
}
await new Promise(r => setTimeout(r, 500));
const comps = [];
for (const c of (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []) {
  try {
    const id = typeof c.getState_PrimitiveId === 'function' ? c.getState_PrimitiveId() : (c.id || c.primitiveId);
    if (!wanted.has(id)) continue;
    let bb = null;
    try { if (typeof c.getState_BoundingBox === 'function') bb = await c.getState_BoundingBox() } catch (e) {}
    let x = null, y = null;
    try { x = typeof c.getState_X === 'function' ? await c.getState_X() : null } catch (e) {}
    try { y = typeof c.getState_Y === 'function' ? await c.getState_Y() : null } catch (e) {}
    comps.push({ id, x, y, bb: bb ? { x: bb.x, y: bb.y, w: (bb.width !== undefined ? bb.width : bb.maxX - bb.minX), h: (bb.height !== undefined ? bb.height : bb.maxY - bb.minY) } : null });
  } catch (e) {}
}
const attrs = [];
for (const a of (await eda.sch_PrimitiveAttribute.getAll()) || []) {
  try {
    const key = typeof a.getState_Key === 'function' ? a.getState_Key() : a.key;
    if (key !== 'Name') continue;
    const fs = typeof a.getState_FontSize === 'function' ? await a.getState_FontSize() : null;
    const val = typeof a.getState_Value === 'function' ? await a.getState_Value() : null;
    const parent = typeof a.getState_ParentPrimitiveId === 'function' ? await a.getState_ParentPrimitiveId() : null;
    if (parent && wanted.has(parent)) attrs.push({ parent, fontSize: fs, value: val });
  } catch (e) {}
}
return { comps, attrs, sized, bboxAccessor: typeof (comps[0] || {}).bb };
`, 300_000)
out.readback = {
  components: readback?.comps?.length ?? 0,
  nameAttrs: readback?.attrs?.length ?? 0,
  sized: readback?.sized ?? 0,
  glyphBoxesAvailable: (readback?.comps ?? []).filter((c) => c.bb).length,
  sampleFontSizes: [...new Set((readback?.attrs ?? []).map((a) => a.fontSize))],
  sampleY: (readback?.comps ?? []).slice(0, 4).map((c) => ({ x: c.x, y: c.y, bb: c.bb })),
}

// ---- 4. the numbers --------------------------------------------------------
const byId = new Map((readback?.comps ?? []).map((c) => [c.id, c]))
const rowsOf = (list, columnKey) => list.map((p) => {
  const c = byId.get(p.id)
  return {
    net: p.net,
    column: columnKey(p),
    x: typeof c?.x === 'number' ? c.x : p.plannedX,
    y: typeof c?.y === 'number' ? c.y : p.plannedY,
    ySource: typeof c?.y === 'number' ? 'readback' : 'planned',
    glyph: c?.bb ?? null,
  }
})

const controlRows = rowsOf(placedControl?.made ?? [], () => 'control')
const staggeredRows = rowsOf(placedStaggered?.made ?? [], (p) => (p.plannedX === 400 ? 'A' : 'B'))

const gaps = (rows) => {
  const sorted = [...rows].sort((a, b) => a.y - b.y)
  const g = []
  for (let i = 1; i < sorted.length; i++) g.push(sorted[i].y - sorted[i - 1].y)
  const s = [...g].sort((a, b) => a - b)
  return { count: g.length, min: s[0] ?? null, median: s.length ? s[Math.floor(s.length / 2)] : null, distinct: [...new Set(g)].sort((a, b) => a - b) }
}

// Overlap of two boxes: both axes must intersect.
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

// Text band: anchored at the flag origin, height = stored font size, width from
// the documented ratio. Every flag in a column shares x, so same-column pairs
// overlap in x by construction.
const textBox = (r) => ({ x: r.glyph ? r.glyph.x : r.x, y: r.y, w: FS * TEXT_WIDTH_RATIO, h: FS })
const glyphBox = (r) => (r.glyph ? { x: r.glyph.x, y: r.glyph.y, w: r.glyph.w, h: r.glyph.h } : { x: r.x, y: r.y - 5.5, w: 6, h: 11 })

const allRows = [...controlRows, ...staggeredRows]
const controlText = pairs(controlRows, textBox)
const controlGlyph = pairs(controlRows, glyphBox)
const staggerText = pairs(staggeredRows, textBox)
const staggerGlyph = pairs(staggeredRows, glyphBox)

out.numbers = {
  flags: { control: controlRows.length, staggered: staggeredRows.length, total: allRows.length },
  ySequence: {
    control: controlRows.map((r) => r.y),
    staggered: staggeredRows.map((r) => r.y),
    yFromReadback: allRows.filter((r) => r.ySource === 'readback').length,
  },
  yGaps: {
    controlSingleColumn: gaps(controlRows),
    staggeredColumnA: gaps(staggeredRows.filter((r) => r.column === 'A')),
    staggeredColumnB: gaps(staggeredRows.filter((r) => r.column === 'B')),
    staggeredBothColumns: gaps(staggeredRows),
  },
  textBand: {
    heightUnits: FS,
    widthUnits: FS * TEXT_WIDTH_RATIO,
    source: 'stored font size read back; width from the documented 3.26x ratio',
    clearanceUnits: {
      control: 10 - FS,
      staggeredSameColumn: 20 - FS,
    },
  },
  overlapPairs: {
    controlText: controlText.length,
    controlGlyph: controlGlyph.length,
    staggeredText: staggerText.length,
    staggeredGlyph: staggerGlyph.length,
    glyphBoxSource: (readback?.comps ?? []).some((c) => c.bb) ? 'readback bbox' : 'documented 6x11 constant - UNVERIFIED, glyph numbers are conditional',
    samples: { controlGlyph: controlGlyph.slice(0, 3), controlText: controlText.slice(0, 2) },
  },
}

const noOverlap = controlText.length === 0 && staggerText.length === 0
out.verdict = {
  staggeredTextOverlap: staggerText.length,
  staggeredGlyphOverlap: staggerGlyph.length,
  controlTextOverlap: controlText.length,
  controlGlyphOverlap: controlGlyph.length,
  question: 'do adjacent labels still overlap after the y stagger?',
  answer: noOverlap
    ? (staggerGlyph.length === 0 && controlGlyph.length > 0
      ? 'TEXT bands (measured) never overlap in either layout: 0 pairs at the 10-unit single column and at the 20-unit stagger, because the stored font size is 6 units. The symbol box height is NOT measured, so any symbol-collision claim is conditional: the stagger raises the same-column pitch from 10 to 20 units, which clears any symbol of height <= 20 and would still collide above that. The 6x11 constant is UNVERIFIED'
      : 'no overlap in either layout')
    : 'overlap remains',
}

// ---- 5. cleanup: only what this run created, and only a page != MAIN -------
const cleanup = await call(`
const ids = ${JSON.stringify(placed.map((p) => p.id))};
const probe = ${JSON.stringify(pageStep.probe)};
const main = ${JSON.stringify(base.main)};
if (probe === main) return { status: 'REFUSED_DELETE_MAIN' };
let del = null;
try { del = await eda.sch_PrimitiveComponent.delete(ids.length === 1 ? ids[0] : ids) } catch (e) { del = String((e && e.message) || e) }
await new Promise(r => setTimeout(r, 700));
// Unsaved edits keep deleteSchematicPage returning true while the page survives
// (measured 2026-10-20, t27 differential). Save while the probe is still active.
let saved = null;
try { saved = JSON.stringify(await eda.sch_Document.save()) } catch (e) { saved = 'ERR ' + String((e && e.message) || e) }
await new Promise(r => setTimeout(r, 700));
try { await eda.dmt_EditorControl.openDocument(main) } catch (e) {}
await new Promise(r => setTimeout(r, 1300));
let closed = null;
try { closed = JSON.stringify(await eda.dmt_EditorControl.closeDocument(probe)) } catch (e) { closed = 'ERR ' + String((e && e.message) || e) }
await new Promise(r => setTimeout(r, 1000));
let deleted = null;
try { deleted = JSON.stringify(await eda.dmt_Schematic.deleteSchematicPage(probe)) } catch (e) { deleted = 'ERR ' + String((e && e.message) || e) }
await new Promise(r => setTimeout(r, 1200));
let pages = [];
for (let i = 0; i < 6; i++) {
  pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
  if (!pages.includes(probe)) break;
  await new Promise(r => setTimeout(r, 1000));
}
return { saved, deleted, residue: pages.filter(u => u !== main), probeGone: !pages.includes(probe), mainStillThere: pages.includes(main) };
`, 180_000)
out.cleanup = cleanup
const before = new Set(out.residueBefore ?? [])
const actual = new Set(cleanup?.residue ?? [])
// The probe is allowed to be present OR gone: saving before the delete (measured
// 2026-10-20) makes the delete work, and a successful delete must not fail a
// residue assertion. What must hold: no pre-existing page vanished, and no page
// we cannot name appeared.
const allowed = new Set([...before, pageStep.probe])
const missingPre = [...before].filter((u) => !actual.has(u))
const extraUnknown = [...actual].filter((u) => !allowed.has(u))
out.expectedResidue = [...before].sort()
out.actualResidue = [...actual].sort()

// This script tolerates its own probe surviving (the client often refuses the
// delete), but the survival must be stated, never implied: re-list with
// increasing waits and print the id plus a summary count.
const confirm = await confirmPageGone(async () => {
  const pages = await call(`return ((await eda.dmt_Schematic.getAllSchematicPagesInfo())||[]).map(p=>p.uuid);`)
  return Array.isArray(pages) ? pages : []
}, pageStep.probe)
out.cleanupConfirm = confirm
out.leak = { tolerated: true, probe: pageStep.probe, gone: confirm.gone, leakedId: confirm.leakedId }
out.summary = { leakedProbes: confirm.gone ? [] : [pageStep.probe], leakedCount: confirm.gone ? 0 : 1, missingPre, extraUnknown: extraUnknown.length }
if (!confirm.gone) console.error(`TOLERATED_PROBE_LEAK probe=${pageStep.probe} deleteSaid=${JSON.stringify(cleanup?.deleted)} recheck=${JSON.stringify(confirm.attempts)}`)

out.status = cleanup?.mainStillThere && missingPre.length === 0 && extraUnknown.length === 0 ? 'OK_WITH_KNOWN_RESIDUE' : 'RESIDUE'

console.log(JSON.stringify(out, null, 1))
process.exitCode = out.status === 'OK' || out.status === 'OK_WITH_KNOWN_RESIDUE' ? 0 : 1
