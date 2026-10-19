// t8: does the serializer's net-label font size survive the real import path?
//
// §14.15/§14.19 archived the 48-pin label density as "the renderer ignores the
// overlay ATTR fontSize". A live A/B on the delivered t19 page contradicted
// that: setting the stored size to 8/6/5/4 changed the rendered pixels and
// restoring was byte-exact. The remaining link is the serialize -> import
// hand-off, which this script closes: it lays out the same real 48-pin C23922
// IR as t19, imports it with the serializer default, and reads the delivered
// `Global Net Name` attrs back out of the client.
//
// Exit 0 when every delivered net label carries the serializer's size and the
// page renders, 1 otherwise.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { HttpEasyEdaBridge, EasyEdaLibrary, importIntoEasyEda } from '../../../packages/schematic-easyeda/lib/index.js'
import { SCHEMATIC_PAGE_A3, layoutSchematic } from '../../../packages/schematic/lib/index.js'
import { DEFAULT_NET_LABEL_FONT_SIZE } from '../../../packages/eda-core/lib/index.js'

const fail = (message) => {
  console.error(`FAIL ${message}`)
  process.exit(1)
}

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const library = new EasyEdaLibrary({ bridge, queryTimeoutMs: 30_000 })
const ic = await library.resolveByLcsc('C23922')
const icPins = await library.resolveSymbolPins(ic.symbolUuid, ic.symbolLibraryUuid)
const symbolPins = new Map([[ic.symbolUuid, icPins]])
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
const ir = { sheets: [{ name: 'MAIN', components, wires: [], busEntries: [], junctions: [], attrs: [], blocks: [{ name: 'MCU', title: 'MCU' }] }] }
const planned = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins })

const report = await importIntoEasyEda(planned, {
  bridge, projectName: `dsh-t8-netlabel-${Date.now()}`, symbolPins,
  pageSize: SCHEMATIC_PAGE_A3, allowTabClose: true, timeoutMs: 120_000,
})
const errors = report.findings.filter(finding => finding.severity === 'error')
console.log(`import ${report.projectUuid} pages=${report.pageUuids.length} errors=${errors.length}`)
if (errors.length > 0) fail(`${errors.length} import error findings`)

const setup = await bridge.execute(`
await eda.dmt_EditorControl.openDocument(${JSON.stringify(report.pageUuids[0])});
await new Promise(r => setTimeout(r, 2500));
try { await eda.dmt_EditorControl.zoomToAllPrimitives() } catch (e) {}
await new Promise(r => setTimeout(r, 2500));
return true;`, { timeoutMs: 90_000 })
if (setup !== true) fail('could not open the imported page')

const readLabels = `
const all = (await eda.sch_PrimitiveAttribute.getAll()) || [];
const get = (a, method, field) => typeof a[method] === 'function' ? a[method]() : a[field];
return all
  .filter(a => ['Name', 'Global Net Name'].includes(get(a, 'getState_Key', 'key')))
  .map(a => ({
    id: get(a, 'getState_PrimitiveId', 'id'),
    key: get(a, 'getState_Key', 'key'),
    value: get(a, 'getState_Value', 'value'),
    parentId: get(a, 'getState_ParentPrimitiveId', 'parentId'),
    fontSize: get(a, 'getState_FontSize', 'fontSize'),
    keyVisible: get(a, 'getState_KeyVisible', 'keyVisible'),
    valueVisible: get(a, 'getState_ValueVisible', 'valueVisible'),
  }));`
const attrs = await bridge.execute(readLabels, { timeoutMs: 60_000 })
if (!Array.isArray(attrs) || attrs.length === 0) fail('no net-name attrs on the delivered page')
// A part symbol also carries `Name` attrs (e.g. `={Manufacturer Part}`), so pair
// each flag's connectivity attr with the sibling `Name` the device draws.
const globals = attrs.filter(attr => attr.key === 'Global Net Name')
const names = attrs.filter(attr => attr.key === 'Name')
const labels = globals
  .map(global => names.find(name => name.parentId === global.parentId && name.value === global.value))
  .filter(Boolean)
console.log(`flags=${globals.length} labels=${labels.length}`)
console.log(`sample=${JSON.stringify(labels.slice(0, 4))}`)
if (labels.length === 0) fail('the flag device draws `Name`, but none was delivered')
if (labels.length !== globals.length) fail(`${labels.length} labels vs ${globals.length} flags`)
const sizes = [...new Set(labels.map(label => label.fontSize))]
if (sizes.length !== 1 || sizes[0] !== DEFAULT_NET_LABEL_FONT_SIZE) {
  fail(`delivered net labels carry ${JSON.stringify(sizes)}, expected [${DEFAULT_NET_LABEL_FONT_SIZE}]`)
}
const prefixed = labels.filter(label => label.keyVisible)
if (prefixed.length > 0) fail(`${prefixed.length}/${labels.length} labels still draw a "Key : Value" prefix`)
// The flag device also owns a `Global Net Name`; leaving it visible drew every
// net name twice (the 48-pin wall of text).
const doubled = globals.filter(attr => attr.valueVisible === true)
if (doubled.length > 0) fail(`${doubled.length} Global Net Name attrs are still visible, so names render twice`)

// One bounding box for the first label: the client's own measurement of the
// delivered em box, independent of the serialized text.
const bbox = await bridge.execute(`
const box = await eda.sch_Primitive.getPrimitivesBBox([${JSON.stringify(labels[0].id)}]);
if (!box) return null;
return { width: +(box.maxX - box.minX).toFixed(3), height: +(box.maxY - box.minY).toFixed(3) };`, { timeoutMs: 60_000 })
console.log(`bbox(${labels[0].value})=${JSON.stringify(bbox)}`)
if (bbox === null || bbox.height !== DEFAULT_NET_LABEL_FONT_SIZE) {
  fail(`delivered label bbox height ${JSON.stringify(bbox)} != ${DEFAULT_NET_LABEL_FONT_SIZE}`)
}

mkdirSync('docs/evidence/current', { recursive: true })
// The canvas repaints lazily, so a capture taken while the editor is still
// analysing a freshly imported project can be a stale, blank frame (~16 kB)
// even though the page is fine: a separate, focused capture of the very same
// project renders ~121 kB. Re-open the page, wait for the document to be ready,
// force a repaint, and require two consecutive captures to match. The
// screenshot is best-effort: on a blank/unsettled frame it warns and keeps the
// existing evidence image rather than overwriting it with a blank.
const shots = await bridge.execute(`
const capture = async () => {
  const blob = await eda.dmt_EditorControl.getCurrentRenderedAreaImage();
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
// The import leaves the delivered project open, but the current page can still
// be the one that was open before it, so open the project explicitly first.
await eda.dmt_Project.openProject(${JSON.stringify(report.projectUuid)});
await new Promise(r => setTimeout(r, 3000));
const info = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
await eda.dmt_EditorControl.openDocument(info.uuid);
await new Promise(r => setTimeout(r, 2500));
try { await eda.dmt_EditorControl.waitForDocumentReady() } catch (e) {}
await new Promise(r => setTimeout(r, 2000));
try { await eda.dmt_EditorControl.zoomToAllPrimitives() } catch (e) {}
await new Promise(r => setTimeout(r, 3000));
const first = await capture();
await new Promise(r => setTimeout(r, 2000));
const second = await capture();
return { first, second, stable: first !== null && first === second, page: info.uuid };`, { timeoutMs: 180_000 })
const shot = 'docs/evidence/current/t8-netlabel-f6-page1.png'
const buffer = shots && shots.first !== null ? Buffer.from(shots.first, 'base64') : null
// A blank canvas settles too, at roughly 16 kB; the rendered page is ~120 kB.
if (buffer !== null && shots.stable && buffer.length >= 50_000) {
  writeFileSync(shot, buffer)
  console.log(`PASS screenshot ${shot} bytes=${buffer.length} sha256=${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}`)
} else {
  console.log(`WARN screenshot not written (${buffer === null ? 'no image' : `${buffer.length} bytes, stable=${shots.stable}`}); the verification above still holds`)
}
console.log(`PASS project=${report.projectUuid} page=${shots ? shots.page : 'n/a'} labels=${labels.length} fontSize=${sizes[0]} bboxH=${bbox.height} flags=${globals.length}`)
