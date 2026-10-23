/**
 * r2t1 — offline proof for the `dots` question (no bridge, no EDA writes).
 *
 * `sch_PrimitiveWire.Line` packs FOUR numbers per segment (x1,y1,x2,y2, then the
 * next segment starts at x1',y1' — ends are NOT continuous). The IR field
 * `wire.dots` is a list of POLYLINES, read pairwise (i += 2) by
 * eda-core/src/serialize.ts:311-315 and readback.ts:253-255: consecutive
 * vertices form segments. Feeding a Line into dots therefore crosses two
 * conventions.
 *
 * t26 does exactly that (`dots: sample.line`). This script answers whether any
 * downstream step actually breaks, without guessing:
 *
 *   1. t26's shape: page already has this net|line -> dedupe hits, create() is
 *      never called. Whatever geometry dots means, nothing consumes it.
 *   2. dedupe miss: create() receives the flat array VERBATIM (the chunk treats
 *      dots as a Line and forwards it), so the created wire is not corrupted.
 *   3. the same array through the IR: serialize emits 3 LINE records for an
 *      8-number / 2-segment Line, one of them the fake connector p1 -> p2
 *      (an obvious 42.43 diagonal).
 *   4. control: a real polyline with a shared vertex emits 2 LINEs, 0 diagonals.
 */
import { renderWireChunkScript } from '../../../packages/schematic-easyeda/lib/index.js'
import { serializeEasyEdaDocument } from '../../../packages/eda-core/lib/index.js'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
// Two disjoint horizontal segments, exactly the sch_PrimitiveWire.Line shape.
const LINE = [10, 20, 40, 20, 10, 50, 40, 50]
const isDiag = (l) => {
  const m = l.match(/"startX":(-?[\d.]+),"startY":(-?[\d.]+),"endX":(-?[\d.]+),"endY":(-?[\d.]+)/)
  return m && Number(m[1]) !== Number(m[3]) && Number(m[2]) !== Number(m[4])
}
const fake = (pageLines, pageNets) => {
  const creates = []
  const wires = pageLines.map((line, i) => ({ getState_Net: () => pageNets[i] ?? '', getState_Line: () => line }))
  const eda = {
    dmt_EditorControl: { openDocument: async () => {} },
    dmt_Schematic: { getCurrentSchematicPageInfo: async () => ({ uuid: 'page-1' }) },
    sch_PrimitiveWire: {
      getAll: async () => wires,
      create: async (line, net) => { creates.push({ len: line.length, line: [...line], net }) },
    },
    sch_PrimitiveBus: { getAll: async () => [], create: async () => {} },
  }
  return { eda, creates }
}
const run = (eda, wires) => new AsyncFunction('eda', renderWireChunkScript(wires, 'page-1', 0))(eda)

const out = {}
{
  const f = fake([LINE], ['A'])
  const r = await run(f.eda, [{ irId: 'replay', kind: 'wire', net: 'A', dots: LINE }])
  out.case1_t26Shape_dedupeHit = { status: r.status, created: r.created, failures: r.failures, createCalls: f.creates.length }
}
{
  const f = fake([[0, 0, 999, 0]], ['A'])
  const r = await run(f.eda, [{ irId: 'replay', kind: 'wire', net: 'A', dots: LINE }])
  out.case2_dedupeMiss_createReceives = { status: r.status, created: r.created, createCalls: f.creates }
}
{
  const ir = { sheets: [{ components: [], wires: [{ id: 'w', kind: 'wire', dots: [LINE], net: 'A' }], busEntries: [], junctions: [], attrs: [] }] }
  const segs = serializeEasyEdaDocument(ir).split('\n').filter((l) => l.startsWith('{"type":"LINE"'))
  out.case3_lineIntoIrSerialize = { lineRecords: segs.length, diagonals: segs.filter(isDiag).length }
}
{
  const poly = [10, 20, 40, 20, 40, 50]
  const ir = { sheets: [{ components: [], wires: [{ id: 'w', kind: 'wire', dots: [poly], net: 'A' }], busEntries: [], junctions: [], attrs: [] }] }
  const segs = serializeEasyEdaDocument(ir).split('\n').filter((l) => l.startsWith('{"type":"LINE"'))
  out.case4_realPolylineControl = { lineRecords: segs.length, diagonals: segs.filter(isDiag).length }
}
console.log(JSON.stringify(out, null, 1))
