// t4: independent re-check of t1's three numbers against the live t19 delivery.
//   #1 same-side minimum pin pitch of the real C23922 symbol (library path)
//   #2 text band height of the delivered labels / texts (official bbox API)
//   #3 ATTR fontSize A/B on a delivered net-flag label (rendered pixels)
// The only mutation is the #3 A/B on attr24's fontSize; it is restored and the
// script fails unless the restored render hash equals the baseline hash.
//
// Requires the EasyEDA window registered on the bridge with the t19 project.
// Exit 0 when pitch==10, the A/B changes the render, and restore is exact.
import { createHash } from 'node:crypto'
import { HttpEasyEdaBridge, EasyEdaLibrary } from '../../../packages/schematic-easyeda/lib/index.js'

const T19_PROJECT = '20a4c227c6264883a8d65bc171cad8ee'
const T19_MAIN = '9a949780a3b041a983918fc5e76c9e00'
const ATTR_ID = 'attr24' // first delivered net-flag "Global Net Name" attribute
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const library = new EasyEdaLibrary({ bridge, queryTimeoutMs: 30_000 })
const ic = await library.resolveByLcsc('C23922')
const pins = await library.resolveSymbolPins(ic.symbolUuid, ic.symbolLibraryUuid)
const byX = new Map()
for (const pin of pins) {
  const key = String(pin.x)
  if (!byX.has(key)) byX.set(key, [])
  byX.get(key).push(pin.y)
}
let pitch = Infinity
for (const ys of byX.values()) {
  ys.sort((a, b) => a - b)
  for (let i = 1; i < ys.length; i += 1) pitch = Math.min(pitch, Math.abs(ys[i] - ys[i - 1]))
}

const shot = async (label) => {
  const b64 = await bridge.execute(`
const blob = await eda.dmt_EditorControl.getCurrentRenderedAreaImage();
if (!blob) return null;
const bytes = new Uint8Array(await blob.arrayBuffer());
let binary = '';
for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
return btoa(binary);`, { timeoutMs: 120_000 })
  if (b64 === null) return { label, hash: null, bytes: 0 }
  const buffer = Buffer.from(b64, 'base64')
  return { label, hash: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length }
}

await bridge.execute(`
await eda.dmt_Project.openProject('${T19_PROJECT}');
await new Promise(r => setTimeout(r, 3000));
await eda.dmt_EditorControl.openDocument('${T19_MAIN}');
await new Promise(r => setTimeout(r, 2000));
return true;`, { timeoutMs: 90_000 })

const bands = await bridge.execute(`
try {
  const attrs = Object.values(await eda.sch_PrimitiveAttribute.getAll() || {});
  const bbox = async (id) => { try { const b = await eda.sch_Primitive.getPrimitivesBBox([id]); return b ? { h: +(b.maxY - b.minY).toFixed(3), w: +(b.maxX - b.minX).toFixed(3) } : null } catch (e) { return { err: String(e && e.message || e) } } };
  const wanted = ['Global Net Name', 'Pin Name', 'Pin Number', 'Designator'];
  const found = {};
  for (const a of attrs) { let k = null; try { k = a.getState_Key() } catch (e) { continue } if (!wanted.includes(k) || found[k]) continue; found[k] = { value: a.getState_Value(), fontSize: a.getState_FontSize(), id: a.getState_PrimitiveId() } }
  const rows = [];
  for (const key of wanted) { if (!found[key]) { rows.push({ key, missing: true }); continue } rows.push({ key, value: found[key].value, fontSize: found[key].fontSize, ...(await bbox(found[key].id)) }) }
  const texts = await eda.sch_PrimitiveText.getAll() || [];
  const textRows = [];
  for (const t of texts.slice(0, 3)) textRows.push({ content: t.getState_Content(), fontSize: t.getState_FontSize(), ...(await bbox(t.getState_PrimitiveId())) });
  return { rows, textRows };
} catch (e) { return { error: String(e && e.message || e) } }`, { timeoutMs: 90_000 })

const setFont = async (value) => bridge.execute(`
const a = await eda.sch_PrimitiveAttribute.get('${ATTR_ID}');
await eda.sch_PrimitiveAttribute.modify(a, { fontSize: ${value} });
await new Promise(r => setTimeout(r, 2500));
const b = await eda.sch_Primitive.getPrimitivesBBox(['${ATTR_ID}']);
return { fontSize: (await eda.sch_PrimitiveAttribute.get('${ATTR_ID}')).getState_FontSize(), h: b ? +(b.maxY - b.minY).toFixed(3) : null };`, { timeoutMs: 60_000 })

await sleep(3000)
const baseline = await shot('baseline')
await sleep(1500)
const baseline2 = await shot('baseline2')
const afterSet = await setFont(0.3) // API scale x100 -> 30 units
const changed = await shot('changed')
await sleep(1500)
const changed2 = await shot('changed2')
const afterRestore = await setFont(null)
const restored = await shot('restored')
await sleep(1500)
const restored2 = await shot('restored2')

const report = {
  pinPitch: pitch,
  pinCount: pins.length,
  bands,
  ab: {
    afterSet,
    afterRestore,
    baseline,
    baseline2,
    changed,
    changed2,
    restored,
    restored2,
    controlStable: baseline.hash === baseline2.hash,
    renderChanged: baseline.hash !== changed.hash && changed.hash === changed2.hash,
    restoreExact: baseline.hash === restored.hash && baseline.hash === restored2.hash,
  },
}
console.log(JSON.stringify(report, null, 1))
process.exitCode = report.pinPitch === 10 && report.ab.controlStable && report.ab.renderChanged && report.ab.restoreExact ? 0 : 1
