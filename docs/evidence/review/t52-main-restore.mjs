// t52: the ONE script allowed to delete primitives from MAIN, and only the 42 ids
// that two independent reviews agreed are stray test netflags.
//
// Three conditions must hold for every single deletion. Any of them failing means
// the run ABORTS and reports, never "fixes up" and continues:
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
// Batches: 1 = the 18 ids certified by the independent review (12 nets that already
// have a layout:flag, 6 nets with no wire), 2 = the 24 held ids (nets that still
// have a wire). The caller decides how many of a batch to run per invocation with
// --limit, so every step can be cold-read before the next one.
//
// Fail-open fixes (t2, 2026-10-21):
//   * `already-gone` now ABORTS. An id disappearing between two reads is an
//     unexplained state change (cec711d2 did exactly this and was skipped); the
//     only safe reaction is to stop and report, not to continue.
//   * a mid-run type/whitelist/coordinate change also aborts instead of skipping;
//     preflight already validated the plan, so any change is unexplained.
//   * preconditions failure returns immediately. The old `finish()` only scheduled
//     `process.exit` 250 ms later and did NOT return, so a failed preflight could
//     still enter the delete loop before the timer fired.
//
// The loop lives in `runRestore(deps)` so it can be driven by a fake bridge with no
// EDA window at all; `docs/evidence/review/t54-restore-selftest.mjs` does that.

import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

export const READ = `
const all = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: p.uuid, name: p.name }));
const wires = ((await eda.sch_PrimitiveWire.getAll()) || []);
const rows = all.map(c => ({ id: String(c.primitiveId || c.id), type: String(c.componentType || ''), x: Math.round(Number(c.x) || 0), y: Math.round(Number(c.y) || 0), net: String(c.net || '') }));
return { active: page && page.uuid, pages, rows, wires: wires.length, wireNets: [...new Set(wires.map(w => String(w.net || '')).filter(Boolean))].length };
`

export const djb2 = (s) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

/**
 * Run one restore slice.
 *
 * deps:
 *   readAll()            -> { active, pages, rows, wires, wireNets }   (required)
 *   deleteOne(id)        -> value                                      (required when execute)
 *   set                  -> ids that belong to this batch              (required)
 *   all42                -> the reviewed whitelist ids                 (required)
 *   snapshot             -> the polluted snapshot { components, wires }(required)
 *   limit, execute, expectedBefore, batch
 *   saveAfter, saveDocument()  -> value
 *   sleep(ms)            -> test hook, default setTimeout
 *
 * Returns the report object; `report.exitCode` is 0 only for OK / DRY.
 */
export async function runRestore (deps) {
  const {
    readAll,
    deleteOne,
    set,
    all42,
    snapshot,
    limit = 999,
    execute = false,
    expectedBefore = 0,
    batch = 1,
    saveAfter = false,
    saveDocument = null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = deps

  const snapshotById = new Map((snapshot.components ?? []).map((c) => [c.id, c]))
  const before = await readAll()
  const mainId = (before.pages.find((p) => p.name === 'MAIN') ?? {}).uuid
  // The plan is "the ids this invocation intends to delete", not "the ids that
  // happen to still exist". Filtering by presence first is what made the old
  // alreadyGone list dead code: an id that had already vanished merely shrank the
  // plan, so the run reported OK.
  const plan = set.slice(0, limit)
  const actionable = plan.filter((id) => before.rows.some((r) => r.id === id))
  const alreadyGone = plan.filter((id) => !before.rows.some((r) => r.id === id))
  const problems = []

  if (!mainId) problems.push('MAIN page not found')
  if (before.active !== mainId) problems.push(`active document is ${before.active}, not MAIN`)
  if (expectedBefore && before.rows.length !== expectedBefore) problems.push(`expected ${expectedBefore} components, read ${before.rows.length}`)
  for (const id of plan) {
    const row = before.rows.find((r) => r.id === id)
    const rec = snapshotById.get(id)
    if (!row) continue
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
    exitCode: 0
  }

  // An id that is already gone before we start is an unexplained state change, not
  // a no-op. Abort; do not delete anything else in this run.
  if (alreadyGone.length) {
    report.aborted = 'ALREADY_GONE_PREFLIGHT'
    report.status = 'ABORTED'
    report.exitCode = 2
    return report
  }
  if (!report.preconditions.ok) {
    report.aborted = 'PRECONDITIONS_FAILED'
    report.status = 'ABORTED'
    report.exitCode = 2
    return report
  }
  if (!execute) {
    report.status = 'DRY'
    return report
  }

  for (const id of plan) {
    // Re-check the active document before EVERY delete: the canvas may have been
    // taken over since the last one.
    const stamp = await readAll()
    if (stamp.active !== mainId) {
      report.steps.push({ id, stopped: 'ACTIVE_IS_NOT_MAIN', active: stamp.active })
      report.aborted = 'ACTIVE_IS_NOT_MAIN'
      break
    }
    const row = stamp.rows.find((r) => r.id === id)
    if (!row) {
      report.steps.push({ id, stopped: 'ALREADY_GONE_DURING_RUN' })
      report.aborted = 'ALREADY_GONE_DURING_RUN'
      break
    }
    if (row.type !== 'netflag') {
      report.steps.push({ id, stopped: `WRONG_TYPE_${row.type}` })
      report.aborted = `WRONG_TYPE_${row.type}`
      break
    }
    if (!all42.includes(id)) {
      report.steps.push({ id, stopped: 'NOT_WHITELISTED_DURING_RUN' })
      report.aborted = 'NOT_WHITELISTED_DURING_RUN'
      break
    }
    const rec = snapshotById.get(id)
    if (rec && (rec.x !== row.x || rec.y !== row.y)) {
      report.steps.push({ id, stopped: 'COORDS_MOVED' })
      report.aborted = 'COORDS_MOVED'
      break
    }
    let ret = null
    let error = null
    try {
      const v = await deleteOne(id)
      ret = v === undefined ? null : JSON.stringify(v)
    } catch (e) {
      error = String((e && e.message) || e).slice(0, 120)
    }
    await sleep(500)
    const after = await readAll()
    const gone = !after.rows.some((r) => r.id === id)
    const delta = stamp.rows.length - after.rows.length
    report.steps.push({ id, ret, error, gone, delta, components: after.rows.length, wires: after.wires, wireNets: after.wireNets, active: after.active })
    if (!gone) { report.aborted = 'DELETE_DID_NOT_TAKE'; break }
    if (delta !== 1) { report.aborted = `COMPONENT_DELTA_${delta}`; break }
    if (after.active !== mainId) { report.aborted = 'ACTIVE_LEFT_MAIN'; break }
    if (after.wires !== before.wires) { report.aborted = `WIRES_CHANGED_${before.wires}->${after.wires}`; break }
    report.deleted.push(id)
  }

  const final = await readAll()
  const rows = final.rows
  const hexFlags = rows.filter((r) => r.type === 'netflag' && /^[0-9a-f]{16}$/.test(r.id)).map((r) => r.id)
  const layoutFlags = rows.filter((r) => r.type === 'netflag' && /^layout:/.test(r.id)).map((r) => r.id)
  const parts = rows.filter((r) => r.type === 'part')
  const s1 = rows.map((r) => `${r.id}|${r.type}`).sort().join(';')
  const s2 = (snapshot.wires ?? []).map((w) => `${w.id}|${w.net}`).sort().join(';')
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
    newIds: rows.filter((r) => !snapshotById.has(r.id)).map((r) => r.id)
  }
  report.status = report.aborted ? 'ABORTED' : (report.deleted.length === actionable.length ? 'OK' : 'PARTIAL')
  report.exitCode = report.status === 'OK' ? 0 : 2

  if (saveAfter) {
    if (final.active !== mainId) {
      report.save = { skipped: 'ACTIVE_IS_NOT_MAIN', active: final.active }
    } else if (!saveDocument) {
      report.save = { saved: false, error: 'NO_SAVE_FUNCTION' }
    } else {
      try {
        const v = await saveDocument()
        report.save = { saved: true, value: v == null ? null : JSON.stringify(v) }
      } catch (e) {
        report.save = { saved: false, error: String((e && e.message) || e).slice(0, 160) }
      }
    }
  }
  return report
}

// ---------------------------------------------------------------------------
// CLI. Only this block touches the real bridge; importing the module is inert,
// which is what lets t54 drive runRestore with no EDA window at all.
// ---------------------------------------------------------------------------
const isMain = (() => {
  try {
    return process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false
  } catch {
    return false
  }
})()

if (isMain) {
  const argv = process.argv.slice(2)
  const arg = (name, fallback = null) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`))
    return hit ? hit.split('=')[1] : fallback
  }
  const execute = argv.includes('--execute')
  const batch = Number(arg('batch', '1'))
  const limit = Number(arg('limit', '999'))
  const saveAfter = argv.includes('--save')
  const expectedBefore = Number(arg('expect', '0'))

  const whitelist = JSON.parse(readFileSync(resolve(repo, 'docs/evidence/current/main-whitelist-r3t2.json'), 'utf8'))
  const snapshot = JSON.parse(readFileSync(resolve(repo, 'docs/evidence/current/main-snapshot-r3t2.json'), 'utf8'))
  const all42 = [...whitelist.certified, ...whitelist.held].map((x) => (typeof x === 'string' ? x : x.id))
  const set = batch === 1 ? whitelist.certified.map((x) => x.id ?? x) : whitelist.held.map((x) => (typeof x === 'string' ? x : x.id))

  const { HttpEasyEdaBridge } = await import(pathToFileURL(resolve(repo, 'packages/eda-core/lib/index.js')).href)
  const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 30_000 })
  const call = (code, timeoutMs = 120_000) => bridge.execute(code, { timeoutMs })

  const report = await runRestore({
    readAll: () => call(READ, 120_000),
    deleteOne: (id) => call(`const r = await eda.sch_PrimitiveComponent.delete(${JSON.stringify(id)}); return r === undefined ? null : r;`, 60_000),
    saveDocument: () => call('const r = await eda.sch_Document.save(); return r === undefined ? null : r;', 60_000),
    set,
    all42,
    snapshot,
    limit,
    execute,
    expectedBefore,
    batch,
    saveAfter
  })

  if (!execute) {
    console.log(JSON.stringify({ ...report, wouldDelete: report.planned }, null, 1))
  } else {
    writeFileSync(resolve(repo, `docs/evidence/current/main-restore-${batch}-${Date.now()}.json`), JSON.stringify(report, null, 1))
    console.log(JSON.stringify(report, null, 1))
  }
  // The bridge keeps an HTTP handle open. Calling process.exit() immediately after
  // a request trips a libuv assertion on Windows ("UV_HANDLE_CLOSING") and the
  // process dies with 0xC0000409 instead of the verdict, which makes the exit code
  // useless. Let stdout flush and the handle settle, then exit with the verdict.
  process.exitCode = report.exitCode
  setTimeout(() => process.exit(report.exitCode), 300)
}
