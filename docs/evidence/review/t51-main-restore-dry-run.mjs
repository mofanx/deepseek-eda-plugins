// t51: read-only delete PLAN for the MAIN pollution. This script never deletes,
// never saves, never creates. It only reads the reviewed whitelist and the live
// page, then prints what a deletion WOULD do.
//
// Why a dry run: MAIN lost 42 stray netflags to evidence scripts (see §14.35.8).
// Before anyone calls deleteSchematicPage/delete, the plan must be inspectable and
// the expected counts must be stated up front, so a wrong plan is caught on paper
// instead of on the user's schematic.
//
// Usage:
//   node docs/evidence/review/t51-main-restore-dry-run.mjs                # certified set
//   node docs/evidence/review/t51-main-restore-dry-run.mjs --set=all      # all 42 reviewed ids
//   node docs/evidence/review/t51-main-restore-dry-run.mjs --set=certified
//
// Exit: 0 = plan printed (always, unless the bridge or the files are unreadable).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BRIDGE = process.env.EDA_BRIDGE_URL || 'http://127.0.0.1:49620/execute'
// review/ -> evidence/ -> docs/ -> repo root
const ROOT = resolve(import.meta.dirname, '../../..')
const WHITELIST = resolve(ROOT, 'docs/evidence/current/main-whitelist-r3t2.json')

const argv = process.argv.slice(2)
const setArg = (argv.find((a) => a.startsWith('--set=')) || '--set=certified').slice('--set='.length)
if (!['certified', 'all'].includes(setArg)) {
  console.error(`unknown --set=${setArg} (certified|all)`)
  process.exit(1)
}

async function call(code) {
  const res = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const body = await res.json()
  if (body && body.error) throw new Error(JSON.stringify(body.error).slice(0, 300))
  return body.result
}

const state = await call(`
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const wires = (await eda.sch_PrimitiveWire.getAll(undefined, false)) || [];
const g = (o, n) => { try { const f = o['getState_' + n]; if (typeof f !== 'function') return null; const v = f.call(o); return v === undefined ? null : v } catch (e) { return null } };
const rows = comps.map(c => ({ id: g(c, 'PrimitiveId'), type: g(c, 'ComponentType'), net: g(c, 'Net') }));
const wnets = wires.map(w => g(w, 'Net')).filter(n => n !== null && n !== '');
return {
  page: { uuid: String(cur.uuid), name: cur.name },
  comps: rows,
  byType: rows.reduce((m, r) => (m[r.type ?? 'null'] = (m[r.type ?? 'null'] || 0) + 1, m), {}),
  wires: wires.length,
  wireNets: [...new Set(wnets)].sort(),
  allNets: [...new Set([...rows.map(r => r.net), ...wnets].filter(n => n !== null && n !== ''))].sort(),
  flagOnlyNets: [...new Set(rows.filter(r => r.type === 'netflag').map(r => r.net))].filter(n => !wnets.includes(n)).sort(),
};
`)

const wl = JSON.parse(readFileSync(WHITELIST, 'utf8'))

// The plan is only meaningful on MAIN. getAll() follows the painted document, and
// another member's probe run can leave the canvas on an empty page (measured
// 2026-10-21: page e69b0fe0:P2, 0 components, while this task was reading). Refuse
// to print a plan unless the page and the polluted count match the reviewed state.
const EXPECTED = { name: 'MAIN', components: 63 }
if (state.page.name !== EXPECTED.name || state.comps.length !== EXPECTED.components) {
  console.error(JSON.stringify({
    status: 'NOT_ON_MAIN',
    page: state.page,
    components: state.comps.length,
    expected: EXPECTED,
    hint: 'another run has the canvas on another page; re-run when MAIN is painted. No plan was produced and nothing was written.',
  }))
  process.exit(2)
}

const plan = setArg === 'all' ? [...wl.certified, ...wl.held] : wl.certified
const ids = plan.map((p) => p.id)

const live = new Map(state.comps.map((c) => [c.id, c]))
const missing = ids.filter((id) => !live.has(id))
const wrongType = ids.filter((id) => live.has(id) && live.get(id).type !== 'netflag')
const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i)

// Predicted result of deleting exactly `ids`, assuming the client honours the ids
// (it does not always: t27 measured false+gone / true+still-there). The plan is a
// lower bound on what must be re-read afterwards.
const remaining = state.comps.filter((c) => !ids.includes(c.id))
const byTypeAfter = remaining.reduce((m, r) => (m[r.type ?? 'null'] = (m[r.type ?? 'null'] || 0) + 1, m), {})
const netsAfterDelete = [...new Set(remaining.map((r) => r.net).concat(state.wireNets).filter((n) => n !== null && n !== ''))]
const disappearingNets = state.flagOnlyNets.filter((n) => !remaining.some((r) => r.net === n))

const target = { components: 21, part: 8, netflag: 13, wires: 55, wireNets: 55 }
const out = {
  at: new Date().toISOString(),
  mode: 'DRY_RUN (no delete, no save, no create)',
  set: setArg,
  page: state.page,
  planSource: 'docs/evidence/current/main-whitelist-r3t2.json',
  deleteIds: ids,
  countsBefore: { components: state.comps.length, ...state.byType, wires: state.wires, wireNets: state.wireNets.length, allNets: state.allNets.length },
  expectedAfter: {
    components: remaining.length,
    ...byTypeAfter,
    wires: state.wires,
    wireNets: state.wireNets.length,
    allNets: netsAfterDelete.length,
    flagOnlyNetsRemaining: remaining.filter((r) => r.type === 'netflag' && !state.wireNets.includes(r.net)).map((r) => r.net).sort(),
  },
  target,
  matchesTarget:
    remaining.length === target.components &&
    (byTypeAfter.part ?? 0) === target.part &&
    (byTypeAfter.netflag ?? 0) === target.netflag &&
    state.wires === target.wires &&
    state.wireNets.length === target.wireNets,
  guard: {
    missingFromLive: missing,
    wrongComponentType: wrongType,
    duplicateIds: dupIds,
    safeToApply: missing.length === 0 && wrongType.length === 0 && dupIds.length === 0,
  },
  netsThatWouldDisappear: disappearingNets,
  notes: [
    'wireNets 是导线上出现的网名（55 个，删 flag 不变）；allNets 是「导线 ∪ flag」的全集，删掉无导线网的 flag 会让它变小。',
    'expectedAfter 是「按 id 删除」的理想结果，不是承诺：client 的 delete 返回值既可能假也可能滞后，执行后必须重新冷读核对。',
    'certified 集合只有 18 条，删完是 45 器件；只有 all(42) 才恰好到 21/55。42 条里有 24 条不满足字面判据 p3，见白名单 held 段。',
  ],
}

console.log(JSON.stringify(out, null, 1))
if (missing.length || wrongType.length) process.exit(1)
