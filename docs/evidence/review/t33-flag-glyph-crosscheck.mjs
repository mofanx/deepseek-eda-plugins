// t33: independent cross-review of t2 (read-only). Does not touch t2's script.
//
// t2 answers "what is the flag glyph?" by placing one flag on a probe page and
// diffing every primitive namespace. Two gaps are checked here:
//
//   1. the diff compares PrimitiveId sets only, and drops any primitive whose id
//      is unreadable (`if (id && ...)`), so a glyph drawn without ids would look
//      like "nothing added";
//   2. it needs a fresh page to run at all.
//
// This script instead uses the 14 flags ALREADY on the delivered page: if the
// glyph were page primitives, 14 flags would have produced glyph primitives near
// their positions. That tests the same hypothesis with no mutation and no new
// orphan page. It also probes an accessor family t2 never touched (Symbol /
// Component / OtherProperty on the flag component) for an embedded definition.
//
// Usage: node docs/evidence/review/t33-flag-glyph-crosscheck.mjs
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
const gate = { src: newestMtime(join(pkgDir, 'eda-core/src'), '.ts'), lib: newestMtime(join(pkgDir, 'eda-core/lib'), '.js') }
if (gate.lib < gate.src) {
  console.error(JSON.stringify({ status: 'STALE_BUILD', ...gate }, null, 1))
  process.exit(1)
}

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })

const out = { status: 'OK', fresh: { src: new Date(gate.src).toISOString(), lib: new Date(gate.lib).toISOString() } }

out.live = await bridge.execute(`
const names = (o) => {
  const s = new Set();
  let p = o;
  while (p && p !== Object.prototype) { for (const k of Object.getOwnPropertyNames(p)) if (typeof o[k] === 'function') s.add(k); p = Object.getPrototypeOf(p) }
  return [...s].sort();
};
// (1) the three namespaces t2 had to enumerate, by module surface and by instance count
const mods = {};
for (const n of ['sch_PrimitivePolygon', 'sch_PrimitiveArc', 'sch_PrimitiveCircle', 'sch_PrimitiveRectangle', 'sch_PrimitiveText']) {
  let count = null, err = null, sample = null;
  try {
    const all = (await eda[n].getAll()) || [];
    count = all.length;
    if (all.length) sample = names(all[0]).filter(k => /^getState_/.test(k));
  } catch (e) { err = String(e && e.message || e).slice(0, 80) }
  mods[n] = { moduleMethods: eda[n] ? names(eda[n]).filter(k => !/^getState_/.test(k)) : null, count, err, sampleInstanceMethods: sample };
}
// (2) the flags already on the page
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const flags = [];
for (const c of comps) {
  const id = c.getState_PrimitiveId ? c.getState_PrimitiveId() : null;
  const nm = c.getState_Name ? c.getState_Name() : null;
  if (typeof id === 'string' && id.startsWith('layout:flag:')) flags.push({ id, name: nm, x: c.getState_X(), y: c.getState_Y() });
}
// (3) accessors t2 never probed, on one flag and one regular part
const dumpOne = async (c) => {
  const o = { id: c.getState_PrimitiveId ? c.getState_PrimitiveId() : null };
  for (const k of ['Symbol', 'Component', 'ComponentType', 'OtherProperty', 'UniqueId', 'Footprint', 'Manufacturer']) {
    try {
      const v = c['getState_' + k] ? await c['getState_' + k]() : undefined;
      o[k] = typeof v === 'string' ? v.slice(0, 300) : (v && typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : v);
    } catch (e) { o[k] = 'ERR' }
  }
  return o;
};
const flagComp = comps.find(c => { const i = c.getState_PrimitiveId ? c.getState_PrimitiveId() : null; return typeof i === 'string' && i.startsWith('layout:flag:') });
const partComp = comps.find(c => { const i = c.getState_PrimitiveId ? c.getState_PrimitiveId() : null; return typeof i === 'string' && i.startsWith('u') });
return {
  mods,
  flags,
  accessorDump: { flag: flagComp ? await dumpOne(flagComp) : null, part: partComp ? await dumpOne(partComp) : null },
  pageCount: ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).length,
  compCount: comps.length,
};
`, { timeoutMs: 180_000 })

// (4) static proximity test: would the glyph be visible as primitives near the flags?
const rects = (await bridge.execute(`
const out = [];
for (const p of (await eda.sch_PrimitiveRectangle.getAll()) || []) out.push({ id: p.getState_PrimitiveId(), x: p.getState_TopLeftX(), y: p.getState_TopLeftY(), w: p.getState_Width(), h: p.getState_Height() });
const texts = [];
for (const p of (await eda.sch_PrimitiveText.getAll()) || []) texts.push({ id: p.getState_PrimitiveId(), x: p.getState_X(), y: p.getState_Y() });
return { rects: out, texts };
`, { timeoutMs: 120_000 }))

// Distance to the OUTLINE (a point inside a frame is not "at distance 0"), and
// only glyph-sized candidates count: the module frame passes around every flag,
// so including it would report a hit for all 14 flags and prove nothing.
const distToOutline = (px, py, b) => {
  const inside = px > b.x && px < b.x + b.w && py > b.y && py < b.y + b.h
  if (inside) return Math.min(px - b.x, b.x + b.w - px, py - b.y, b.y + b.h - py)
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w))
  const dy = Math.max(b.y - py, 0, py - (b.y + b.h))
  return Math.hypot(dx, dy)
}
const glyphSized = rects.rects.filter((r) => r.w <= 30 && r.h <= 30)
const near = out.live.flags.map((f) => {
  let best = { d: Infinity, id: null, what: null }
  for (const r of glyphSized) {
    const d = distToOutline(f.x, f.y, r)
    if (d < best.d) best = { d, id: r.id, what: `rect ${r.w}x${r.h}` }
  }
  for (const t of rects.texts) {
    const d = Math.hypot(t.x - f.x, t.y - f.y)
    if (d < best.d) best = { d, id: t.id, what: 'text' }
  }
  return { flag: f.id, x: f.x, y: f.y, nearest: best.id, nearestWhat: best.what, d: Math.round(best.d * 100) / 100 }
})

out.flags = out.live.flags
out.glyphAsPrimitives = {
  hypothesis: 'if the flag glyph were page primitives, 14 flags would leave glyph-sized primitives near their origins',
  polygonArcCircleInstances: ['sch_PrimitivePolygon', 'sch_PrimitiveArc', 'sch_PrimitiveCircle'].map((n) => `${n}=${out.live.mods[n].count}`),
  glyphSizedRectCandidates: glyphSized.length,
  nearestPrimitivePerFlag: near,
  flagsWithPrimitiveWithin20: near.filter((n) => n.d <= 20).length,
  ofFlags: near.length,
}
out.pitchCheck = (() => {
  const byX = {}
  for (const f of out.live.flags) (byX[f.x] ??= []).push(f.y)
  const rows = Object.entries(byX).map(([x, ys]) => ({ x: Number(x), n: ys.length, ys: ys.sort((a, b) => a - b) }))
  const deltas = rows.map((r) => ({ x: r.x, n: r.n, pitches: r.ys.slice(1).map((y, i) => Math.round((y - r.ys[i]) * 100) / 100) }))
  return deltas.filter((d) => d.n > 1)
})()
out.accessorDump = out.live.accessorDump
out.scope = { pageCount: out.live.pageCount, compCount: out.live.compCount }

// (5) the library path t2 never took: the flag component names its own symbol,
// so look that exact uuid up instead of the netFlagComponentUuid_* helper that
// returned an empty uuid in earlier rounds.
out.libraryPath = await bridge.execute(`
const lib = {};
const mods = Object.keys(eda).filter(k => /^lib_/.test(k) && typeof eda[k] === 'object');
lib.modules = mods;
const symOf = (c) => {
  try {
    const v = c.getState_Symbol();
    if (!v) return null;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (e) { return null }
};
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const flagComp = comps.find(c => String(c.getState_PrimitiveId ? c.getState_PrimitiveId() : '').startsWith('layout:flag:'));
const ref = flagComp ? symOf(flagComp) : null;
lib.flagSymbolRef = ref;
const call = async (label, fn) => {
  try {
    const r = await fn();
    lib[label] = r === null ? 'null' : r === undefined ? 'undefined' : typeof r === 'string' ? r.slice(0, 200) : JSON.stringify(r).slice(0, 500);
  } catch (e) { lib[label] = 'ERR ' + String(e && e.message || e).slice(0, 120) }
};
if (ref && ref.uuid) {
  lib.symbolMethods = typeof eda.lib_Symbol?.getOwnPropertyNames === 'function' ? null : null;
  for (const k of Object.keys(eda.lib_Symbol || {})) { if (typeof eda.lib_Symbol[k] === 'function') lib['m_' + k] = true }
  await call('get_uuid', () => eda.lib_Symbol.get(ref.uuid));
  await call('get_obj', () => eda.lib_Symbol.get({ uuid: ref.uuid, libraryUuid: ref.libraryUuid }));
  await call('get_obj_uuids', () => eda.lib_Symbol.get({ uuids: [ref.uuid] }));
  await call('search_uuid', () => eda.lib_Symbol.search(ref.uuid));
  await call('device_get', () => eda.lib_Device?.get?.(ref.uuid));
}
return lib;
`, { timeoutMs: 120_000 })


console.log(JSON.stringify(out, null, 1))
