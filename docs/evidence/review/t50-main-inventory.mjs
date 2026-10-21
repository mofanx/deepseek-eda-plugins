// t50: read-only inventory of MAIN. Writes nothing to the schematic.
//
// Purpose (r2t1): after two t27 runs and one t28 run wrote test netflags into MAIN,
// nobody could say what MAIN actually contains. This script answers, from one
// bridge call, three questions that must not be answered from memory:
//   * how many primitives, grouped by type;
//   * every netflag id, with its coordinates and net name;
//   * whether the 8 parts are still the original ones.
//
// It calls only *getAll / getCurrentSchematicPageInfo*. No create, no modify,
// no delete, no save. Safe to run at any time, including while a member is editing.

import { pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const libEntry = resolve(repo, 'packages/eda-core/lib/index.js')

const { HttpEasyEdaBridge } = await import(pathToFileURL(libEntry).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 30_000 })

const inventory = await bridge.execute(`
const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const all = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const wires = (await eda.sch_PrimitiveWire.getAll()) || [];
const rows = all.map((c) => {
  const pick = (fn, ...keys) => {
    try { if (typeof c[fn] === 'function') return c[fn]() } catch (e) {}
    for (const k of keys) { if (c[k] !== undefined) return c[k] }
    return undefined
  };
  return {
    id: String(pick('getState_PrimitiveId', 'primitiveId', 'id') ?? ''),
    type: String(pick('getState_ComponentType', 'componentType', 'ComponentType') ?? ''),
    primitiveType: String(pick('getState_PrimitiveType', 'primitiveType', 'PrimitiveType') ?? ''),
    x: Math.round(Number(pick('getState_X', 'x')) || 0),
    y: Math.round(Number(pick('getState_Y', 'y')) || 0),
    net: String(pick('getState_Net', 'net', 'Net') ?? ''),
    name: String(pick('getState_Name', 'name', 'Name', 'designator') ?? ''),
  };
});
return { active: page && page.uuid, pageName: page && page.name, rows, wires: wires.length };
`, { timeoutMs: 120_000 })

const rows = inventory.rows ?? []
const byType = {}
for (const r of rows) {
  const key = `${r.type || 'unknown'}/${r.primitiveType || '-'}`
  byType[key] = (byType[key] ?? 0) + 1
}
const netflags = rows.filter((r) => /netflag/i.test(r.type) || /netflag/i.test(r.primitiveType))
const others = rows.filter((r) => !netflags.includes(r))
const isHexId = (id) => /^[0-9a-f]{16}$/.test(id)
const isLayoutId = (id) => /^layout:/.test(id)

netflags.sort((a, b) => a.y - b.y || a.x - b.x)
others.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.x - b.x)

const report = {
  at: new Date().toISOString(),
  active: inventory.active ?? null,
  pageName: inventory.pageName ?? null,
  total: rows.length,
  wires: inventory.wires ?? null,
  byType,
  netflags: {
    count: netflags.length,
    hexIds: netflags.filter((r) => isHexId(r.id)).length,
    layoutIds: netflags.filter((r) => isLayoutId(r.id)).length,
    otherIds: netflags.filter((r) => !isHexId(r.id) && !isLayoutId(r.id)).length,
    items: netflags.map((r) => ({ id: r.id, x: r.x, y: r.y, net: r.net, kind: isHexId(r.id) ? 'hex' : isLayoutId(r.id) ? 'layout' : 'other' })),
  },
  others: others.map((r) => ({ id: r.id, type: r.type, primitiveType: r.primitiveType, name: r.name, x: r.x, y: r.y })),
  otherCount: others.length,
  wrote: 0,
}

const outPath = process.argv[2] ?? resolve(repo, 'docs/evidence/current/main-inventory.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(report, null, 1))
console.log(JSON.stringify({
  active: report.active,
  pageName: report.pageName,
  total: report.total,
  wires: report.wires,
  byType: report.byType,
  netflags: { count: report.netflags.count, hex: report.netflags.hexIds, layout: report.netflags.layoutIds, other: report.netflags.otherIds },
  others: report.otherCount,
  wrote: report.wrote,
  out: outPath,
}))
