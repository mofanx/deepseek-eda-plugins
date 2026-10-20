// t28: do staggered net labels still overlap? Measured in IR space.
//
// t27's pixel channel is broken: the global modal background picks the light
// component panel (L=202) while the canvas is L=64, so 69% of canvas pixels are
// classified as ink, every row trips the "full row" filter, and zero bands
// survive. Auto-detecting the canvas rect also fails (page content interrupts
// the background runs). Rather than keep guessing at screenshot geometry, this
// measures the same question with exact primitives: the `Name` attribute of each
// net flag carries a bounding box in schematic units, so overlap between two
// labels is a rectangle-intersection test, not a colour threshold.
//
// Calibration is the delivered page itself: its 55 client-drawn net names are
// the documented baseline (6-unit glyph on a 10-unit pin pitch = 40% clearance).
//
// Safety: only touches a page this script creates, and asserts that id differs
// from MAIN before creating, measuring or deleting anything.
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { gateFreshness } from './shared/freshness.mjs'
import { confirmPageGone } from './shared/page-cleanup.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
gateFreshness(repoRoot)
const pkgDir = join(repoRoot, 'packages')

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The bridge drops idle keep-alive sockets; retry on a fresh one.
async function call(code, timeoutMs = 120_000) {
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

const out = { status: 'OK', steps: [] }
const log = (step, value) => {
  out.steps.push({ step, ...value })
}

// ---- 0. current state, and the id we must never touch -----------------------
const base = await call(`
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
return { main: cur.uuid, schematic: cur.parentSchematicUuid, name: cur.name, pages };
`)
out.mainPage = base.main
const FORBIDDEN = new Set([base.main])

// ---- 1. calibration: the delivered page's own labels -----------------------
const CAL = await call(`
const names = [];
for (const a of (await eda.sch_PrimitiveAttribute.getAll()) || []) {
  try {
    const key = typeof a.getState_Key === 'function' ? a.getState_Key() : a.key;
    if (key !== 'Name') continue;
    let bb = null;
    try { if (typeof a.getState_BoundingBox === 'function') bb = await a.getState_BoundingBox() } catch (e) {}
    if (!bb) { try { if (typeof eda.sch_PrimitiveAttribute.getBoundingBox === 'function') bb = await eda.sch_PrimitiveAttribute.getBoundingBox(a) } catch (e) {} }
    if (!bb) continue;
    names.push({ x: bb.x, y: bb.y, w: bb.width !== undefined ? bb.width : (bb.maxX - bb.minX), h: bb.height !== undefined ? bb.height : (bb.maxY - bb.minY) });
  } catch (e) {}
  if (names.length >= 60) break;
}
return { names, attrs: ((await eda.sch_PrimitiveAttribute.getAll()) || []).length };
`, 180_000)
log('calibration', { boxes: CAL.names.length, attrs: CAL.attrs, first: CAL.names.slice(0, 3) })

// ---- 2. probe page: created by us, asserted different from MAIN ------------
const page = await call(`
const main = ${JSON.stringify(base.main)};
const before = new Set(((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid));
let created = null;
try { created = await eda.dmt_Schematic.createSchematicPage(${JSON.stringify(base.schematic)}) } catch (e) {}
await new Promise(r => setTimeout(r, 900));
const after = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []);
const fresh = after.find(p => !before.has(p.uuid));
const target = typeof created === 'string' ? created : (fresh && fresh.uuid);
if (typeof target !== 'string') return { status: 'PAGE_CREATE_FAILED', created };
if (target === main) return { status: 'REFUSED_TARGET_IS_MAIN', target };
return { status: 'OK', probe: target, main };
`)
if (page.status !== 'OK') {
  console.error(JSON.stringify({ ...out, status: page.status, page }))
  process.exit(1)
}
out.probePage = page.probe
if (FORBIDDEN.has(page.probe)) {
  console.error(JSON.stringify({ ...out, status: 'REFUSED_PROBE_IS_MAIN' }))
  process.exit(1)
}
log('probe-created', { probe: page.probe, isMain: page.probe === base.main })

// ---- 3. layout + label geometry --------------------------------------------
const NETS = Array.from({ length: 48 }, (_, i) => `MCU-${i + 1}`)
const control = NETS.map((net, i) => ({ net, x: 200, y: 100 + i * 10 }))
const staggered = NETS.map((net, i) => ({ net, x: i % 2 === 0 ? 400 : 470, y: 100 + (i % 2 === 0 ? 0 : 5) + Math.floor(i / 2) * 20 }))

const measure = await call(`
const rows = ${JSON.stringify([...control, ...staggered])};
// Place flags, then make the drawn name 6 units like the delivered page.
const made = [];
for (const row of rows) {
  try {
    const placed = await eda.sch_PrimitiveComponent.createNetFlag('Power', row.net, row.x, row.y, 0, false);
    const id = placed && typeof placed.getState_PrimitiveId === 'function' ? placed.getState_PrimitiveId() : (placed && (placed.id || placed.primitiveId));
    if (typeof id === 'string') made.push(id);
  } catch (e) {}
}
await new Promise(r => setTimeout(r, 700));
const mine = new Set(${JSON.stringify(NETS)});
const boxes = [];
let sized = 0;
for (const a of (await eda.sch_PrimitiveAttribute.getAll()) || []) {
  try {
    const key = typeof a.getState_Key === 'function' ? a.getState_Key() : a.key;
    if (key !== 'Name') continue;
    await eda.sch_PrimitiveAttribute.modify(a, { fontSize: 0.06 });
    sized += 1;
    let bb = null;
    try { if (typeof a.getState_BoundingBox === 'function') bb = await a.getState_BoundingBox() } catch (e) {}
    if (!bb) { try { bb = await eda.sch_PrimitiveAttribute.getBoundingBox(a) } catch (e) {} }
    if (!bb) continue;
    let text = null;
    try { text = typeof a.getState_Value === 'function' ? a.getState_Value() : a.value } catch (e) {}
    if (!mine.has(text)) continue;
    boxes.push({ net: text, x: bb.x, y: bb.y, w: bb.width !== undefined ? bb.width : (bb.maxX - bb.minX), h: bb.height !== undefined ? bb.height : (bb.maxY - bb.minY) });
  } catch (e) {}
}
return { created: made.length, ids: made, sized, boxes };
`, 300_000)
log('placed', { created: measure.created, sized: measure.sized, boxes: measure.boxes?.length ?? 0 })

const analyse = (boxes, rows, label) => {
  if (!boxes || boxes.length < 2) return { label, measured: null, verdict: 'NO_BOXES' }
  const scaled = boxes.filter((b) => b.w > 0 && b.h > 0)
  const overlaps = []
  for (let i = 0; i < scaled.length; i++) {
    for (let j = i + 1; j < scaled.length; j++) {
      const a = scaled[i]
      const b = scaled[j]
      const xo = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const yo = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (xo > 0 && yo > 0) overlaps.push({ a: a.net, b: b.net, xOverlap: xo, yOverlap: yo })
    }
  }
  // vertical clearance between labels sharing a column (the density question)
  const byColumn = new Map()
  for (const b of scaled) {
    const key = Math.round((b.x + b.w / 2) / 10)
    if (!byColumn.has(key)) byColumn.set(key, [])
    byColumn.get(key).push(b)
  }
  const gaps = []
  for (const list of byColumn.values()) {
    list.sort((p, q) => p.y - q.y)
    for (let i = 1; i < list.length; i++) gaps.push(list[i].y - (list[i - 1].y + list[i - 1].h))
  }
  const heights = scaled.map((b) => b.h).sort((p, q) => p - q)
  return {
    label,
    measured: {
      boxes: scaled.length,
      rowsPlanned: rows,
      overlapPairs: overlaps.length,
      overlapSample: overlaps.slice(0, 3),
      labelHeight: { min: heights[0], median: heights[Math.floor(heights.length / 2)], max: heights[heights.length - 1] },
      columnGap: gaps.length ? { min: Math.min(...gaps), median: gaps.sort((p, q) => p - q)[Math.floor(gaps.length / 2)] } : null,
      columns: byColumn.size,
    },
    verdict: overlaps.length === 0 ? 'NO_OVERLAP' : 'OVERLAP',
  }
}

const controlBoxes = (measure.boxes ?? []).filter((b) => b.x < 350)
const staggerBoxes = (measure.boxes ?? []).filter((b) => b.x >= 350)
out.calibrationMeasure = analyse(CAL.names, 55, 'delivered page (55 client-drawn net names)')
out.ab = {
  control: analyse(controlBoxes, 48, '10-unit pitch, one column'),
  staggered: analyse(staggerBoxes, 24, '20-unit pitch, two columns offset by 5'),
}

// ---- 4. cleanup: only ids this run created ---------------------------------
const cleanup = await call(`
const ids = ${JSON.stringify(measure.ids ?? [])};
const probe = ${JSON.stringify(page.probe)};
const main = ${JSON.stringify(base.main)};
if (probe === main) return { status: 'REFUSED_DELETE_MAIN' };
let del = null;
try { del = await eda.sch_PrimitiveComponent.delete(ids.length === 1 ? ids[0] : ids) } catch (e) { del = String((e && e.message) || e) }
await new Promise(r => setTimeout(r, 800));
try { await eda.dmt_EditorControl.openDocument(main) } catch (e) {}
await new Promise(r => setTimeout(r, 1200));
let closed = null, deleted = null;
try { closed = JSON.stringify(await eda.dmt_EditorControl.closeDocument(probe)) } catch (e) { closed = 'ERR ' + String((e && e.message) || e) }
await new Promise(r => setTimeout(r, 1000));
if (${JSON.stringify(process.env.T28_SKIP_DELETE === '1')}) deleted = 'SKIPPED_BY_TEST_HOOK';
else try { deleted = JSON.stringify(await eda.dmt_Schematic.deleteSchematicPage(probe)) } catch (e) { deleted = 'ERR ' + String((e && e.message) || e) }
await new Promise(r => setTimeout(r, 1200));
let pages = [];
for (let i = 0; i < 5; i++) {
  pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
  if (!pages.includes(probe)) break;
  await new Promise(r => setTimeout(r, 1000));
}
return { del: JSON.stringify(del), closed, deleted, pages, residue: pages.filter(u => u !== main), probeGone: !pages.includes(probe) };
`, 180_000)
out.cleanup = cleanup

// Superset assertion: the four P1 orphans that predate this script are known
// residue and must not turn a clean run red. Anything NOT in this list (and not
// our own probe, which is judged by probeGone) is unexpected and fails.
// Known set read 2026-10-20 from getAllSchematicPagesInfo(); update it only by
// adding ids that have been attributed to a named run, never by widening to a
// wildcard. T28_EXTRA_RESIDUE is a test hook that injects ids so the assertion
// itself can be proven to fail.
const KNOWN_RESIDUE = new Set([
  '03feee84fe9a094d', '1d3d210baee76a03', '2a555a2fca6da7ed', '48c31104b4660672',
  '7bd5f4ea83b1bb13', 'abb8d61f70f52909', 'b67be58e31a69ef2', 'fba443281f342e5b',
])
const observed = out.cleanup?.residue ?? []
const injected = (process.env.T28_EXTRA_RESIDUE || '').split(',').map((s) => s.trim()).filter(Boolean)
// Pages already present when this run started belong to someone else's probe on
// this shared client; only pages that appear AFTER that snapshot are candidates
// for "this run leaked a page". The explicit KNOWN_RESIDUE list still documents
// the attributed orphans, and an id that is neither known nor in the snapshot
// (or injected) fails.
const preexisting = new Set((base.pages || []).filter((u) => u !== base.main))
const allowed = new Set([...KNOWN_RESIDUE, ...preexisting])
const unexpected = [...observed, ...injected].filter((u) => u !== out.probePage && !allowed.has(u))
out.residue = { knownAtRead: [...KNOWN_RESIDUE].sort(), preexisting: [...preexisting].sort(), observed, injected, unexpected }

// `deleted: "true"` is not evidence: this session saw true+persisted. The page
// must be absent from a fresh listing, checked with increasing waits.
const confirm = await confirmPageGone(async () => {
  const pages = await call(`return ((await eda.dmt_Schematic.getAllSchematicPagesInfo())||[]).map(p=>p.uuid);`)
  return Array.isArray(pages) ? pages : []
}, page.probe)
out.cleanupConfirm = confirm
const probeGone = cleanup?.probeGone === true && confirm.gone === true
out.status = !probeGone ? 'PROBE_LEAK' : (unexpected.length === 0 ? 'OK' : 'RESIDUE')
if (!probeGone) out.leakedProbe = confirm.leakedId ?? page.probe

console.log(JSON.stringify(out, null, 1))
if (!probeGone) console.error(`PROBE_LEAK probe=${out.leakedProbe} deleteSaid=${JSON.stringify(cleanup?.deleted)} recheck=${JSON.stringify(confirm.attempts)}`)
process.exitCode = out.status === 'OK' ? 0 : 1
