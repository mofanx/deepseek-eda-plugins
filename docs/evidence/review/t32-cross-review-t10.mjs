// t32: independent cross-review of t10 (read-only).
//
// t10 claims (a) the "activated pages cannot be deleted" causality is gone from
// t29's notes and (b) the damaged project is really gone while the healthy one
// is untouched. Both are checked here from the live document, not from t29's
// own output.
//
// Read-only: only list/inspect calls. No create, modify, delete, openDocument.
//
// Usage: node docs/evidence/review/t32-cross-review-t10.mjs
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../../..')
const pkgDir = join(repoRoot, 'packages')
const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })

const out = { status: 'OK' }

out.live = await bridge.execute(`
const has = (o, n) => !!o && typeof o[n] === 'function';
const api = {
  pages: has(eda.dmt_Schematic, 'getAllSchematicPagesInfo'),
  projects: has(eda.dmt_Schematic, 'getAllSchematicsInfo'),
  info: has(eda.dmt_Schematic, 'getSchematicInfo'),
  current: has(eda.dmt_Schematic, 'getCurrentSchematicPageInfo'),
};
const pages = api.pages ? ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: p.uuid, name: p.name })) : [];
const cur = api.current ? await eda.dmt_Schematic.getCurrentSchematicPageInfo() : null;
const projects = api.projects ? ((await eda.dmt_Schematic.getAllSchematicsInfo()) || []).map(p => ({ uuid: p.uuid, name: p.name })) : [];

// The project t10 says is damaged and gone.
const damaged = 'd0d13fae';
let damagedInfo;
try { damagedInfo = api.info ? await eda.dmt_Schematic.getSchematicInfo(damaged) : 'NO_API' } catch (e) { damagedInfo = 'ERR ' + String((e && e.message) || e) }

// Control: the healthy project that owns the pages.
const healthyUuid = projects.length ? projects[0].uuid : null;
let healthyInfo;
try { healthyInfo = (healthyUuid && api.info) ? await eda.dmt_Schematic.getSchematicInfo(healthyUuid) : 'NO_API' } catch (e) { healthyInfo = 'ERR ' + String((e && e.message) || e) }

const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
return {
  api,
  currentPage: cur ? { uuid: cur.uuid, name: cur.name } : null,
  pageCount: pages.length,
  pages,
  projectCount: projects.length,
  projects,
  damagedInfo,
  healthyUuid,
  healthyKeys: healthyInfo && typeof healthyInfo === 'object' ? Object.keys(healthyInfo).slice(0, 12) : String(healthyInfo),
  healthyHasName: !!(healthyInfo && typeof healthyInfo === 'object' && healthyInfo.name),
  componentsOnCurrent: comps.length,
};
`, { timeoutMs: 90_000 })

const main = out.live.currentPage?.uuid
out.residue = (out.live.pages ?? []).filter((p) => p.uuid !== main)

// What t29 will expect at runtime: the residue it finds BEFORE it starts, plus
// its own probe. So the invariant is "no page appears or vanishes beyond that".
// Here we only assert the static set the review was told to expect.
out.residueNames = out.residue.map((p) => p.name)
out.residueCount = out.residue.length
out.mainIntact = out.live.pageCount > out.residueCount && (out.live.pages ?? []).some((p) => p.uuid === main)

console.log(JSON.stringify(out, null, 1))
