// r8t8: read-only live cross-check of t2's liveReadout claim.
// No save/modify/create/delete/clear/openDocument; no canvas click or typing.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const repo = resolve('D:/projects/nodejs/deepseek-eda-plugins')
const { HttpEasyEdaBridge } = await import(pathToFileURL(resolve(repo, 'packages/eda-core/lib/index.js')).href)

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 15_000 })
const out = await bridge.execute(`
  const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
  const byType = {};
  const plus3v3 = [];
  for (const c of comps) {
    const t = String(c.componentType || '');
    byType[t] = (byType[t] || 0) + 1;
    const nm = String(c.name || '');
    const dg = String(c.designator || '');
    if (nm.includes('3V3') || dg.includes('3V3')) {
      plus3v3.push({ id: String(c.primitiveId ?? c.id ?? ''), type: t, designator: dg, name: nm });
    }
  }
  const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: String(p.uuid), name: String(p.name) }));
  const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
  return { total: comps.length, byType, plus3v3, pageCount: pages.length, pages, activeUuid: active && String(active.uuid) };
`, { timeoutMs: 60_000 })

console.log(JSON.stringify(out, null, 1))
