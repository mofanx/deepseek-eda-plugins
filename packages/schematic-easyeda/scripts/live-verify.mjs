#!/usr/bin/env node
/**
 * Standalone live verification for the EasyEDA delivery path — no test
 * runner, no workspace services. Discovers the run-api-gateway bridge,
 * resolves a real LCSC part through the running client's library, imports a
 * minimal one-component project, and fails on any error-severity read-back
 * finding.
 *
 * Prerequisites: EasyEDA Web open with the bridge extension enabled, and a
 * bridge server running (the package ships `dsh-eda-bridge`; any
 * `easyeda-bridge` handshake on 49620-49629 works).
 *
 * Usage:
 *   node live-verify.mjs [--lcsc C25804] [--name <project>] [--check-defect]
 *   DSH_EASYEDA_IMPORT=<specifier>  override the package import specifier —
 *   e.g. point at `../src/index.ts` under tsx for a source-tree run; defaults
 *   to the installed `@deepseek-ai/dsh-schematic-easyeda`.
 *
 * Exit code: 0 on success, 1 on bridge/library failure or error findings,
 * 2 on bad arguments.
 */

const args = process.argv.slice(2)
const take = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const has = (flag) => args.includes(flag)

const lcsc = take('--lcsc', 'C25804')
const projectName = take('--name', `dsh-live-verify-${Date.now()}`)
const checkDefect = has('--check-defect')

const spec = process.env.DSH_EASYEDA_IMPORT ?? '@deepseek-ai/dsh-schematic-easyeda'
const { HttpEasyEdaBridge, EasyEdaLibrary, importIntoEasyEda } = await import(spec)

const fail = (message) => {
  console.error(`FAIL ${message}`)
  process.exit(1)
}

// 1. Bridge discovery (port scan + handshake + connected-window check).
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 60_000 }).catch(error => fail(`bridge discovery: ${error.message}`))
console.log('bridge: discovered and an EasyEDA window is connected')

// A non-2xx on the first execute (e.g. a token-authed foreign implementation
// that claims the same service id) must read as an environment problem, not
// an unhandled rejection.
const stage = (promise, name) => promise.catch(error => fail(`${name}: ${error.message}`))

// 1b. Round-trip probe: a registered window may still not service executes
// (the extension executes on its primary bridge only). Fail fast and clear.
await stage(bridge.execute('return 1', { timeoutMs: 10_000 }), 'execute probe')
console.log('execute: round-trip ok')

// 2. Real library resolution through the client.
const library = new EasyEdaLibrary({ bridge, queryTimeoutMs: 15_000 })
const part = await stage(library.resolveByLcsc(lcsc), `resolveByLcsc(${lcsc})`)
if (!part?.deviceUuid || !part?.symbolUuid) {
  fail(`resolveByLcsc(${lcsc}) returned ${JSON.stringify(part)} — device/symbol binding unavailable`)
}
const pins = await stage(library.resolveSymbolPins(part.symbolUuid, part.symbolLibraryUuid), `resolveSymbolPins(${part.symbolUuid})`)
if (!pins || pins.length < 2) {
  fail(`resolveSymbolPins(${part.symbolUuid}) returned ${pins?.length ?? 0} pins — need at least 2`)
}
console.log(`library: ${lcsc} -> device ${part.deviceUuid}, symbol ${part.symbolUuid} (${pins.length} pins)`)

// 3. Minimal IR: one component at a fixed position; every pin endpoint sits
//    exactly on its bound symbol pin, with a wire stub on a distinct net.
const position = { x: 400, y: 400 }
const usedPins = pins.slice(0, 2)
const endpointOf = (pin, defect) => ({
  x: position.x + pin.x,
  y: position.y + pin.y + (defect ? 10 : 0),
})
// Stub wires must extend outward from the symbol along the pin's dominant
// axis — a fixed-direction stub can land on a sibling pin's endpoint and
// merge the two nets (observed on a 2-pin part with pins at x=±20, y=0).
const stubEndOf = (pin, defect) => {
  const e = endpointOf(pin, defect)
  return Math.abs(pin.x) >= Math.abs(pin.y)
    ? [e.x + Math.sign(pin.x || 1) * 20, e.y]
    : [e.x, e.y + Math.sign(pin.y || 1) * 20]
}
const ir = {
  sheets: [{
    components: [{
      id: 'u1',
      kind: 'part',
      designator: 'U1',
      deviceUuid: part.deviceUuid,
      ...(part.deviceLibraryUuid === undefined ? {} : { deviceLibraryUuid: part.deviceLibraryUuid }),
      symbolUuid: part.symbolUuid,
      ...(part.symbolLibraryUuid === undefined ? {} : { symbolLibraryUuid: part.symbolLibraryUuid }),
      ...(part.footprintUuid === undefined ? {} : { footprintUuid: part.footprintUuid }),
      ...(part.footprintLibraryUuid === undefined ? {} : { footprintLibraryUuid: part.footprintLibraryUuid }),
      position,
      pins: usedPins.map((pin, i) => {
        const endpoint = endpointOf(pin, checkDefect && i === 0)
        return { id: `p${i + 1}`, name: pin.name ?? pin.number, number: pin.number, electric: 'BI', endpoint, net: `NET_${i + 1}` }
      }),
    }],
    wires: usedPins.map((pin, i) => {
      const e = endpointOf(pin, checkDefect && i === 0)
      return { id: `w${i + 1}`, kind: 'wire', dots: [[e.x, e.y, ...stubEndOf(pin, checkDefect && i === 0)]], net: `NET_${i + 1}` }
    }),
    busEntries: [],
    junctions: [],
    attrs: [],
  }],
}

// 4. Import through the client and reconcile the read-back.
const report = await stage(importIntoEasyEda(ir, {
  bridge,
  projectName,
  symbolPins: new Map([[part.symbolUuid, pins]]),
}), 'importIntoEasyEda')
console.log(`import: project ${report.projectUuid} (${report.pageUuids.length} page(s)), name "${projectName}"`)
for (const f of report.findings) {
  console.log(`  [${f.severity}] ${f.code}: ${f.message}`)
}

const errors = report.findings.filter(f => f.severity === 'error')
if (checkDefect) {
  const offPin = errors.filter(f => f.code === 'WIRE_NOT_ON_PIN')
  if (offPin.length < 1) fail('defect check: injected +10 pin offset produced no WIRE_NOT_ON_PIN finding')
  console.log(`defect check: injected pin offset detected as ${offPin.length} WIRE_NOT_ON_PIN error(s)`)
} else {
  if (errors.length > 0) fail(`${errors.length} error finding(s) in a clean import`)
}
console.log('PASS')
