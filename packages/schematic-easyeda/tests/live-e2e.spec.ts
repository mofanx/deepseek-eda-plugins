import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SchematicRuntime from '@deepseek-ai/dsh-schematic'
import type { SchematicIr } from '@deepseek-ai/dsh-schematic'
import { EasyEdaLibrary, HttpEasyEdaBridge, importIntoEasyEda } from '@deepseek-ai/dsh-schematic-easyeda'

/**
 * Env-gated live suite: opted in only when a run-api-gateway bridge answers
 * with a connected EasyEDA client. Without the client it skips at collection
 * time — the bridge probe fails fast on closed ports.
 */
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 60_000 }).catch(() => undefined)

describe.runIf(bridge !== undefined)('live EasyEDA client pipeline', () => {
  const client = bridge as HttpEasyEdaBridge
  const library = new EasyEdaLibrary({ bridge: client, queryTimeoutMs: 15_000 })

  it('resolves an LCSC part to real bindings through the running client', { timeout: 60_000 }, async () => {
    const resolved = await library.resolveByLcsc('C25804')
    expect(resolved?.deviceUuid).toBeDefined()
    expect(await library.resolveDevice(resolved?.deviceUuid as string, resolved?.deviceLibraryUuid)).toBeDefined()
    // LCSC catalog variants are nondeterministic: symbol/footprint
    // associations may be absent, but anything returned must verify.
    if (resolved?.symbolUuid !== undefined) {
      expect(await library.resolveSymbol(resolved.symbolUuid, resolved.symbolLibraryUuid)).toBeDefined()
    }
    if (resolved?.footprintUuid !== undefined) {
      expect(await library.resolveFootprint(resolved.footprintUuid, resolved.footprintLibraryUuid)).toEqual({})
    }
  })

  /**
   * Find a real part whose symbol is not y-symmetric: some pin's mirrored
   * position (x, -y) coincides with no pin of the symbol, so an endpoint
   * landed there visibly misses every pin — the mirror-class defect the
   * read-back reconciliation exists to catch.
   */
  const findAsymmetricPart = async (): Promise<{
    deviceUuid: string
    deviceLibraryUuid?: string | undefined
    symbolUuid: string
    symbolLibraryUuid?: string | undefined
    pins: readonly { number: string; name?: string | undefined; x: number; y: number }[]
    victim: { number: string; x: number; y: number }
    control: { number: string; x: number; y: number }
  } | undefined> => {
    const candidates = await client.execute(
      `const sys = await eda.lib_LibrariesList.getSystemLibraryUuid().catch(() => undefined);
const out = [];
for (const q of ['TYPE-C', 'ESP32', 'USB', 'S9014', 'AMS1117', 'CH340', 'NE555']) {
  const hits = await eda.lib_Device.search(q, sys).catch(() => undefined);
  for (const d of hits ?? []) {
    if (d?.uuid && d.symbolUuid) out.push({ deviceUuid: d.uuid, deviceLibraryUuid: d.libraryUuid, symbolUuid: d.symbolUuid, symbolLibraryUuid: d.symbolLibraryUuid ?? sys });
    if (out.length >= 8) return out;
  }
}
return out;`,
      { timeoutMs: 60_000 },
    ).catch(() => undefined)
    const hits = Array.isArray(candidates)
      ? candidates as { deviceUuid: string; deviceLibraryUuid?: string; symbolUuid: string; symbolLibraryUuid?: string }[]
      : []
    for (const candidate of hits) {
      const pins = await library.resolveSymbolPins(candidate.symbolUuid, candidate.symbolLibraryUuid).catch(() => undefined)
      if (pins === undefined || pins.length < 2) continue
      const victim = pins.find(p => p.y !== 0 && !pins.some(q => q.x === p.x && q.y === -p.y))
      const control = pins.find(p => p !== victim)
      if (victim !== undefined && control !== undefined) return { ...candidate, pins, victim, control }
    }
    return undefined
  }

  it('detects a y-mirrored pin endpoint against the bound symbol geometry', { timeout: 180_000 }, async (context) => {
    const part = await findAsymmetricPart()
    if (part === undefined) {
      context.skip('no library part with a non-y-symmetric symbol was reachable')
      return
    }
    const ctx = new Context()
    const fiber = await ctx.plugin(SchematicRuntime, { layout: 'off' })
    try {
      ctx.schematic.registerLibrary(library)
      const position = { x: 400, y: 400 }
      const endpointOf = (pin: { x: number; y: number }) => ({ x: position.x + pin.x, y: position.y + pin.y })
      const victimEndpoint = { x: position.x + part.victim.x, y: position.y - part.victim.y }
      const controlEndpoint = endpointOf(part.control)
      const ir: SchematicIr = {
        sheets: [{
          components: [{
            id: 'u1', kind: 'part', designator: 'U1',
            deviceUuid: part.deviceUuid,
            ...part.deviceLibraryUuid === undefined ? {} : { deviceLibraryUuid: part.deviceLibraryUuid },
            symbolUuid: part.symbolUuid,
            ...part.symbolLibraryUuid === undefined ? {} : { symbolLibraryUuid: part.symbolLibraryUuid },
            position,
            pins: [
              { id: 'pv', name: part.victim.number, number: part.victim.number, electric: 'BI', endpoint: victimEndpoint, net: 'SIG_V' },
              { id: 'pc', name: part.control.number, number: part.control.number, electric: 'BI', endpoint: controlEndpoint, net: 'SIG_C' },
            ],
          }],
          wires: [
            { id: 'wv', kind: 'wire', dots: [[victimEndpoint.x, victimEndpoint.y, victimEndpoint.x - 40, victimEndpoint.y]], net: 'SIG_V' },
            { id: 'wc', kind: 'wire', dots: [[controlEndpoint.x, controlEndpoint.y, controlEndpoint.x - 40, controlEndpoint.y]], net: 'SIG_C' },
          ],
          busEntries: [], junctions: [], attrs: [],
        }],
      }
      const symbolPins = new Map([[part.symbolUuid, part.pins]])
      const result = await importIntoEasyEda(ir, {
        bridge: client,
        projectName: `dsh-mirror-e2e-${Date.now()}`,
        symbolPins,
      })
      const offPin = result.findings.filter(f => f.code === 'WIRE_NOT_ON_PIN')
      expect(offPin).toHaveLength(1)
      expect(offPin[0]?.severity).toBe('error')
      expect(offPin[0]?.locator).toMatchObject({ componentId: 'u1', pinNumber: part.victim.number })
      // Both wires really exist under their nets, so the name-level diff
      // alone would have stayed blind to the mirrored endpoint.
      expect(result.findings.filter(f => f.code.startsWith('SCHEMATIC_NETLIST_'))).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('binds, lays out, gates, and imports a project end to end', { timeout: 120_000 }, async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(SchematicRuntime, { layout: 'auto' })
    try {
      ctx.schematic.registerLibrary(library)
      const ir: SchematicIr = {
        sheets: [{
          components: [
            {
              id: 'r1', kind: 'part', designator: 'R1', lcsc: 'C25804',
              pins: [
                { id: 'p1', name: '1', number: '1', electric: 'BI', net: 'SIG' },
                { id: 'p2', name: '2', number: '2', electric: 'BI', net: 'GND' },
              ],
            },
            {
              id: 'r2', kind: 'part', designator: 'R2', lcsc: 'C25804',
              pins: [
                { id: 'p3', name: '1', number: '1', electric: 'BI', net: 'SIG' },
                { id: 'p4', name: '2', number: '2', electric: 'BI', net: 'GND' },
              ],
            },
          ],
          wires: [], busEntries: [], junctions: [], attrs: [],
        }],
      }
      const { ir: bound, libraryResolver, symbolPins } = await ctx.schematic.resolveBindings(ir)
      const r1 = bound.sheets[0]?.components[0]
      expect(r1?.deviceUuid).toBeDefined()
      const laid = ctx.schematic.layout(bound, { symbolPins })
      const report = ctx.schematic.validate(laid, { libraryResolver })
      expect(report.findings.filter(f => f.severity === 'error')).toEqual([])
      const result = await importIntoEasyEda(laid, { bridge: client, projectName: `dsh-live-e2e-${Date.now()}` })
      expect(result.projectUuid).toBeDefined()
      expect(result.pageUuids).toHaveLength(1)
      expect(result.findings.filter(f => f.severity === 'error')).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })
})
