/**
 * Reproduces the t5 live board offline.
 *
 * Run: node docs/evidence/tools/t5-board.mjs
 *
 * Shape (identical to packages/eda-core/tests/page-budget.spec.ts): five
 * six-part modules chained by their own nets. The spec uses synthetic
 * `dev-<id>` uuids; here every part binds the real C25804 device/symbol so the
 * same board can be pushed through importIntoEasyEda.
 *
 * The metric is the spec's: content box = components ±60/±40 plus wire
 * endpoints, divided by the page area. Reported 2026-10-18 with the t2-era
 * tree: A3 page 0 = 24 parts / 40.7%, tail page = 6 parts / 7.0%.
 *
 * Options matter: the production path calls
 * `layoutSchematic(ir, { pageSize, symbolPins })`. Adding `moduleColumns: 1`
 * yields a different (5-page, 7%) result — do not add it when comparing with
 * live imports.
 */
import { EasyEdaLibrary, HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'
import { SCHEMATIC_PAGE_A3, layoutSchematic } from '../../../packages/schematic/lib/index.js'
import { titleBlockTop } from '../../../packages/eda-core/lib/index.js'

export async function buildT5Board({ live = false } = {}) {
  const names = ['MCU', 'POWER', 'IO', 'MEM', 'CLK']
  let deviceUuid = 'dev'
  let symbolUuid = 'sym'
  let pins = [{ name: 'P1', number: '1' }, { name: 'P2', number: '2' }]
  let lib = {}
  if (live) {
    const bridge = await HttpEasyEdaBridge.discover({ host: '127.0.0.1', timeoutMs: 60000 })
    const library = new EasyEdaLibrary({ bridge, queryTimeoutMs: 20000 })
    const part = await library.resolveByLcsc('C25804')
    pins = await library.resolveSymbolPins(part.symbolUuid, part.symbolLibraryUuid)
    deviceUuid = part.deviceUuid
    symbolUuid = part.symbolUuid
    lib = {
      ...(part.deviceLibraryUuid === undefined ? {} : { deviceLibraryUuid: part.deviceLibraryUuid }),
      ...(part.symbolLibraryUuid === undefined ? {} : { symbolLibraryUuid: part.symbolLibraryUuid }),
    }
  }
  const components = []
  const wires = []
  let n = 0
  for (const block of names) {
    for (let i = 0; i < 6; i++) {
      const id = `u${++n}`
      components.push({
        id, kind: 'part', designator: id.toUpperCase(), deviceUuid, symbolUuid, ...lib, block,
        pins: [0, 1].map(k => ({
          id: `${id}p${k}`, name: pins[k]?.name ?? `P${k}`, number: pins[k]?.number ?? String(k + 1),
          electric: 'BI', net: k === 0 ? `${block}-A${i}` : `${block}-B${i}`,
        })),
      })
      if (i > 0) wires.push({ id: `w${id}`, kind: 'wire', net: `${block}-A${i}`, dots: [[0, 0, 10, 0]] })
    }
  }
  return {
    ir: { sheets: [{ name: 'MAIN', components, wires, busEntries: [], junctions: [], attrs: [], blocks: names.map(name => ({ name, title: name })) }] },
    pins,
  }
}

/** Per-page content box, fill ratio, and the title-block clearance check. */
export function measure(laid, pageSize = SCHEMATIC_PAGE_A3) {
  return laid.sheets.map((sheet, index) => {
    // t4 fits every page, so the sheet's own size wins over the requested one.
    const size = sheet.pageSize ?? pageSize
    const blockTop = titleBlockTop(size)
    const xs = []; const ys = []
    for (const c of sheet.components) { const { x, y } = c.position ?? { x: 0, y: 0 }; xs.push(x - 60, x + 60); ys.push(y - 40, y + 40) }
    // Synthetic uuids leave wire dots unresolved (all null); skip them so the box stays finite.
    for (const w of sheet.wires) for (const [x1, y1, x2, y2] of w.dots ?? []) {
      if ([x1, y1, x2, y2].every(v => typeof v === 'number' && Number.isFinite(v))) { xs.push(x1, x2); ys.push(y1, y2) }
    }
    const box = { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
    const blocks = (sheet.blocks ?? []).length
    return {
      index, name: sheet.name ?? '',
      parts: sheet.components.filter(c => c.id.startsWith('u')).length,
      blocks, box, pageSize: size,
      pageSizeLabel: `${size.width}x${size.height}`,
      fill: Number((((box.x2 - box.x1) * (box.y2 - box.y1)) / (size.width * size.height) * 100).toFixed(1)),
      withinSheet: box.x1 >= 0 && box.y1 >= 0 && box.x2 <= size.width && box.y2 <= size.height,
      clearsTitleBlock: box.y2 <= blockTop, blockTop,
      expectedRects: 27 + blocks,
    }
  })
}

if (process.argv[1]?.endsWith('t5-board.mjs')) {
  const { ir, pins } = await buildT5Board({ live: process.argv.includes('--live') })
  const laid = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([[ir.sheets[0].components[0].symbolUuid, pins]]) })
  console.log(JSON.stringify(measure(laid), null, 1))
}
