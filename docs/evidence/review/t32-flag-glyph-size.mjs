// t32: can the flag glyph's real size be measured? Read-only forensics.
//
// The first version of this file had three blind spots, fixed here:
//   1. it keyed the diff on the primitive id and dropped anything without one,
//      so a primitive that never exposes an id was invisible to the diff;
//   2. it called getAll() once, with no way to tell whether hidden primitives
//      were included, so a flag painted into a hidden layer would look absent;
//   3. it compared id SETS only, so a placement that modified an existing
//      primitive instead of adding one produced an empty diff.
//
// The instrument is now a full snapshot of every drawing namespace - id, type,
// every getState_* value and every own property - diffed item by item. Items
// are matched by id when they have one and by a content signature when they do
// not, so additions, removals and same-id modifications are all visible. The
// three getAll variants are counted separately so "hidden" is measured rather
// than assumed.
//
// The cleanup assertion is two-way: the residue must equal the pre-existing set
// plus this run's own probe. A missing page and an extra page both fail the run.
// Existence is read through getSchematicPageInfo because the page LIST flaps -
// a page can drop out of getAllSchematicPagesInfo() and come back (measured).
//
// Usage: node docs/evidence/review/t32-flag-glyph-size.mjs
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gateFreshness } from './shared/freshness.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const freshSnapshot = gateFreshness(repoRoot)
const pkgDir = join(repoRoot, 'packages')

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

const out = { status: 'OK', freshness: { gate: 'content-sha256', packages: Object.keys(freshSnapshot.packages).length } }
const TYPES = [
  'sch_PrimitivePolygon',
  'sch_PrimitiveArc',
  'sch_PrimitiveCircle',
  'sch_PrimitiveRectangle',
  'sch_PrimitiveText',
  'sch_PrimitivePin',
  'sch_PrimitiveObject',
  'sch_PrimitiveWire',
  'sch_PrimitiveBus',
  'sch_PrimitiveComponent',
  'sch_PrimitiveAttribute',
]

// Snapshot helper, injected into every page call. Attributes are captured
// compactly because there are 662 of them and they cannot carry glyph geometry.
const SNAP = `
const SNAP_TYPES = ${JSON.stringify(TYPES)};
const stateOf = (it) => {
  const sp = [];
  let q = it;
  while (q && q !== Object.prototype) { for (const k of Object.getOwnPropertyNames(q)) sp.push(k); q = Object.getPrototypeOf(q) }
  const fns = [...new Set(sp)].filter(k => /^getState_/.test(k));
  const s = {};
  for (const f of fns) { try { const v = it[f](); if (v !== undefined) s[f.replace('getState_', '')] = v } catch (e) {} }
  return s;
};
const ownOf = (it) => {
  const o = {};
  for (const k of Object.keys(it)) { try { const v = it[k]; if (v === null || ['number','string','boolean'].includes(typeof v)) o[k] = v } catch (e) {} }
  return o;
};
const snapshot = async () => {
  const types = {};
  for (const n of SNAP_TYPES) {
    const ns = eda[n];
    if (!ns) { types[n] = { exists: false }; continue }
    const variants = {};
    for (const [label, args] of [['default', []], ['hiddenTrue', [undefined, true]], ['hiddenFalse', [undefined, false]]]) {
      try { const all = await ns.getAll(...args); variants[label] = all ? all.length : null } catch (e) { variants[label] = 'ERR' }
    }
    let items = [];
    try { items = (await ns.getAll(undefined, true)) || [] } catch (e) {
      try { items = (await ns.getAll()) || [] } catch (e2) { items = [] }
    }
    const rows = [];
    for (const it of items) {
      const s = stateOf(it);
      const o = ownOf(it);
      if (n === 'sch_PrimitiveAttribute') {
        rows.push({ id: s.PrimitiveId ?? o.id ?? null, st: { Key: s.Key ?? null, Value: s.Value ?? null, X: s.X ?? null, Y: s.Y ?? null, FontSize: s.FontSize ?? null, ValueVisible: s.ValueVisible ?? null, KeyVisible: s.KeyVisible ?? null, ParentPrimitiveId: s.ParentPrimitiveId ?? null, Rotation: s.Rotation ?? null, Color: s.Color ?? null, AlignMode: s.AlignMode ?? null, Align: s.Align ?? null, Bold: s.Bold ?? null, Italic: s.Italic ?? null, UnderLine: s.UnderLine ?? null, FontName: s.FontName ?? null } });
      } else {
        rows.push({ id: s.PrimitiveId ?? o.id ?? o.uuid ?? null, st: s, own: o });
      }
    }
    types[n] = { exists: true, count: rows.length, variants, rows };
  }
  return types;
};
`

// ---- 1. inventory: which namespaces exist, what the variants return ---------
out.inventory = await call(`${SNAP}\nconst types = await snapshot();\nconst brief = {};\nfor (const [n, v] of Object.entries(types)) { brief[n] = v.exists ? { count: v.count, variants: v.variants, sample: (v.rows[0] ?? null) } : { exists: false } }\nreturn brief;\n`)

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

// ---- 3+4. snapshot, place one flag, snapshot again -------------------------
const diff = await call(`
${SNAP}
const before = await snapshot();
const flag = await eda.sch_PrimitiveComponent.createNetFlag('Power', 'MCU-1', 300, 200, 0, false);
const flagId = flag && (flag.getState_PrimitiveId ? flag.getState_PrimitiveId() : (flag.id || flag.primitiveId));
await new Promise(r => setTimeout(r, 900));
const after = await snapshot();

const sig = (r) => JSON.stringify({ st: r.st, own: r.own ?? null });
const diffOf = (a, b) => {
  const byId = (rows) => { const m = new Map(); for (const r of rows) if (r.id) m.set(r.id, r); return m };
  const aId = byId(a), bId = byId(b);
  const added = [], removed = [], changed = [];
  for (const [id, r] of bId) if (!aId.has(id)) added.push(r);
  for (const [id, r] of aId) if (!bId.has(id)) removed.push(r);
  for (const [id, r] of bId) { const old = aId.get(id); if (old && sig(old) !== sig(r)) changed.push({ id, before: old, after: r }) }
  // items without an id: match by content signature on both sides
  const pool = new Map();
  for (const r of a.filter(x => !x.id)) { const s = sig(r); pool.set(s, (pool.get(s) ?? 0) + 1) }
  const addedNoId = [], removedNoId = [];
  for (const r of b.filter(x => !x.id)) { const s = sig(r); const n = pool.get(s) ?? 0; if (n > 0) pool.set(s, n - 1); else addedNoId.push(s) }
  for (const [s, n] of pool) for (let i = 0; i < n; i++) removedNoId.push(s);
  return { added, removed, changed, addedNoId, removedNoId };
};

const report = {};
for (const n of SNAP_TYPES) {
  const a = before[n], b = after[n];
  if (!a || !b || !a.exists || !b.exists) { report[n] = { exists: false }; continue }
  const d = diffOf(a.rows, b.rows);
  report[n] = { before: a.count, after: b.count, added: d.added.length, removed: d.removed.length, changed: d.changed.length, addedNoId: d.addedNoId.length, removedNoId: d.removedNoId.length, rows: d.added.slice(0, 4), changedRows: d.changed.slice(0, 2) };
}

// every state field of the new component, and every library path it exposes
let compState = null;
for (const c of ((await eda.sch_PrimitiveComponent.getAll(undefined, true)) || [])) {
  const id = c.getState_PrimitiveId ? c.getState_PrimitiveId() : null;
  if (id !== flagId) continue;
  compState = stateOf(c);
}
const lib = {};
for (const [label, nsName, arg] of [
  ['lib_Symbol.get', 'lib_Symbol', compState && (compState.Symbol ?? compState.SymbolUuid ?? compState.LibSymbolUuid ?? compState.LibrarySymbolUuid)],
  ['lib_Device.get', 'lib_Device', compState && (compState.Component ?? compState.Device ?? compState.DeviceUuid)],
]) {
  const ns = eda[nsName];
  if (!ns) { lib[label] = 'NO_NAMESPACE'; continue }
  const name = label.split('.')[1];
  if (typeof ns[name] !== 'function') { lib[label] = 'NO_FUNCTION'; continue }
  if (arg == null) { lib[label] = 'NO_ARG_FROM_STATE'; continue }
  try {
    const v = await ns[name](arg)
    lib[label] = { arg, ret: v === undefined ? 'undefined' : JSON.stringify(v).slice(0, 600) }
  } catch (e) { lib[label] = { arg, err: String(e && e.message || e).slice(0, 120) } }
}
try { await eda.sch_PrimitiveComponent.delete(flagId) } catch (e) {}
await new Promise(r => setTimeout(r, 500));
return { flagId, report, comp: compState, lib };
`)
out.diff = diff

// ---- 5. interpretation ----------------------------------------------------
const addedRows = []
for (const [name, v] of Object.entries(diff?.report ?? {})) {
  for (const r of v.rows ?? []) addedRows.push({ type: name, ...r })
}
const sized = addedRows
  .map((r) => {
    const st = r.st ?? {}
    const w = st.Width ?? r.own?.Width
    const h = st.Height ?? r.own?.Height
    if (typeof w === 'number' && typeof h === 'number') return { type: r.type, w, h }
    const rad = st.Radius ?? r.own?.Radius
    if (typeof rad === 'number') return { type: r.type, w: rad * 2, h: rad * 2 }
    return null
  })
  .filter(Boolean)

out.glyph = {
  addedRowsTotal: addedRows.length,
  addedByType: Object.fromEntries(Object.entries(diff?.report ?? {}).map(([k, v]) => [k, v.added ?? v.addedNoId ?? 0])),
  changedByType: Object.fromEntries(Object.entries(diff?.report ?? {}).map(([k, v]) => [k, v.changed ?? 0]).filter(([, n]) => n)),
  addedSample: addedRows.slice(0, 4),
  sized,
  compState: diff?.comp ?? null,
  libraryLookups: diff?.lib ?? null,
}
out.verdict = {
  symbolSizeMeasured: sized.length > 0,
  constant6x11: sized.length ? (sized.some((r) => r.h === 11 && r.w === 6) ? 'CONFIRMED' : 'CONTRADICTED') : 'UNMEASURABLE',
  reason: sized.length
    ? 'a new primitive carries Width/Height'
    : 'the flag adds no primitive of any drawing type that carries width or height, and the component state exposes no size field',
  staggerClaim: sized.length
    ? `symbol box ${sized[0].w}x${sized[0].h}, clears whenever its height is <= 20`
    : 'CONDITIONAL: glyph height unmeasured, so "stagger clears symbol collision" holds only for a glyph of height <= 20',
}

// ---- 6. two-way residue assertion ----------------------------------------
const cleanup = await call(`
const probe = ${JSON.stringify(pageStep.probe)};
const main = ${JSON.stringify(base.main)};
const expected = ${JSON.stringify([...new Set([...out.residueBefore, pageStep.probe])])};
if (probe === main) return { status: 'REFUSED_DELETE_MAIN' };
const exists = async (u) => { try { const r = await eda.dmt_Schematic.getSchematicPageInfo(u); return !!(r && r.uuid) } catch (e) { return 'ERR' } };
let closed = null, deleted = null;
try { closed = JSON.stringify(await eda.dmt_EditorControl.closeDocument(probe)) } catch (e) { closed = 'ERR' }
await new Promise(r => setTimeout(r, 900));
try { deleted = JSON.stringify(await eda.dmt_Schematic.deleteSchematicPage(probe)) } catch (e) { deleted = 'ERR ' + String(e && e.message || e).slice(0, 80) }
let pages = [];
for (let i = 0; i < 3; i++) {
  await new Promise(r => setTimeout(r, 800));
  pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
}
const listed = pages.filter(u => u !== main);
const existence = {};
for (const u of expected) existence[u] = await exists(u);
const extra = listed.filter(u => !expected.includes(u));
const missingFromList = expected.filter(u => !listed.includes(u));
const missingReal = expected.filter(u => existence[u] !== true);
return { closed, deleted, listed, existence, extra, missingFromList, missingReal, mainStillThere: pages.includes(main) };
`)
out.cleanup = cleanup

// Two-way: nothing may have appeared, and every page that is supposed to exist
// must still exist. Existence is the authority because the list flaps; a page
// that merely dropped out of the list is reported, not silently accepted.
const ok = cleanup?.mainStillThere && (cleanup?.extra ?? []).length === 0 && (cleanup?.missingReal ?? []).length === 0
out.residueCheck = {
  expected: [...new Set([...out.residueBefore, pageStep.probe])].sort(),
  listed: [...(cleanup?.listed ?? [])].sort(),
  existence: cleanup?.existence ?? {},
  extra: cleanup?.extra ?? [],
  missingFromList: cleanup?.missingFromList ?? [],
  missingReal: cleanup?.missingReal ?? [],
  listFlap: (cleanup?.missingFromList ?? []).length > 0,
}
out.status = ok ? 'OK' : 'RESIDUE_MISMATCH'

console.log(JSON.stringify(out, null, 1))
process.exitCode = ok ? 0 : 1
