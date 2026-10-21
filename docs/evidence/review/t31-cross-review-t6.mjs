// t31: independent cross-review of t6, read-only.
//
// t6 concluded the flag's symbol box is not measurable. That conclusion is only
// as strong as the paths tried, so this probes the API surface itself instead of
// guessing accessor names: enumerate the prototype, then call whatever looks
// like it could carry a size.
//
// Read-only: only get*()/enumeration. Nothing is created, modified or deleted.
// It stays on the page that is already active.
//
// Usage: node docs/evidence/review/t31-cross-review-t6.mjs
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../../..')
const pkgDir = join(repoRoot, 'packages')
const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })

const probe = await bridge.execute(`
const names = (o) => {
  if (!o) return [];
  const s = new Set();
  let p = o;
  while (p && p !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(p)) s.add(k);
    p = Object.getPrototypeOf(p);
  }
  return [...s].sort();
};
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const c0 = comps[0] || null;
const c1 = comps[1] || null;
const attr0 = ((await eda.sch_PrimitiveAttribute.getAll()) || [])[0] || null;

// Anything that could plausibly carry a size.
const sizeish = (list) => list.filter(n => /width|height|size|bound|bbox|extent|rect/i.test(n));

const comp = names(c0);
const attr = names(attr0);
const compCalls = {};
for (const n of sizeish(comp)) {
  if (typeof c0[n] !== 'function') continue;
  try { compCalls[n] = await c0[n]() } catch (e) { compCalls[n] = 'ERR ' + String((e && e.message) || e) }
  if (n === 'getState_BoundingBox') continue;
}

return {
  page: cur && { uuid: cur.uuid, name: cur.name },
  compCount: comps.length,
  compMethodCount: comp.length,
  compSizeish: sizeish(comp),
  compCalls,
  attrMethodCount: attr.length,
  attrSizeish: sizeish(attr),
  compAll: comp.filter(n => /^getState_/.test(n)),
  topLevelDmt: sizeish(names(eda.dmt_Schematic)).concat(names(eda.dmt_Schematic).filter(n => /source|export|svg|image/i.test(n))),
  edaTop: names(eda).filter(n => /source|export|svg|image|clipboard/i.test(n)),
  sample: [c0, c1].map(c => ({ type: c && c.type, id: c && (typeof c.getState_PrimitiveId === 'function' ? c.getState_PrimitiveId() : c.id) })),
};
`, { timeoutMs: 90_000 })

console.log(JSON.stringify(probe, null, 1))
