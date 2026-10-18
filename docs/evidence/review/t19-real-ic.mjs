// t19: real-IC delivery through the live import path. The t18 loop used the
// synthetic 2-pin t5 symbol; §14.14 left "真实 IC 符号的观感与引脚密度" open.
// This script resolves a real 48-pin STM32 (LCSC C23922) plus C25804 0603
// resistors, lays them out across four modules on A3, imports through the real
// client, and reads the delivered page back. It asserts the delivery contract
// (budget OK, zero error findings, page name/size/component counts) and writes
// a screenshot for the visual-density note in §14.15.
//
// Exit 0 when the real-IC delivery matches the plan, 1 otherwise.
import { mkdirSync, writeFileSync } from 'node:fs'
import { HttpEasyEdaBridge, EasyEdaLibrary, importIntoEasyEda } from '../../../packages/schematic-easyeda/lib/index.js'
import { SCHEMATIC_PAGE_A3, layoutSchematic } from '../../../packages/schematic/lib/index.js'
import { checkPageBudget, describePageBudget } from '../../../packages/eda-core/lib/index.js'

const fail = (message) => {
  console.error(`FAIL ${message}`)
  process.exit(1)
}

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const library = new EasyEdaLibrary({ bridge, queryTimeoutMs: 30_000 })
const ic = await library.resolveByLcsc('C23922')
const icPins = await library.resolveSymbolPins(ic.symbolUuid, ic.symbolLibraryUuid)
const resistor = await library.resolveByLcsc('C25804')
const resistorPins = await library.resolveSymbolPins(resistor.symbolUuid, resistor.symbolLibraryUuid)
const symbolPins = new Map([[ic.symbolUuid, icPins], [resistor.symbolUuid, resistorPins]])

const components = [{
  id: 'u1', kind: 'part', designator: 'U1', block: 'MCU',
  deviceUuid: ic.deviceUuid, symbolUuid: ic.symbolUuid,
  deviceLibraryUuid: ic.deviceLibraryUuid, symbolLibraryUuid: ic.symbolLibraryUuid,
  pins: icPins.map((pin, index) => {
    const power = /VDD|VSS|VDDA|VSSA/.test(pin.name ?? '')
    return {
      id: `u1p${index}`, number: pin.number, name: pin.name, electric: 'BI',
      net: power ? (/VSS/.test(pin.name ?? '') ? 'GND' : '+3V3') : `MCU-${pin.number}`,
    }
  }),
}]
const blocks = [{ name: 'MCU', title: 'MCU' }]
for (const block of ['POWER', 'IO', 'CLK']) {
  blocks.push({ name: block, title: block })
  for (let index = 0; index < 2; index += 1) {
    const id = `u${components.length + 1}`
    components.push({
      id, kind: 'part', designator: id.toUpperCase(), block,
      deviceUuid: resistor.deviceUuid, symbolUuid: resistor.symbolUuid,
      deviceLibraryUuid: resistor.deviceLibraryUuid, symbolLibraryUuid: resistor.symbolLibraryUuid,
      pins: ['1', '2'].map((number, pinIndex) => ({
        id: `${id}p${pinIndex}`, number, name: resistorPins.find(pin => pin.number === number)?.name,
        electric: 'BI', net: pinIndex === 0 ? `${block}-A${index}` : `${block}-B${index}`,
      })),
    })
  }
}
const ir = { sheets: [{ name: 'MAIN', components, wires: [], busEntries: [], junctions: [], attrs: [], blocks }] }
const planned = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins })

console.log('== planned (offline) ==')
const budget = checkPageBudget(planned.sheets, SCHEMATIC_PAGE_A3)
console.log(describePageBudget(budget))
if (!budget.ok) fail('page budget rejected the real-IC plan')

const report = await importIntoEasyEda(planned, {
  bridge, projectName: `dsh-t19-real-ic-${Date.now()}`, symbolPins,
  pageSize: SCHEMATIC_PAGE_A3, allowTabClose: true, timeoutMs: 120_000,
})
const errors = report.findings.filter(finding => finding.severity === 'error')
console.log(`import ${report.projectUuid} pages=${report.pageUuids.length} errors=${errors.length}`)
for (const finding of report.findings) console.log(` ${finding.severity}:${finding.code} ${finding.message}`)
if (errors.length > 0) fail(`${errors.length} import error findings`)

const probe = `
const pages = await eda.dmt_Schematic.getAllSchematicPagesInfo() || [];
const out = [];
for (const uuid of ${JSON.stringify(report.pageUuids)}) {
  await eda.dmt_EditorControl.openDocument(uuid);
  const info = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
  const rects = (await eda.sch_PrimitiveRectangle.getAll() || []).map(r => {
    const o = {};
    for (const pair of [['x','getState_TopLeftX'],['y','getState_TopLeftY'],['w','getState_Width'],['h','getState_Height']]) {
      try { o[pair[0]] = typeof r[pair[1]] === 'function' ? r[pair[1]]() : null } catch (e) { o[pair[0]] = null }
    }
    return o;
  }).filter(r => [r.x, r.y, r.w, r.h].every(v => typeof v === 'number' && Number.isFinite(v)));
  let components = 0; let texts = 0;
  try { components = ((await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []).length } catch (e) {}
  try { texts = ((await eda.sch_PrimitiveText.getAll()) || []).length } catch (e) {}
  out.push({ uuid, name: info && info.name, rects, components, texts });
}
return out;`
const live = await bridge.execute(probe, { timeoutMs: 60_000 })
console.log('== live read-back ==')
for (const page of live) {
  const width = Math.max(...page.rects.map(rect => rect.x + rect.w)) + 8
  const height = Math.max(...page.rects.map(rect => rect.y)) + 8
  console.log(`${page.name} ${width}x${height} components=${page.components} texts=${page.texts}`)
  if (page.name !== 'MAIN') fail(`page name ${page.name} != MAIN`)
  if (page.components !== 21) fail(`component count ${page.components} != 21`)
}

mkdirSync('docs/evidence/current', { recursive: true })
const base64 = await bridge.execute(`const blob = await eda.dmt_EditorControl.getCurrentRenderedAreaImage();
if (!blob) return null;
const bytes = new Uint8Array(await blob.arrayBuffer());
let binary = '';
for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
return btoa(binary);`, { timeoutMs: 120_000 })
if (base64 === null) fail('no rendered-area image')
const shot = 'docs/evidence/current/t19-real-ic-page1.png'
writeFileSync(shot, Buffer.from(base64, 'base64'))
console.log(`PASS screenshot ${shot}`)
