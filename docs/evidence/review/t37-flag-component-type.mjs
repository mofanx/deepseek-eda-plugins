// t37: read-only. Which flag component is not a netflag?
//   t1 says ComponentType==='netflag' gives 13 because
//   layout:flag:_3V3:bus:240 is stored as 'part'. Verify that, plus the title
//   block's text rows (the five 26-unit rows and whatever sits at y=18).
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
const d = await bridge.execute(`
const g = (o, k) => { try { const f = o['getState_' + k]; return typeof f === 'function' ? f.call(o) : o[k] } catch (e) { return null } };
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const texts = (await eda.sch_PrimitiveText.getAll(undefined, false)) || [];
const rects = (await eda.sch_PrimitiveRectangle.getAll(undefined, false)) || [];
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const pageCount = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).length;
return {
  comps: comps.map(c => ({ id: g(c, 'PrimitiveId'), type: g(c, 'ComponentType'), name: g(c, 'Name') })),
  rows: texts.filter(t => typeof g(t, 'Y') === 'number' && g(t, 'Y') <= 160)
    .map(t => ({ y: g(t, 'Y'), x: g(t, 'X'), c: g(t, 'Content') }))
    .sort((a, b) => b.y - a.y),
  rect2: rects.filter(r => g(r, 'PrimitiveId') === 'rect2').map(r => ({ x: g(r, 'TopLeftX'), y: g(r, 'TopLeftY'), w: g(r, 'Width'), h: g(r, 'Height') })),
  pageCount, main: cur && cur.uuid, compCount: comps.length,
};
`, { timeoutMs: 180_000 })

const flags = d.comps.filter((c) => String(c.id).startsWith('layout:flag:'))
const byType = {}
for (const f of flags) byType[String(f.type)] = (byType[String(f.type)] ?? 0) + 1
const others = flags.filter((f) => f.type !== 'netflag')
const out = {
  status: 'OK',
  main: d.main,
  pages: d.pageCount,
  comps: d.compCount,
  flags: { total: flags.length, byComponentType: byType, notNetflag: others },
  titleBlock: {
    rect2: d.rect2,
    rowsUpTo160: d.rows.length,
    distinctY: [...new Set(d.rows.map((r) => r.y))].sort((a, b) => b - a),
    rows: d.rows.filter((r) => [18, 38, 64, 90, 116, 142].includes(r.y)).slice(0, 24),
  },
}
console.log(JSON.stringify(out, null, 1))
