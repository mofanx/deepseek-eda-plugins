// t35: settle the two count definitions t9 has to reconcile (read-only).
//   A. how many flag components: prefix count vs Global Net Name parent count
//   B. how many text rows the title-block window really covers, and over how
//      many distinct y values
//   C. does the rect mapping stored.TopLeftY = IR y2 hold (border rect = 8..1162)
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../../..')
const pkgDir = join(repoRoot, 'packages')
const newest = (dir, ext) => {
  let m = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(f) }
      else if (e.name.endsWith(ext)) m = Math.max(m, statSync(f).mtimeMs)
    }
  }
  if (existsSync(dir)) walk(dir)
  return m
}
const gate = { src: newest(join(pkgDir, 'eda-core/src'), '.ts'), lib: newest(join(pkgDir, 'eda-core/lib'), '.js') }
if (gate.lib < gate.src) { console.error(JSON.stringify({ status: 'STALE_BUILD', ...gate })); process.exit(1) }

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const data = await bridge.execute(`
const g = (o, k) => { try { const f = o['getState_' + k]; return typeof f === 'function' ? f.call(o) : o[k] } catch (e) { return null } };
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const attrs = (await eda.sch_PrimitiveAttribute.getAll(undefined, false)) || [];
const texts = (await eda.sch_PrimitiveText.getAll(undefined, false)) || [];
const rects = (await eda.sch_PrimitiveRectangle.getAll(undefined, false)) || [];
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const compIds = comps.map(c => g(c, 'PrimitiveId'));
return {
  main: cur && { uuid: cur.uuid, name: cur.name },
  flagPrefix: compIds.filter(id => String(id).startsWith('layout:flag:')).length,
  gnnParents: new Set(attrs.filter(a => g(a, 'Key') === 'Global Net Name').map(a => g(a, 'ParentPrimitiveId')).filter(Boolean)).size,
  gnnAttrs: attrs.filter(a => g(a, 'Key') === 'Global Net Name').length,
  textYs: texts.map(t => g(t, 'Y')),
  textCount: texts.length,
  rect0: rects.filter(r => g(r, 'PrimitiveId') === 'rect0').map(r => ({ TopLeftY: g(r, 'TopLeftY'), Height: g(r, 'Height'), TopLeftX: g(r, 'TopLeftX'), Width: g(r, 'Width') })),
  rect1: rects.filter(r => g(r, 'PrimitiveId') === 'rect1').map(r => ({ TopLeftY: g(r, 'TopLeftY'), Height: g(r, 'Height') })),
  pageCount: ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).length,
  compCount: comps.length,
};
`, { timeoutMs: 180_000 })

const d = data
const distinct = (xs) => [...new Set(xs)].sort((a, b) => a - b)
const inWindow = (lo, hi) => d.textYs.filter((y) => typeof y === 'number' && y >= lo && y <= hi)
const out = {
  status: 'OK',
  main: d.main,
  pages: d.pageCount,
  comps: d.compCount,
  flags: { byPrefix: d.flagPrefix, byGlobalNetNameParent: d.gnnParents, globalNetNameAttrs: d.gnnAttrs },
  texts: {
    total: d.textCount,
    distinctY: distinct(d.textYs).length,
    distinctYValues: distinct(d.textYs),
    window0to160: inWindow(0, 160).length,
    window10to160: inWindow(10, 160).length,
    window40to160: inWindow(40, 160).length,
  },
  mapping: { rect0: d.rect0, rect1: d.rect1 },
}
console.log(JSON.stringify(out, null, 1))
