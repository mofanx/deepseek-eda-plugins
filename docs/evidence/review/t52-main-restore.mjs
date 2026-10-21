// t52: the ONE script allowed to delete primitives from MAIN, and only the 42 ids
// that two independent reviews agreed are stray test netflags.
//
// Three conditions must hold for every single deletion. Any of them failing means
// the id is skipped and recorded, never "fixed up":
//   1. id is a member of the reviewed 42-id whitelist;
//   2. the primitive's parent page is MAIN;
//   3. its ComponentType is exactly 'netflag'.
//
// On condition 2, stated honestly: the bridge's component objects carry NO parent
// page field. getAll()/getState_* expose primitiveId, componentType, x, y, net,
// designator, symbol... but no sheet/page/owner, and getAll(undefined,true),
// getAll(), getAll(uuid) all return the same shape (the last one returns 0 rows).
// The snapshot's "page" field was an annotation by its author, not a read value.
// So condition 2 is implemented as the strongest check the API supports:
//   a) the active document id is MAIN at the moment of the delete (otherwise abort);
//   b) the id is present in getAll(), which reads the document the canvas paints,
//      i.e. the focused one (t7 measured that getAll follows the focus, not the
//      API's active pointer - which is why (a) and (b) are checked together);
//   c) the row's coordinates match the reviewed snapshot, so it is the same
//      instance and not a same-id object elsewhere;
//   d) after the delete, the focused document's component count drops by exactly 1.
// That is a page-level proof, not a per-object tag. It fails closed: if (a) cannot
// be established, nothing is deleted.
//
// Batch 1 = the 18 ids certified by the independent review (12 nets that already
// have a layout:flag, 6 nets with no wire), batch 2 = the 24 held ids (nets that
// still have a wire). The caller decides how many of a batch to run per invocation
// with --limit, so every step can be cold-read before the next one.

import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const { HttpEasyEdaBridge } = await import(pathToFileURL(resolve(repo, 'packages/eda-core/lib/index.js')).href)

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}
const finish = (code) => setTimeout(() => process.exit(code), 250)
const execute = argv.includes('--execute')
const batch = Number(arg('batch', '1'))
const limit = Number(arg('limit', '999'))
const saveAfter = argv.includes('--save')
const expectedBefore = Number(arg('expect', '0'))

const whitelist = JSON.parse(readFileSync(resolve(repo, 'docs/evidence/current/main-whitelist-r3t2.json'), 'utf8'))
const snapshot = JSON.parse(readFileSync(resolve(repo, 'docs/evidence/current/main-snapshot-r3t2.json'), 'utf8'))
const snapshotById = new Map((snapshot.components ?? []).map((c) => [c.id, c]))

const all42 = [...whitelist.certified, ...whitelist.held].map((x) => (typeof x === 'string' ? x : x.id))
const set = batch === 1 ? whitelist.certified.map((x) => x.id ?? x) : whitelist.held.map((x) => (typeof x === 'string' ? x : x.id))

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 30_000 })
const call = (code, timeoutMs = 120_000) => bridge.execute(code, { timeoutMs })

const READ = `
const all = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: p.uuid, name: p.name }));
const wires = ((await eda.sch_PrimitiveWire.getAll()) || []);
const rows = all.map(c => ({ id: String(c.primitiveId || c.id), type: String(c.componentType || ''), x: Math.round(Number(c.x) || 0), y: Math.round(Number(c.y) || 0), net: String(c.net || '') }));
return { active: page && page.uuid, pages, rows, wires: wires.length, wireNets: [...new Set(wires.map(w => String(w.net || '')).filter(Boolean))].length };
`

const readAll = () => call(READ, 120_000)

const before = await readAll()
const pending = set.filter((id) => before.rows.some((r) => r.id === id))
const plan = pending.slice(0, limit)
const actionable = plan.filter((id) => before.rows.some((r) => r.id === id))
const mainId = (before.pages.find((p) => p.name === 'MAIN') ?? {}).uuid
const problems = []
const alreadyGone = []
if (!mainId) problems.push('MAIN page not found')
if (before.active !== mainId) problems.push(`active document is ${before.active}, not MAIN`)
if (expectedBefore && before.rows.length !== expectedBefore) problems.push(`expected ${expectedBefore} components, read ${before.rows.length}`)
for (const id of plan) {
  const row = before.rows.find((r) => r.id === id)
  const rec = snapshotById.get(id)
  if (!row) { alreadyGone.push(id); continue }
  if (row.type !== 'netflag') problems.push(`${id}: ComponentType is "${row.type}", not netflag`)
  if (!all42.includes(id)) problems.push(`${id}: not in the reviewed 42`)
  if (rec && (rec.x !== row.x || rec.y !== row.y)) problems.push(`${id}: coords moved since the snapshot (${rec.x},${rec.y} -> ${row.x},${row.y})`)
}

const report = {
  at: new Date().toISOString(),
  mode: execute ? 'EXECUTE' : 'DRY',
  batch,
  planned: plan.length,
  actionable: actionable.length,
  batchSize: set.length,
  main: mainId,
  countsBefore: { components: before.rows.length, wires: before.wires, wireNets: before.wireNets, pages: before.pages.length },
  preconditions: { ok: problems.length === 0, problems, alreadyGone },
  skipped: [],
  deleted: [],
  steps: [],
}

if (!report.preconditions.ok) {
  console.log(JSON.stringify(report, null, 1))
  finish(2)
}
if (!execute) {
  console.log(JSON.stringify({ ...report, wouldDelete: plan }, null, 1))
  finish(0)
}

let live = before
for (const id of plan) {
  if (alreadyGone.includes(id)) { report.skipped.push({ id, reason: 'already-gone' }); continue }
  // Re-check the active document before EVERY delete: the canvas may have been
  // taken over since the last one.
  const stamp = await readAll()
  if (stamp.active !== mainId) {
    report.steps.push({ id, stopped: 'ACTIVE_IS_NOT_MAIN', active: stamp.active })
    report.aborted = true
    break
  }
  const row = stamp.rows.find((r) => r.id === id)
  if (!row) {
    report.skipped.push({ id, reason: 'already-gone' })
    continue
  }
  if (row.type !== 'netflag' || !all42.includes(id)) {
    report.skipped.push({ id, reason: row.type !== 'netflag' ? `wrong-type:${row.type}` : 'not-whitelisted' })
    continue
  }
  const rec = snapshotById.get(id)
  if (rec && (rec.x !== row.x || rec.y !== row.y)) {
    report.skipped.push({ id, reason: 'coords-moved' })
    continue
  }
  let ret = null
  let error = null
  try {
    ret = JSON.stringify(await call(`const r = await eda.sch_PrimitiveComponent.delete(${JSON.stringify(id)}); return r === undefined ? null : r;`, 60_000))
  } catch (e) {
    error = String((e && e.message) || e).slice(0, 120)
  }
  await new Promise((r) => setTimeout(r, 500))
  const after = await readAll()
  const gone = !after.rows.some((r) => r.id === id)
  const delta = stamp.rows.length - after.rows.length
  report.steps.push({ id, ret, error, gone, delta, components: after.rows.length, wires: after.wires, wireNets: after.wireNets, active: after.active })
  if (!gone) { report.aborted = 'DELETE_DID_NOT_TAKE'; break }
  if (delta !== 1) { report.aborted = `COMPONENT_DELTA_${delta}`; break }
  if (after.active !== mainId) { report.aborted = 'ACTIVE_LEFT_MAIN'; break }
  if (after.wires !== before.wires) { report.aborted = `WIRES_CHANGED_${before.wires}->${after.wires}`; break }
  report.deleted.push(id)
  live = after
}

const final = await readAll()
const rows = final.rows
const hexFlags = rows.filter((r) => r.type === 'netflag' && /^[0-9a-f]{16}$/.test(r.id)).map((r) => r.id)
const layoutFlags = rows.filter((r) => r.type === 'netflag' && /^layout:/.test(r.id)).map((r) => r.id)
const parts = rows.filter((r) => r.type === 'part')
const s1 = rows.map((r) => `${r.id}|${r.type}`).sort().join(';')
const s2 = (snapshot.wires ?? []).map((w) => `${w.id}|${w.net}`).sort().join(';')
const djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0') }
report.after = {
  components: rows.length,
  parts: parts.length,
  netflag: rows.filter((r) => r.type === 'netflag').length,
  layoutFlags: layoutFlags.length,
  hexFlags: hexFlags.length,
  wires: final.wires,
  wireNets: final.wireNets,
  pages: final.pages.length,
  fingerprintDjb2: djb2(`${s1}#${s2}`),
  remainingWhitelisted: all42.filter((id) => rows.some((r) => r.id === id)),
  missingLayout: (snapshot.components ?? []).filter((c) => c.type === 'part' || /^layout:/.test(c.id)).map((c) => c.id).filter((id) => !rows.some((r) => r.id === id)),
  newIds: rows.filter((r) => !snapshotById.has(r.id)).map((r) => r.id),
}
report.status = report.aborted ? 'ABORTED' : (report.deleted.length === actionable.length ? 'OK' : 'PARTIAL')

if (saveAfter) {
  if (final.active !== mainId) {
    report.save = { skipped: 'ACTIVE_IS_NOT_MAIN', active: final.active }
  } else {
    try {
      const v = await call(`const r = await eda.sch_Document.save(); return r === undefined ? null : r;`, 60_000)
      report.save = { saved: true, value: v == null ? null : JSON.stringify(v) }
    } catch (e) {
      report.save = { saved: false, error: String((e && e.message) || e).slice(0, 160) }
    }
  }
}

writeFileSync(resolve(repo, `docs/evidence/current/main-restore-${batch}-${Date.now()}.json`), JSON.stringify(report, null, 1))
console.log(JSON.stringify(report, null, 1))
finish(report.status === 'OK' ? 0 : 2)
