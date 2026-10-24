// r8t5: read-only live cross-check. No save/modify/create/delete/clear/openDocument.
// Counts by componentType and reads the live page list, independently of t53.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const repo = resolve('D:/projects/nodejs/deepseek-eda-plugins')
const { HttpEasyEdaBridge } = await import(pathToFileURL(resolve(repo, 'packages/eda-core/lib/index.js')).href)

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 15_000 })
const out = await bridge.execute(`
  const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
  const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: String(p.uuid), name: String(p.name) }));
  const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
  const byType = {};
  for (const c of comps) {
    const t = String(c.componentType || '');
    byType[t] = (byType[t] || 0) + 1;
  }
  return {
    comps: comps.length,
    byType,
    pages: pages.length,
    pageNames: pages.map(p => p.name),
    activeUuid: active && String(active.uuid),
    activeName: active && String(active.name),
  };
`, { timeoutMs: 60_000 })

console.log(JSON.stringify(out, null, 1))
