// t25: closed-loop check of the primitive build path's net-label font size.
// Delivers one netflag per case through buildIntoEasyEda (the primitive path,
// not the serialize/import path), reads the delivered `Name` attribute's
// STORED fontSize back from the client, and deletes the scratch page again.
// Units: the option and the stored value are 0.01-inch format units; the client
// modify() API takes inches, which is why build.ts divides by 100. A stored 5
// therefore proves the /100 is applied -- without it the client would keep 500.
// Expects: default -> 6, explicit 5 -> 5, null -> untouched (stays null).
// Exit 0 when all three cases match and every scratch page is deleted, 1 otherwise.
import { HttpEasyEdaBridge, buildIntoEasyEda } from '../../../packages/schematic-easyeda/lib/index.js'

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const ir = (net) => ({
  sheets: [{
    name: 'MAIN',
    components: [{ id: 'f1', kind: 'netflag', netName: net, position: { x: 100, y: 100 }, pins: [] }],
    wires: [], busEntries: [], junctions: [], attrs: [],
  }],
})

const labelSizes = async (pageUuid) => bridge.execute(`
await eda.dmt_EditorControl.openDocument(${JSON.stringify(pageUuid)});
const get = (a, m, f) => { try { return typeof a[m] === 'function' ? a[m]() : a[f] } catch (e) { return null } };
const attrs = (await eda.sch_PrimitiveAttribute.getAll()) || [];
return attrs
  .filter(a => get(a, 'getState_Key', 'key') === 'Name' && get(a, 'getState_ValueVisible', 'valueVisible') === true)
  .map(a => ({ value: get(a, 'getState_Value', 'value'), size: get(a, 'getState_FontSize', 'fontSize') }));`,
{ timeoutMs: 60_000 })

const created = []
const run = async (label, options, net) => {
  const report = await buildIntoEasyEda(ir(net), { bridge, ...options, retries: 0 })
  const errors = report.findings.filter(f => f.severity === 'error')
  created.push(...report.pageUuids)
  const labels = await labelSizes(report.pageUuids[0])
  console.log(`${label}: created=${report.created} pages=${report.pageUuids.length} errors=${errors.length} labels=${JSON.stringify(labels)}`)
  for (const f of report.findings) console.log(`   ${f.severity}:${f.code} ${f.message}`)
  return labels
}

let failed = false
const check = (label, labels, expected) => {
  const sizes = [...new Set(labels.map(l => l.size))]
  if (sizes.length !== 1 || sizes[0] !== expected) {
    console.error(`FAIL ${label}: stored sizes ${JSON.stringify(sizes)} != [${expected}]`)
    failed = true
  } else {
    console.log(`PASS ${label}: stored fontSize=${sizes[0]} on ${labels.length} delivered Name attr(s)`)
  }
}

check('default (no option)', await run('default', {}, 'T8A'), 6)
check('explicit 5', await run('explicit', { netLabelFontSize: 5 }, 'T8B'), 5)
// null means "do not touch it", so the stored value stays the client's null.
check('null (client default)', await run('null', { netLabelFontSize: null }, 'T8C'), null)

for (const uuid of created) {
  try {
    await bridge.execute(`return await eda.dmt_Schematic.deleteSchematicPage(${JSON.stringify(uuid)})`, { timeoutMs: 15_000 })
    console.log(`cleaned up page ${uuid}`)
  } catch (error) {
    console.error(`WARN could not delete page ${uuid}: ${error instanceof Error ? error.message : String(error)}`)
    failed = true
  }
}
console.log(failed ? 'FAIL' : 'PASS')
process.exit(failed ? 1 : 0)
