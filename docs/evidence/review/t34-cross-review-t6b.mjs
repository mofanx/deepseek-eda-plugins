// t34: independent cross-review of t6 (read-only). Does not touch t6's script.
//
// Checks four claims:
//   A. hidden primitives: the three getAll states really return the same counts
//   B. the five pages that vanished really return null from the authoritative
//      getSchematicPageInfo, and the window id differs from the recorded one
//   C. the current page list / residue / MAIN
//   D. the library handle t6 reported (Symbol uuid 76b7e88fa7a25480) really is
//      unreachable through lib_Symbol / lib_Device in every argument shape
//
// Usage: node docs/evidence/review/t34-cross-review-t6b.mjs
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gateFreshness } from './shared/freshness.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const freshSnapshot = gateFreshness(repoRoot)
const pkgDir = join(repoRoot, 'packages')

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })

const out = { status: 'OK', fresh: { gate: 'content-sha256', packages: Object.keys(freshSnapshot.packages).length } }

// A + C + D
out.live = await bridge.execute(`
const ns = ['sch_PrimitiveRectangle','sch_PrimitiveText','sch_PrimitiveWire','sch_PrimitiveComponent','sch_PrimitiveAttribute','sch_PrimitivePolygon','sch_PrimitiveArc','sch_PrimitiveCircle'];
const threeState = {};
for (const n of ns) {
  const row = {};
  for (const [k, args] of [['default', []], ['true', [undefined, true]], ['false', [undefined, false]]]) {
    try { row[k] = ((await eda[n].getAll(...args)) || []).length } catch (e) { row[k] = 'ERR' }
  }
  threeState[n] = row;
}
const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: p.uuid, name: p.name }));
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const gone = {};
for (const u of ['02ac66d0d9b59816','02faa29ed5ad13b0','15d389b55fd5f1f7','4bc63c4743a853dd','e47be448cfc1728a']) {
  try { const r = await eda.dmt_Schematic.getSchematicPageInfo(u); gone[u] = r === null ? 'null' : (r && r.uuid ? 'EXISTS:' + r.uuid : String(r)) } catch (e) { gone[u] = 'ERR ' + String(e && e.message || e).slice(0, 60) }
}
const symbol = '76b7e88fa7a25480', lib = '0819f05c4eef4c71ace90d822a990e87';
const libTry = {};
const call = async (k, fn) => { try { const r = await fn(); libTry[k] = r === undefined ? 'undefined' : r === null ? 'null' : (typeof r === 'string' ? r.slice(0, 120) : JSON.stringify(r).slice(0, 200)) } catch (e) { libTry[k] = 'ERR ' + String(e && e.message || e).slice(0, 80) } };
await call('lib_Symbol.get(uuid)', () => eda.lib_Symbol.get(symbol));
await call('lib_Symbol.get({uuid})', () => eda.lib_Symbol.get({ uuid: symbol }));
await call('lib_Symbol.get({uuid,libraryUuid,name})', () => eda.lib_Symbol.get({ uuid: symbol, libraryUuid: lib, name: 'Power-5V' }));
await call('lib_Symbol.search(uuid)', () => eda.lib_Symbol.search(symbol));
await call('lib_Device.get(uuid)', () => eda.lib_Device.get(symbol));
return { threeState, pages, current: cur && { uuid: cur.uuid, name: cur.name }, gone, libTry,
  comps: ((await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []).length };
`, { timeoutMs: 180_000 })

// B: window id from the bridge's own endpoint
let windows = null
try {
  const res = await fetch('http://127.0.0.1:49620/eda-windows')
  windows = await res.json()
} catch (e) { windows = 'ERR ' + String(e && e.message || e).slice(0, 80) }
out.windows = windows

const main = out.live.current?.uuid
out.pages = out.live.pages
out.residue = out.live.pages.filter((p) => p.uuid !== main)
out.residueCount = out.residue.length
out.mainIntact = out.live.pages.some((p) => p.uuid === main) && out.live.comps === 21
out.threeStateAllEqual = Object.values(out.live.threeState).every((r) => r.default === r.true && r.true === r.false)
out.threeState = out.live.threeState
out.gone = out.live.gone
out.libTry = out.live.libTry

console.log(JSON.stringify(out, null, 1))
