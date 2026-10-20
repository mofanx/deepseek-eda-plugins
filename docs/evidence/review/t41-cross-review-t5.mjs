// t41: independent recheck of §14.33 (read-only, does not touch t5's files).
//   - wire shapes (segment count + orientation pattern)
//   - anchors under both models, the dx set over ALL |dy|<6 pairs, and every
//     pair with dx<=30
//   - named nets' coordinates under both models
//   - the net-label surface on the namespace AND on a wire instance prototype
import { gateFreshness } from './shared/freshness.mjs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../../..')
const pkgDir = join(repoRoot, 'packages')
gateFreshness(repoRoot)

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const d = await bridge.execute(`
const g = (o, k) => { try { const f = o['getState_' + k]; return typeof f === 'function' ? f.call(o) : o[k] } catch (e) { return null } };
const wires = (await eda.sch_PrimitiveWire.getAll(undefined, false)) || [];
const first = wires[0];
const protoNames = [];
let q = first;
while (q && q !== Object.prototype) { for (const k of Object.getOwnPropertyNames(q)) protoNames.push(k); q = Object.getPrototypeOf(q) }
const instanceFns = [...new Set(protoNames)].filter(k => { try { return typeof first[k] === 'function' } catch (e) { return false } });
const ns = eda.sch_PrimitiveWire;
const nsOwn = (() => { try { return Object.getOwnPropertyNames(ns) } catch (e) { return ['<threw>'] } })();
const nsKeys = (() => { try { return Object.keys(ns) } catch (e) { return ['<threw>'] } })();
return {
  wireCount: wires.length,
  lines: wires.map(w => ({ net: g(w, 'Net'), line: g(w, 'Line') })),
  instanceFns: instanceFns.sort(),
  instanceLabelish: instanceFns.filter(k => /label|text/i.test(k)).sort(),
  nsOwn, nsKeys,
  schPrimitiveCount: Object.keys(eda).filter(k => /^sch_Primitive/.test(k)).length,
  schCount: Object.keys(eda).filter(k => /^sch_/.test(k)).length,
  labelKeys: Object.keys(eda).filter(k => /label/i.test(k)).sort(),
  netLabelType: typeof eda.sch_PrimitiveNetLabel,
  netLabelCtor: String(eda.sch_PrimitiveNetLabel),
};
`, { timeoutMs: 180_000 })

const r2 = (n) => Math.round(n * 100) / 100
const segsOf = (line) => {
  const out = []
  for (let i = 0; i + 3 < line.length; i += 2) out.push([line[i], line[i + 1], line[i + 2], line[i + 3]])
  return out
}
const shapeOf = (w) => {
  const segs = segsOf(w.line)
  const parts = segs.map((s) => (s[1] === s[3] ? 'H' : s[0] === s[2] ? 'V' : 'D'))
  // collapse runs so a straight polyline reads as one letter
  const runs = parts.filter((p, i) => i === 0 || p !== parts[i - 1])
  return `${segs.length}:${runs.join('-')}`
}
const anchorOf = (w, model) => {
  const line = w.line
  if (model === 'first') return { x: line[0], y: line[1] }
  const segs = segsOf(line)
  let best = segs[0]
  let bestLen = -1
  for (const s of segs) {
    const len = Math.hypot(s[2] - s[0], s[3] - s[1])
    if (len > bestLen) { bestLen = len; best = s }
  }
  return { x: r2((best[0] + best[2]) / 2), y: r2((best[1] + best[3]) / 2) }
}

const shapes = {}
const segLenSet = new Set()
for (const w of d.lines) {
  const s = shapeOf(w); shapes[s] = (shapes[s] ?? 0) + 1
  for (const seg of segsOf(w.line)) segLenSet.add(r2(Math.hypot(seg[2] - seg[0], seg[3] - seg[1])))
}

function analyze(model) {
  const anchors = d.lines.map((w) => ({ net: w.net, ...anchorOf(w, model) }))
  const pairs = []
  for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length; j++) {
    const a = anchors[i]; const b = anchors[j]
    const dx = r2(Math.abs(a.x - b.x)); const dy = r2(Math.abs(a.y - b.y))
    if (dy < 6) pairs.push({ a: `${a.net}(${a.x},${a.y})`, b: `${b.net}(${b.x},${b.y})`, dx, dy })
  }
  const dxSet = [...new Set(pairs.map((p) => p.dx))].sort((x, y) => x - y)
  return {
    rows: new Set(anchors.map((a) => a.y)).size,
    pairs: pairs.length,
    sameRow: pairs.filter((p) => p.dy === 0).length,
    crossRow: pairs.filter((p) => p.dy !== 0).length,
    dxSet,
    dxUnder28: pairs.filter((p) => p.dx < 28).length,
    dxUnder30: pairs.filter((p) => p.dx < 30).length,
    dxMin: dxSet[0],
    tight: pairs.filter((p) => p.dx <= 30).sort((x, y) => x.dx - y.dx || x.dy - y.dy),
    named: anchors.filter((a) => ['+3V3', 'MCU-30', 'MCU-31', 'MCU-34', 'MCU-37', 'GND', 'MCU-26', 'MCU-27'].includes(a.net)),
  }
}

console.log(JSON.stringify({
  status: 'OK',
  wires: d.wireCount,
  shapes,
  segLengths: [...segLenSet].sort((a, b) => a - b),
  api: {
    instanceFns: d.instanceFns,
    instanceLabelish: d.instanceLabelish,
    nsOwn: d.nsOwn,
    nsKeys: d.nsKeys,
    schPrimitiveCount: d.schPrimitiveCount,
    schCount: d.schCount,
    labelKeys: d.labelKeys,
    netLabelType: d.netLabelType,
    netLabelCtor: d.netLabelCtor,
  },
  first: analyze('first'),
  mid: analyze('mid'),
}, null, 1))
