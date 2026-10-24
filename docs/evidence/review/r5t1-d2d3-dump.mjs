#!/usr/bin/env node
// r5t1 (D2/D3 rehearsal) - step 1 of 3: READ-ONLY geometry dump.
//
// What this proves: the reported numbers come from a script a third party can run
// and grep, not from a claim in prose.
//
// Run from the repo root:
//   node docs/evidence/review/r5t1-d2d3-dump.mjs
// It writes the geometry to <tmp>/r5t1-geom.json, which step 3 reads.
//
// Scope note: this file only calls the read APIs (getCurrentSchematicPageInfo /
// getAllSchematicPagesInfo / the three getAll calls). It cannot mutate the document.
// To confirm that mechanically rather than by promise, run:
//   pwsh -File docs/evidence/review/r5t1-d2d3-verify-readonly.ps1
// which must print PASS (0 mutating document calls across the three step files).
import { pathToFileURL, fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const geomPath = path.join(os.tmpdir(), 'r5t1-geom.json')

const { HttpEasyEdaBridge } = await import(pathToFileURL(path.join(repo, 'packages/eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20000 })

const r = await bridge.execute(`
const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const comps = (await eda.sch_PrimitiveComponent.getAll()) || [];
const wires = (await eda.sch_PrimitiveWire.getAll()) || [];
const texts = (await eda.sch_PrimitiveText.getAll()) || [];
const attrs = (await eda.sch_PrimitiveAttribute.getAll()) || [];
const pages = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [];
return {
  page: { uuid: page && page.uuid, name: page && page.name },
  counts: { comps: comps.length, wires: wires.length, texts: texts.length, attrs: attrs.length, pages: pages.length },
  wires: wires.map(x => ({ id: x.primitiveId, net: x.net, line: x.line })),
  attrs: attrs.map(x => ({ id: x.primitiveId, key: x.key, value: x.value, x: x.x, y: x.y, fs: x.fontSize, parent: x.parentPrimitiveId, vis: x.valueVisible })),
  texts: texts.map(x => ({ id: x.primitiveId, x: x.x, y: x.y, content: x.content, fs: x.fontSize })),
};`, { timeoutMs: 180000 })

const out = r?.result ?? r
writeFileSync(geomPath, JSON.stringify(out))
console.log('page=' + JSON.stringify(out.page) + ' counts=' + JSON.stringify(out.counts))
console.log('geometry written to ' + geomPath)

// The two objects this rehearsal is about, printed so the numbers are checkable at a glance.
const w34 = out.wires.filter(x => String(x.id).includes('MCU_34'))
const w26 = out.wires.filter(x => String(x.id).includes('MCU_26'))
console.log('MCU_34 wire=' + JSON.stringify(w34))
console.log('MCU_26 wire=' + JSON.stringify(w26))
console.log('attr111=' + JSON.stringify(out.attrs.filter(x => x.id === 'attr111')))
console.log('u1-e44=' + JSON.stringify(out.attrs.filter(x => String(x.parent) === 'u1-e44')))
console.log('u1-e108=' + JSON.stringify(out.attrs.filter(x => String(x.parent) === 'u1-e108')))
console.log('flag MCU_26:0 Name=' + JSON.stringify(out.attrs.filter(x => String(x.parent) === 'layout:flag:MCU_26:0' && x.key === 'Name')))
console.log('flag MCU_34:0 Name=' + JSON.stringify(out.attrs.filter(x => String(x.parent) === 'layout:flag:MCU_34:0' && x.key === 'Name')))
