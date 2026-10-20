// t42: independent recheck of t10's d060008 (read-only).
// Gate is content-based on purpose: a byte-identical restore (git checkout)
// bumps src mtime without changing behaviour, which makes an mtime gate report
// STALE_BUILD on a tree that tsc -b already considers up to date.
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '../../..')
const pkgDir = join(repoRoot, 'packages')

const git = (args) => execFileSync('git', ['-c', `safe.directory=${repoRoot.replace(/\\/g, '/')}`, ...args], { cwd: repoRoot, encoding: 'utf8' })
const srcDirty = git(['status', '--porcelain', '--', 'packages']).trim()
const head = git(['rev-parse', '--short', 'HEAD']).trim()
if (srcDirty !== '') {
  console.error(JSON.stringify({ status: 'UNCOMMITTED_SOURCE', head, srcDirty }))
  process.exit(1)
}

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const d = await bridge.execute(`
const g = (o, k) => { try { const f = o['getState_' + k]; return typeof f === 'function' ? f.call(o) : o[k] } catch (e) { return null } };
const wires = (await eda.sch_PrimitiveWire.getAll(undefined, false)) || [];
const comps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const pages = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [];
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
return {
  wires: wires.map(w => ({ net: g(w, 'Net'), line: g(w, 'Line') })),
  comps: comps.map(c => g(c, 'PrimitiveId')),
  pages: pages.map(p => g(p, 'uuid')),
  main: cur && cur.uuid,
};
`, { timeoutMs: 180_000 })

const r2 = (n) => Math.round(n * 100) / 100
const segsOf = (line) => {
  const out = []
  for (let i = 0; i + 3 < line.length; i += 2) out.push([line[i], line[i + 1], line[i + 2], line[i + 3]])
  return out
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
function analyze(model) {
  const anchors = d.wires.map((w) => ({ net: w.net, ...anchorOf(w, model) }))
  const pairs = []
  for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length; j++) {
    const a = anchors[i]; const b = anchors[j]
    const dx = r2(Math.abs(a.x - b.x)); const dy = r2(Math.abs(a.y - b.y))
    if (dy < 6) pairs.push({ a: `${a.net}(${a.x},${a.y})`, b: `${b.net}(${b.x},${b.y})`, dx, dy })
  }
  const tight = pairs.filter((p) => p.dx === 30)
  return {
    rows: new Set(anchors.map((a) => a.y)).size,
    pairs: pairs.length,
    sameRow: pairs.filter((p) => p.dy === 0).length,
    crossRow: pairs.filter((p) => p.dy !== 0).length,
    dxUnder28: pairs.filter((p) => p.dx < 28).length,
    dxUnder30: pairs.filter((p) => p.dx < 30).length,
    dx30Count: tight.length,
    dx30: tight.sort((x, y) => x.dy - y.dy || (x.a < y.a ? -1 : 1)).map((p) => `${p.a} <-> ${p.b} (dx=${p.dx}, dy=${p.dy})`),
  }
}

console.log(JSON.stringify({
  status: 'OK',
  head,
  pages: d.pages.length,
  main: d.main,
  comps: d.comps.length,
  wires: d.wires.length,
  netted: d.wires.filter((w) => typeof w.net === 'string' && w.net).length,
  first: analyze('first'),
  mid: analyze('mid'),
}, null, 1))
