// t21: live evidence for the primitive-path Y convention. §14.14 left
// "primitive/verify live-blocked" open: buildIntoEasyEda cannot place a device
// on this imported project (CREATE_TIMEOUT), but the wire/netflag primitives do
// land. This script creates one netflag + one wire at IR y=200 through the real
// SCH_* API, captures getDocumentSource(), and asserts the persisted Y is -200
// (the API takes IR top-left Y-down and negates on persist), not `y - pageHeight`.
// It then drives diffNetlists with the SAME captured source twice: ySign=-1 must
// report no netlist finding, while the imported-page projection (default A4)
// must report the pin as dropped. That is the non-tautological pair §14.14
// lacked; no device placement is involved.
//
// Exit 0 when the live source matches the -y convention and the two projections
// disagree, 1 otherwise.
import { HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'
import { diffNetlists } from '../../../packages/eda-core/lib/index.js'

const fail = (message) => {
  console.error(`FAIL ${message}`)
  process.exit(1)
}

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const net = `T21PROBE_${Date.now()}`
const probe = `
const name = ${JSON.stringify(net)};
// Idempotent: clear any probe left by an interrupted earlier run; a stale flag
// at the same point would merge two net names in the captured source.
const removed = [];
for (const c of await eda.sch_PrimitiveComponent.getAll(undefined, false) || []) {
  try {
    const n = typeof c.getState_Net === 'function' ? c.getState_Net() : c.net;
    if (typeof n === 'string' && n.startsWith('T21PROBE')) { await eda.sch_PrimitiveComponent.delete(c); removed.push('flag:' + n); }
  } catch (e) {}
}
for (const w of await eda.sch_PrimitiveWire.getAll() || []) {
  try {
    const n = typeof w.getState_Net === 'function' ? w.getState_Net() : w.net;
    if (typeof n === 'string' && n.startsWith('T21PROBE')) { await eda.sch_PrimitiveWire.delete(w); removed.push('wire:' + n); }
  } catch (e) {}
}
let flag = null; let wire = null; let error = null;
try {
  flag = await eda.sch_PrimitiveComponent.createNetFlag('Power', name, 100, 200, 0, false);
  wire = await eda.sch_PrimitiveWire.create([0, 200, 100, 200], name);
} catch (e) { error = String(e && e.message ? e.message : e) }
const source = await eda.sys_FileManager.getDocumentSource();
const del = async (api, prim) => {
  if (!prim) return false;
  for (const method of ['delete', 'remove']) {
    try { if (typeof api[method] === 'function') { await api[method](prim); return true } } catch (e) {}
  }
  return false;
};
const deleted = { flag: await del(eda.sch_PrimitiveComponent, flag), wire: await del(eda.sch_PrimitiveWire, wire) };
return { source, error, deleted, removed, flagId: flag && flag.primitiveId, wireId: wire && wire.primitiveId };
`
const live = await bridge.execute(probe, { timeoutMs: 90_000 })
if (live.error) fail(`client rejected the probe: ${live.error}`)
if (live.removed.length > 0) console.log(`stale probes removed: ${live.removed.join(', ')}`)
if (!live.source.includes(net)) fail('captured source does not contain the probe net')
const lines = live.source.split('\n')
const record = (type, predicate) => lines.find(line => line.includes(`"type":"${type}"`) && predicate(line))
const innerOf = (line) => JSON.parse(line.slice(line.indexOf('||') + 2).replace(/\|\s*$/, ''))

const componentLine = record('COMPONENT', line => line.includes(`"id":"${live.flagId}"`))
if (componentLine === undefined) fail('no COMPONENT record for the placed netflag')
const componentY = innerOf(componentLine).y
if (live.wireId === undefined) fail('wire creation returned no primitive id')
const lineRecord = record('LINE', line => line.includes(`"lineGroup":"${live.wireId}"`))
if (lineRecord === undefined) fail('no LINE record for the placed wire')
const wireY = innerOf(lineRecord).startY

console.log(`live COMPONENT y=${componentY} (API placed at y=200)`)
console.log(`live LINE startY=${wireY} (API placed at y=200)`)
if (componentY !== -200) fail(`COMPONENT y ${componentY} != -200: primitive pages do not persist -y`)
if (wireY !== -200) fail(`LINE y ${wireY} != -200: primitive pages do not persist -y`)

// Same captured source, two projections. The part has no symbolUuid, so the
// pin-on-symbol check is skipped and only the persisted-Y projection is tested.
const sheet = {
  name: 'T21',
  blocks: [],
  components: [
    { id: 'f1', kind: 'netflag', netName: net, position: { x: 100, y: 200 }, pins: [] },
    {
      id: 'probe', kind: 'part', designator: 'U1', position: { x: 100, y: 200 },
      pins: [{ id: 'p1', endpoint: { x: 100, y: 200 }, net }],
    },
  ],
  wires: [{ id: 'w1', kind: 'wire', dots: [[0, 200, 100, 200]], net }],
  busEntries: [], junctions: [], attrs: [],
}
const netlist = findings => findings.filter(finding => finding.code.startsWith('SCHEMATIC_NETLIST_'))
const primitive = netlist(diffNetlists(sheet, live.source, 0, undefined, undefined, -1))
const imported = netlist(diffNetlists(sheet, live.source, 0))
console.log(`diffNetlists ySign=-1 : ${primitive.length} netlist finding(s)`)
console.log(`diffNetlists default  : ${imported.map(finding => finding.code).join(', ') || 'none'}`)
if (primitive.length !== 0) fail(`-y projection reported ${primitive.map(f => f.code).join(', ')}`)
if (!imported.some(finding => finding.code === 'SCHEMATIC_NETLIST_DROPPED')) {
  fail('default projection did not drop the pin; the pair is tautological')
}
console.log(`cleanup: netflag=${live.deleted.flag} wire=${live.deleted.wire}`)
if (!live.deleted.flag || !live.deleted.wire) fail('probe cleanup failed; clear T21PROBE* before rerunning')
const residue = await bridge.execute(
  `const s = await eda.sys_FileManager.getDocumentSource(); return (s.match(/T21PROBE/g) || []).length`,
  { timeoutMs: 30_000 },
)
console.log(`residue probes: ${residue}`)
if (residue !== 0) fail(`probe residue ${residue} remains in the page source`)
console.log('PASS primitive pages persist -y; only the imported projection needs pageHeight')
