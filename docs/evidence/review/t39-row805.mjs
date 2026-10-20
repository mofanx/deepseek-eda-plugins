// t39: who is on row y=805, and does a wire carry +3V3 / MCU-30? (read-only)
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../../..')
const pkgDir = join(repoRoot, 'packages')
const newest = (dir, ext) => {
  let m = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(f) }
      else if (e.name.endsWith(ext)) m = Math.max(m, statSync(f).mtimeMs)
    }
  }
  if (existsSync(dir)) walk(dir)
  return m
}
const gate = { src: newest(join(pkgDir, 'eda-core/src'), '.ts'), lib: newest(join(pkgDir, 'eda-core/lib'), '.js') }
if (gate.lib < gate.src) { console.error(JSON.stringify({ status: 'STALE_BUILD', ...gate })); process.exit(1) }

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const d = await bridge.execute(`
const g = (o, k) => { try { const f = o['getState_' + k]; return typeof f === 'function' ? f.call(o) : o[k] } catch (e) { return null } };
const wires = (await eda.sch_PrimitiveWire.getAll(undefined, false)) || [];
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
return {
  wires: wires.map(w => ({ net: g(w, 'Net'), line: g(w, 'Line') })),
  flags: comps.filter(c => String(g(c, 'PrimitiveId') || '').startsWith('layout:flag:')).map(c => ({ id: g(c, 'PrimitiveId'), x: g(c, 'X'), y: g(c, 'Y'), name: g(c, 'Name') })),
};
`, { timeoutMs: 180_000 })

const r2 = (n) => Math.round(n * 100) / 100
const rows = (model) => {
  const out = []
  for (const w of d.wires) {
    const line = Array.isArray(w.line) ? w.line : []
    if (line.length < 2) continue
    let x = line[0]; let y = line[1]
    if (model === 'mid') {
      let best = [line[0], line[1], line[2], line[3]]
      let bestLen = -1
      for (let i = 0; i + 3 < line.length; i += 2) {
        const len = Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1])
        if (len > bestLen) { bestLen = len; best = [line[i], line[i + 1], line[i + 2], line[i + 3]] }
      }
      x = r2((best[0] + best[2]) / 2); y = r2((best[1] + best[3]) / 2)
    }
    out.push({ net: w.net, x, y })
  }
  return out
}
const inBand = (anchors) => anchors.filter((a) => a.y >= 795 && a.y <= 815).sort((a, b) => a.y - b.y || a.x - b.x)
const out = {
  status: 'OK',
  nets: d.wires.map((w) => w.net).sort(),
  hasPlus3V3: d.wires.some((w) => w.net === '+3V3'),
  hasMcu30: d.wires.some((w) => w.net === 'MCU-30'),
  flags: d.flags,
  bandA: inBand(rows('first')),
  bandB: inBand(rows('mid')),
}
console.log(JSON.stringify(out, null, 1))
