// t22: live evidence for the primitive CREATE_TIMEOUT fast-fail. §14.17 closed
// the read-back projection, but device placement on this imported project still
// hangs: each part chunk costs the full 15s race. This script lays out six real
// C25804 parts, runs engine.verify through the real client, and asserts that the
// second consecutive CREATE_TIMEOUT aborts the remaining placement instead of
// burning 6 x 15s. It also records the wall clock and cleans up the page it
// created.
//
// Preconditions: the active project is the imported t18 project where
// sch_PrimitiveComponent.create times out. Exit 0 when the abort path fires
// within budget; 1 otherwise. When device creation actually works, the script
// reports SKIP (nothing to exercise) instead of failing.
import { EasyEdaLibrary, EasyEdaSchematicEngine, HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'
import { SCHEMATIC_PAGE_A4, layoutSchematic } from '../../../packages/schematic/lib/index.js'

const fail = (message) => {
  console.error(`FAIL ${message}`)
  process.exit(1)
}

const rawBridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const library = new EasyEdaLibrary({ bridge: rawBridge, queryTimeoutMs: 30_000 })
const resistor = await library.resolveByLcsc('C25804')
const pins = await library.resolveSymbolPins(resistor.symbolUuid, resistor.symbolLibraryUuid)
const symbolPins = new Map([[resistor.symbolUuid, pins]])

let componentChunks = 0
const bridge = {
  async execute(code, options) {
    if (code.includes('sch_PrimitiveComponent.create(device')) componentChunks += 1
    return rawBridge.execute(code, options)
  },
}

const components = []
for (let index = 0; index < 6; index += 1) {
  components.push({
    id: `u${index + 1}`, kind: 'part', designator: `R${index + 1}`, block: 'MCU',
    position: { x: 100 + index * 80, y: 200 }, rotation: 0,
    deviceUuid: resistor.deviceUuid, symbolUuid: resistor.symbolUuid,
    deviceLibraryUuid: resistor.deviceLibraryUuid, symbolLibraryUuid: resistor.symbolLibraryUuid,
    pins: ['1', '2'].map((number, pinIndex) => ({
      id: `u${index + 1}p${pinIndex}`, number, name: pins.find(pin => pin.number === number)?.name,
      electric: 'BI', net: pinIndex === 0 ? `SIG${index}` : 'GND',
    })),
  })
}
const ir = { sheets: [{ name: 'MAIN', components, wires: [], busEntries: [], junctions: [], attrs: [], blocks: [{ name: 'MCU', title: 'MCU' }] }] }
const laid = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A4, symbolPins })

const before = await rawBridge.execute(`return ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid)`, { timeoutMs: 15_000 })
// Keep a page active so prepare reuses its schematic instead of calling the
// (stubbed on this client) createSchematic.
const activePage = await rawBridge.execute(`const pages = await eda.dmt_Schematic.getAllSchematicPagesInfo() || [];
if (pages.length === 0) return null;
await eda.dmt_EditorControl.openDocument(pages[0].uuid);
return pages[0].uuid;`, { timeoutMs: 20_000 })
if (activePage === null) fail('no schematic page is open to build into')

const engine = new EasyEdaSchematicEngine({
  clientId: 't22', bridgeHost: '127.0.0.1', bridgeTimeoutMs: 60_000,
  bridgeQueryTimeoutMs: 60_000, bridgeTimeoutStreakLimit: 3, bridgeCircuitCooldownMs: 100, advisoryDrc: false,
})
const started = Date.now()
const findings = await engine.verify(laid, { bridge, pageSize: SCHEMATIC_PAGE_A4, symbolPins, createDocument: true, timeoutMs: 90_000 })
const elapsedSeconds = (Date.now() - started) / 1000
const count = code => findings.filter(finding => finding.code === code).length
const timeouts = count('SCHEMATIC_BUILD_CREATE_TIMEOUT')
const aborted = count('SCHEMATIC_BUILD_CREATE_ABORTED')

console.log(`elapsed ${elapsedSeconds.toFixed(1)}s componentChunks=${componentChunks} timeouts=${timeouts} aborted=${aborted}`)

try {
  const after = await rawBridge.execute(`return ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid)`, { timeoutMs: 15_000 })
  const created = (after ?? []).filter(uuid => !(before ?? []).includes(uuid))
  for (const uuid of created) await rawBridge.execute(`return await eda.dmt_Schematic.deleteSchematicPage(${JSON.stringify(uuid)})`, { timeoutMs: 15_000 })
  console.log(`cleanup pages: ${created.length}`)
} catch (error) {
  console.error('cleanup', error instanceof Error ? error.message : String(error))
}

if (timeouts === 0) {
  console.log('SKIP device creation succeeded on this project; the CREATE_TIMEOUT abort was not exercised')
  process.exit(0)
}
if (componentChunks !== 2) fail(`expected exactly 2 component chunks before the abort, saw ${componentChunks}`)
if (timeouts !== 2) fail(`expected 2 CREATE_TIMEOUT findings, saw ${timeouts}`)
if (aborted !== 1) fail(`expected 1 SCHEMATIC_BUILD_CREATE_ABORTED finding, saw ${aborted}`)
if (elapsedSeconds > 60) fail(`abort took ${elapsedSeconds.toFixed(1)}s, expected under 60s`)
console.log('PASS two consecutive CREATE_TIMEOUTs abort the remaining placement')
