// t32: can the flag glyph's real size be measured? Read-only forensics.
//
// t29 measured the text band (6 units, from the stored font size) and the y
// pitch, but had to leave the symbol box height unmeasured: attributes and
// components expose no bounding box, getComponentDetail() fails for page
// primitive ids, netFlagComponentUuid_Power yields an empty uuid, the library
// lookups keyed on its libraryUuid return null, and placing a flag added no
// rectangle and no text primitive to the page.
//
// That last check only covered two of the drawing primitive types. A glyph is
// just as likely to be drawn as a polygon, an arc or a circle, and those were
// never inspected - so this script exists to close that specific hole rather
// than to repeat the conclusions that are already established.
//
// What it does:
//   1. reports which drawing primitive namespaces exist and what getAll()
//      actually returns, plus the state accessors each type exposes
//   2. creates its own probe page (asserting the target is not MAIN), snapshots
//      EVERY primitive namespace, places one net flag, and diffs every namespace
//      again - so "the glyph is drawn as X" is answered for all X, not for two
//   3. re-checks the earlier rect/text finding, which must still hold
//   4. if a new primitive carries real geometry, reports the glyph box size and
//      says whether the 6x11 constant survives
//   5. cleans up and asserts the residue is exactly the pre-existing set plus
//      this run's own probe, with MAIN still present
//
// Read-only with respect to the delivered page: the only mutations are a flag on
// a page this script created, and that flag's deletion.
//
// Usage: node docs/evidence/review/t32-flag-glyph-size.mjs
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../../..')
const pkgDir = join(repoRoot, 'packages')

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

const gateSrc = newestMtime(join(pkgDir, 'eda-core/src'), '.ts')
const gateLib = newestMtime(join(pkgDir, 'eda-core/lib'), '.js')
const freshness = { src: new Date(gateSrc).toISOString(), lib: new Date(gateLib).toISOString(), fresh: gateLib >= gateSrc }
if (!freshness.fresh) {
  console.error(JSON.stringify({ status: 'STALE_BUILD', freshness, hint: 'rebuild before any live evidence' }, null, 1))
  process.exit(1)
}

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(code, timeoutMs = 60_000) {
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

const out = { status: 'OK', freshness }
const TYPES = ['sch_PrimitivePolygon', 'sch_PrimitiveArc', 'sch_PrimitiveCircle', 'sch_PrimitiveRectangle', 'sch_PrimitiveText', 'sch_PrimitivePin', 'sch_PrimitiveObject', 'sch_PrimitiveWire']

// ---- 1. which drawing primitive namespaces exist, and what they return ------
out.inventory = await call(`
const names = ${JSON.stringify(TYPES)};
const res = {};
for (const n of names) {
  const ns = eda[n];
  if (!ns) { res[n] = { exists: false }; continue }
  const fns = [];
  let p = ns;
  while (p && p !== Object.prototype) { for (const k of Object.getOwnPropertyNames(p)) fns.push(k); p = Object.getPrototypeOf(p) }
  const uniq = [...new Set(fns)].filter(k => { try { return typeof ns[k] === 'function' } catch (e) { return false } }).sort();
  let count = null, err = null, stateFns = null, sample = null;
  try {
    const all = (await ns.getAll()) || [];
    count = all.length;
    if (all.length) {
      const a = all[0];
      const sp = [];
      let q = a;
      while (q && q !== Object.prototype) { for (const k of Object.getOwnPropertyNames(q)) sp.push(k); q = Object.getPrototypeOf(q) }
      stateFns = [...new Set(sp)].filter(k => /^getState_/.test(k)).sort();
      const snap = {};
      for (const f of stateFns) { try { const v = a[f](); if (v !== undefined) snap[f.replace('getState_', '')] = v } catch (e) {} }
      sample = snap;
    }
  } catch (e) { err = String(e && e.message || e).slice(0, 120) }
  res[n] = { exists: true, apiFns: uniq.filter(k => /get|create|delete|modify/i.test(k)), count, err, stateAccessors: stateFns, sample };
}
return res;
`)

// ---- 2. probe page, asserted different from MAIN ---------------------------
const base = await call(`
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
return { main: cur && cur.uuid, schematic: cur && cur.parentSchematicUuid, pages };
`)
if (!base.main) {
  console.error(JSON.stringify({ ...out, status: 'NO_ACTIVE_PAGE' }, null, 1))
  process.exit(1)
}
out.main = base.main
out.residueBefore = (base.pages ?? []).filter((u) => u !== base.main)

const pageStep = await call(`
const main = ${JSON.stringify(base.main)};
const before = new Set(((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid));
let created = null;
try { created = await eda.dmt_Schematic.createSchematicPage(${JSON.stringify(base.schematic)}) } catch (e) {}
await new Promise(r => setTimeout(r, 900));
const fresh = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).find(p => !before.has(p.uuid));
const target = typeof created === 'string' ? created : (fresh && fresh.uuid);
if (typeof target !== 'string') return { status: 'PAGE_CREATE_FAILED' };
if (target === main) return { status: 'REFUSED_TARGET_IS_MAIN' };
await eda.dmt_EditorControl.openDocument(target);
await new Promise(r => setTimeout(r, 1600));
const act = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!act || act.uuid !== target) return { status: 'PAGE_ACTIVATE_FAILED', active: act && act.uuid };
return { status: 'OK', probe: target };
`)
if (pageStep.status !== 'OK') {
  console.error(JSON.stringify({ ...out, status: pageStep.status, pageStep }, null, 1))
  process.exit(1)
}
out.probe = pageStep.probe
if (pageStep.probe === base.main) {
  console.error(JSON.stringify({ ...out, status: 'REFUSED_PROBE_IS_MAIN' }))
  process.exit(1)
}

// ---- 3. place one flag and diff every primitive namespace ------------------
const diff = await call(`
const names = ${JSON.stringify(TYPES)};
const snapshot = async () => {
  const map = {};
  for (const n of names) {
    try { map[n] = new Set((((await eda[n].getAll()) || [])).map(p => p.getState_PrimitiveId ? p.getState_PrimitiveId() : null)) } catch (e) { map[n] = null }
  }
  return map;
};
const before = await snapshot();
const flag = await eda.sch_PrimitiveComponent.createNetFlag('Power', 'MCU-1', 300, 200, 0, false);
const flagId = flag && (flag.getState_PrimitiveId ? flag.getState_PrimitiveId() : (flag.id || flag.primitiveId));
await new Promise(r => setTimeout(r, 900));
const added = {};
for (const n of names) {
  try {
    const all = (await eda[n].getAll()) || [];
    const beforeSet = before[n] || new Set();
    const items = all.filter(p => { const id = p.getState_PrimitiveId ? p.getState_PrimitiveId() : null; return id && !beforeSet.has(id) });
    if (!items.length) { added[n] = { added: 0, total: all.length }; continue }
    const rows = items.slice(0, 6).map(p => {
      const sp = [];
      let q = p;
      while (q && q !== Object.prototype) { for (const k of Object.getOwnPropertyNames(q)) sp.push(k); q = Object.getPrototypeOf(q) }
      const fns = [...new Set(sp)].filter(k => /^getState_/.test(k)).sort();
      const snap = {};
      for (const f of fns) { try { const v = p[f](); if (v !== undefined) snap[f.replace('getState_', '')] = v } catch (e) {} }
      return snap;
    });
    added[n] = { added: items.length, total: all.length, rows };
  } catch (e) { added[n] = { err: String(e && e.message || e).slice(0, 100) } }
}
let comp = null;
try {
  for (const c of ((await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [])) {
    const i = c.getState_PrimitiveId ? c.getState_PrimitiveId() : null;
    if (i === flagId) comp = { x: c.getState_X ? c.getState_X() : null, y: c.getState_Y ? c.getState_Y() : null };
  }
} catch (e) {}
if (flagId) { try { await eda.sch_PrimitiveComponent.delete(flagId) } catch (e) {} }
await new Promise(r => setTimeout(r, 500));
return { flagId, added, comp };
`)
out.diff = diff

// ---- 4. interpret ---------------------------------------------------------
const rows = []
for (const [name, v] of Object.entries(diff?.added ?? {})) {
  if (v?.added) for (const r of v.rows ?? []) rows.push({ type: name, ...r })
}
const geometryOf = (r) => {
  const h = r.Height ?? r.height
  const w = r.Width ?? r.width
  if (typeof h === 'number' && typeof w === 'number') return { w, h }
  const ys = [r.Y, r.TopLeftY, r.CenterY, r.Center].filter((v) => typeof v === 'number')
  const xs = [r.X, r.TopLeftX, r.CenterX].filter((v) => typeof v === 'number')
  const radius = typeof r.Radius === 'number' ? r.Radius : null
  if (radius !== null) return { w: radius * 2, h: radius * 2 }
  if (ys.length && xs.length) return { w: null, h: null, x: xs[0], y: ys[0] }
  return { w: null, h: null }
}
const withSize = rows.map((r) => ({ type: r.type, ...geometryOf(r), raw: r })).filter((r) => typeof r.h === 'number' || r.h === null)

out.glyph = {
  newPrimitiveRows: rows.length,
  rowsByType: Object.fromEntries(Object.entries(diff?.added ?? {}).map(([k, v]) => [k, v?.added ?? v?.err ?? 0])),
  sized: withSize.filter((r) => typeof r.h === 'number'),
  unresolved: withSize.filter((r) => r.h === null),
}
const sized = out.glyph.sized
out.verdict = {
  symbolSizeMeasured: sized.length > 0,
  constant6x11: sized.length ? (sized.some((r) => r.h === 11 && r.w === 6) ? 'CONFIRMED by a new primitive' : 'CONTRADICTED by a new primitive') : 'UNMEASURED',
  textBandRecheck: 'see t29 (6 units from the stored font size)',
  rectTextRecheck: (diff?.added?.sch_PrimitiveRectangle?.added ?? 0) === 0 && (diff?.added?.sch_PrimitiveText?.added ?? 0) === 0 ? 'still empty (matches t29)' : 'CHANGED - rect/text now appear',
  staggerClaim: sized.length
    ? `symbol box is ${sized[0].w ?? '?'}x${sized[0].h} units, so the stagger clears it whenever its height is <= 20`
    : 'CONDITIONAL: symbol height still unmeasured, so "stagger clears symbol collision" holds only for a glyph of height <= 20',
}

// ---- 5. cleanup -----------------------------------------------------------
const cleanup = await call(`
const probe = ${JSON.stringify(pageStep.probe)};
const main = ${JSON.stringify(base.main)};
if (probe === main) return { status: 'REFUSED_DELETE_MAIN' };
try { await eda.dmt_EditorControl.openDocument(main) } catch (e) {}
await new Promise(r => setTimeout(r, 1200));
let closed = null, deleted = null;
try { closed = JSON.stringify(await eda.dmt_EditorControl.closeDocument(probe)) } catch (e) { closed = 'ERR' }
await new Promise(r => setTimeout(r, 900));
try { deleted = JSON.stringify(await eda.dmt_Schematic.deleteSchematicPage(probe)) } catch (e) { deleted = 'ERR ' + String(e && e.message || e).slice(0, 80) }
let pages = [];
for (let i = 0; i < 3; i++) {
  await new Promise(r => setTimeout(r, 800));
  pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
  if (!pages.includes(probe)) break;
}
// The page LIST flaps: a page can be absent from getAllSchematicPagesInfo() for
// a moment and then reappear (measured: the probe was missing from the list at
// cleanup, yet getSchematicPageInfo() returned it 3 s and 5.5 s later). So list
// membership is not proof of deletion - ask for the page itself.
let stillExists = true;
try { const r = await eda.dmt_Schematic.getSchematicPageInfo(probe); stillExists = !!(r && r.uuid) } catch (e) { stillExists = true }
return { closed, deleted, stillExists, residue: pages.filter(u => u !== main), probeGone: !stillExists, mainStillThere: pages.includes(main) };
`)
out.cleanup = cleanup

const expected = new Set([...(out.residueBefore ?? []), pageStep.probe])
const actual = new Set(cleanup?.residue ?? [])
// Existence, not list membership, decides. If the page is really gone that is a
// better outcome than the standing residue and is accepted; if it still exists,
// nothing outside the known set may have appeared.
const stray = [...actual].filter((u) => !expected.has(u))
out.status = !cleanup?.mainStillThere ? 'RESIDUE' : cleanup?.stillExists ? (stray.length === 0 ? 'OK_WITH_KNOWN_RESIDUE' : 'RESIDUE') : 'OK_DELETED'

console.log(JSON.stringify(out, null, 1))
process.exitCode = out.status === 'RESIDUE' ? 1 : 0
