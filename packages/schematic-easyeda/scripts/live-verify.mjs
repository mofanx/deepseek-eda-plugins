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
 * `easyeda-bridge` handshake on 49620-49630 works).
 *
 * Usage:
 *   node live-verify.mjs [--lcsc C25804] [--name <project>] [--check-defect]
 *   DSH_EASYEDA_IMPORT=<specifier>  override the package import specifier —
 *   e.g. point at `../src/index.ts` under tsx for a source-tree run; defaults
 *   to the installed `@deepseek-ai/dsh-plugin-eda-easyeda`.
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
const hierarchy = has('--hierarchy')

const spec = process.env.DSH_EASYEDA_IMPORT ?? '@deepseek-ai/dsh-plugin-eda-easyeda'
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
    name: 'DUT',
    blocks: [{ name: 'dut', title: 'DEVICE UNDER TEST' }],
    components: [{
      id: 'u1',
      kind: 'part',
      block: 'dut',
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

// 3b. Hierarchical variant: page TOP hosts a drawn sheet-symbol block bound
//     to the child page POWER (sheetIndex), whose part pins merge into the
//     interface nets through netports of the same names.
if (hierarchy) {
  const blockPins = [
    { id: 'b1', name: 'VIN', number: '1', endpoint: { x: 320, y: 360 }, net: 'VIN' },
    { id: 'b2', name: 'VOUT', number: '2', endpoint: { x: 320, y: 400 }, net: 'VOUT' },
  ]
  const childSheet = ir.sheets[0]
  childSheet.name = 'POWER'
  childSheet.blocks = undefined
  for (const component of childSheet.components) delete component.block
  childSheet.components[0].pins[0] = { ...childSheet.components[0].pins[0], net: 'VIN' }
  childSheet.components[0].pins[1] = { ...childSheet.components[0].pins[1], net: 'VOUT' }
  // Netports sit above/below the part so the two stubs route around the
  // symbol without crossing each other — a crossing merges the regions.
  childSheet.components.push(
    { id: 'np1', kind: 'netport', netName: 'VIN', position: { x: 700, y: 340 }, pins: [] },
    { id: 'np2', kind: 'netport', netName: 'VOUT', position: { x: 700, y: 460 }, pins: [] },
  )
  // Orthogonal stubs: outward along the pin axis, then across to the netport
  // anchor — a straight diagonal would cut through the symbol.
  const ortho = (pin, net, ty) => {
    const e = endpointOf(pin)
    const elbow = Math.abs(pin.x) >= Math.abs(pin.y) ? [e.x + Math.sign(pin.x || 1) * 20, e.y] : [e.x, e.y + Math.sign(pin.y || 1) * 20]
    return { kind: 'wire', dots: [[e.x, e.y, ...elbow], [...elbow, elbow[0], ty], [elbow[0], ty, 700, ty]], net }
  }
  childSheet.wires[0] = { id: 'w1', ...ortho(usedPins[0], 'VIN', 340) }
  childSheet.wires[1] = { id: 'w2', ...ortho(usedPins[1], 'VOUT', 460) }
  ir.sheets.unshift({
    name: 'TOP',
    components: [{
      id: 'blk_power',
      kind: 'block',
      designator: 'POWER',
      sheetIndex: 1,
      position: { x: 310, y: 300 },
      pins: blockPins.map(p => ({ ...p, electric: 'BI' })),
    }],
    wires: blockPins.map((p, i) => ({
      id: `bw${i + 1}`,
      kind: 'wire',
      dots: [[p.endpoint.x, p.endpoint.y, p.endpoint.x - 60, p.endpoint.y]],
      net: p.net,
    })),
    busEntries: [],
    junctions: [],
    attrs: [],
  })
}

// 4. Import through the client and reconcile the read-back.
const report = await stage(importIntoEasyEda(ir, {
  bridge,
  projectName,
  symbolPins: new Map([[part.symbolUuid, pins]]),
  // Verification owns the editor: previous runs leave document tabs open that
  // would otherwise block the project switch.
  allowTabClose: true,
  // A slow client can spend minutes on the automatic project open; the
  // queue-drain wait is timeoutMs * 8 (720s here).
  timeoutMs: 90_000,
}), 'importIntoEasyEda')
console.log(`import: project ${report.projectUuid} (${report.pageUuids.length} page(s)), name "${projectName}"`)
for (const f of report.findings) {
  console.log(`  [${f.severity}] ${f.code}: ${f.message}`)
}

// 5. Drawing proof: the imported pages must hold the dashed RECT borders and
//    TEXT titles the serializer emits — module frames in the flat case, the
//    sheet-symbol box plus pin labels on TOP in the hierarchical case.
const wantPages = hierarchy ? 2 : 1
if (report.pageUuids.length !== wantPages) {
  fail(`expected ${wantPages} imported page(s), got ${report.pageUuids.length}`)
}
const frameCount = await stage(bridge.execute(`const perPage = [];
for (const uuid of ${JSON.stringify(report.pageUuids)}) {
  try {
    await eda.dmt_EditorControl.openDocument(uuid);
    let rects = 0; let texts = 0; let components = 0;
    try { rects = (await eda.sch_PrimitiveRectangle.getAll() || []).length } catch (e) {}
    try { texts = (await eda.sch_PrimitiveText.getAll() || []).length } catch (e) {}
    try { components = (await eda.sch_PrimitiveComponent.getAll(undefined, false) || []).length } catch (e) {}
    perPage.push({ uuid, rects, texts, components });
  } catch (e) { perPage.push({ uuid, error: String(e) }) }
}
return perPage;`, { timeoutMs: 60_000 }), 'frame probe')
console.log(`frames: ${JSON.stringify(frameCount)}`)
if (hierarchy) {
  const top = frameCount[0]
  const child = frameCount[1]
  if (!top || top.rects < 1 || top.texts < 3) fail(`sheet-symbol box missing on TOP page: ${JSON.stringify(top)}`)
  if (!child || child.components < 3) fail(`child page missing part/netports: ${JSON.stringify(child)}`)
} else {
  const page = frameCount[0]
  if (!page || page.rects < 1 || page.texts < 1) {
    fail(`module frame missing on imported page: ${JSON.stringify(frameCount)}`)
  }
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
