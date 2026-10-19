// t6: independent re-run of the t1-vs-t4 fontSize A/B, with a fresh path:
//   control double-capture, three ascending font sizes (monotonic ink check),
//   and a restore that is asserted byte-exact against the baseline PNG hash.
// Restore runs in a finally block, so a mid-run failure cannot leave the
// delivered t19 page mutated. Read-only otherwise (open project/page only).
//
// Exit 0 only when: control stable, every changed capture differs from baseline
// and is stable, PNG byte size grows with fontSize, and restore is byte-exact.
import { createHash } from 'node:crypto'
import { HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'

const T19_PROJECT = '20a4c227c6264883a8d65bc171cad8ee'
const T19_MAIN = '9a949780a3b041a983918fc5e76c9e00'
const ATTR_ID = 'attr24' // delivered net-flag "Global Net Name" attribute
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })

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

const setFont = async (value) => bridge.execute(`
const a = await eda.sch_PrimitiveAttribute.get('${ATTR_ID}');
await eda.sch_PrimitiveAttribute.modify(a, { fontSize: ${value} });
await new Promise(r => setTimeout(r, 2500));
const b = await eda.sch_Primitive.getPrimitivesBBox(['${ATTR_ID}']);
return { fontSize: (await eda.sch_PrimitiveAttribute.get('${ATTR_ID}')).getState_FontSize(), h: b ? +(b.maxY - b.minY).toFixed(3) : null };`, { timeoutMs: 60_000 })

const api = await bridge.execute(`
try {
  await eda.dmt_Project.openProject('${T19_PROJECT}');
  await new Promise(r => setTimeout(r, 3000));
  await eda.dmt_EditorControl.openDocument('${T19_MAIN}');
  await new Promise(r => setTimeout(r, 2000));
  const names = (obj) => { const set = new Set(); let o = obj; while (o && o !== Object.prototype) { for (const n of Object.getOwnPropertyNames(o)) set.add(n); o = Object.getPrototypeOf(o) } return [...set].filter(n => typeof obj[n] === 'function').sort() };
  return { dmtSchematic: names(eda.dmt_Schematic) };
} catch (e) { return { error: String(e && e.message || e) } }`, { timeoutMs: 90_000 })

let control = []
let baseline = null
let series = []
let restored = []
try {
  await sleep(3000)
  control = [await shot('c1'), await shot('c2')]
  await sleep(1200)
  baseline = control[0]
  for (const [label, value] of [['f15', 0.15], ['f30', 0.3], ['f60', 0.6]]) {
    const set = await setFont(value)
    const s1 = await shot(`${label}a`)
    await sleep(1200)
    const s2 = await shot(`${label}b`)
    series.push({ label, request: value, set, s1, s2, stable: s1.hash === s2.hash, changed: s1.hash !== baseline.hash })
  }
} finally {
  const restore = await setFont(null)
  await sleep(1200)
  restored = [await shot('r1'), await shot('r2'), { restore }]
}

const sizes = series.map((entry) => entry.s1.bytes)
const report = {
  api,
  controlStable: control[0].hash === control[1].hash,
  baseline,
  series,
  restored,
  monotonicBytes: sizes.every((value, index) => index === 0 || value > sizes[index - 1]),
  restoreExact: restored[0].hash === baseline.hash && restored[1].hash === baseline.hash,
}
console.log(JSON.stringify(report, null, 1))
process.exitCode = report.controlStable && report.monotonicBytes && report.restoreExact && series.every((entry) => entry.stable && entry.changed) ? 0 : 1
