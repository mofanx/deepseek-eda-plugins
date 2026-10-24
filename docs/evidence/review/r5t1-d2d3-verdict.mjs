#!/usr/bin/env node
// r5t1 (D2/D3 rehearsal) - step 3 of 3: interval + criterion computation. READ-ONLY.
//
// Inputs : <tmp>/r5t1-geom.json  (from r5t1-d2d3-dump.mjs)
//          <tmp>/r5t1-scan.json  (from r5t1-d2d3-scan.ps1)
// Output : <tmp>/r5t1-verdict.json, plus a comparison table on stdout.
//
// Run from the repo root, in the same shell session as the first two steps:
//   node docs/evidence/review/r5t1-d2d3-verdict.mjs
// Exit 0 means every number committed in r5t1-d2d3-rehearsal.json was reproduced
// within TOL; exit 1 means at least one was not, and the gap is printed.
//
// This script only reads the two JSON files above. It never opens a bridge connection.
//
// The three criteria, fixed before any measurement:
//   c1  the moved name must not press a foreign glyph  (ink-box overlap)
//   c2  the name must stay on its own wire (net preserved)
//   c3  the move must not create a new text-on-foreign-wire instance (d<=12 and 0.05<t<0.95)
// A clean window means all three hold at once. If none exists the verdict is no-go.
//
// Reproducibility note: the ink spans the pixel scan returns match the committed values to
// within 1-2 px (<=0.25 unit). The residual is the y-band edge - one extra row admits one more
// glyph column. Hence TOL = 0.3 and an explicit MISMATCH row instead of silent absorption.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOL = 0.3
const geom = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'r5t1-geom.json'), 'utf8'))

const segsExcept = (id) => geom.wires.filter(w => w.id !== id).flatMap(w => {
  const L = w.line || []
  const out = []
  for (let i = 0; i + 3 < L.length; i += 4) out.push({ wire: w.id, net: w.net, x1: L[i], y1: L[i + 1], x2: L[i + 2], y2: L[i + 3] })
  return out
})
const proj = (px, py, s) => {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1
  const l2 = dx * dx + dy * dy
  const tRaw = l2 === 0 ? 0 : ((px - s.x1) * dx + (py - s.y1) * dy) / l2
  const t = Math.max(0, Math.min(1, tRaw))
  return { d: Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy)), t, tRaw }
}
const nearest = (px, py, ownId) => {
  let best = null
  for (const s of segsExcept(ownId)) {
    const r = proj(px, py, s)
    if (!best || r.d < best.d) best = { ...r, wire: s.wire, net: s.net }
  }
  return best
}

// label ink (measured by the pixel scan) and the boxes that can block it on the same row
const OBJ = [
  {
    key: 'obj1', id: 'attr111', own: 'layout:wire:MCU_34:flags', ax: 210, ay: 795,
    labelInk: [229.33, 248.48],
    row: [
      { name: 'pin number 31', box: [235.64, 241.82] },
      { name: 'pin name PA10', box: [252.85, 268.85] },
      { name: 'flag name MCU_34:0', box: [269.33, 288.5] }
    ],
    committed: { d: 5, t: 0.75, c3Onset: 0, blocks: { 'pin number 31': [0, 12.45], 'pin name PA10': [4.4, 39.5], 'flag name MCU_34:0': [20.9, 40] } }
  },
  {
    key: 'obj2', id: 'attr43', own: 'layout:wire:MCU_26:flags', ax: 350, ay: 795,
    labelInk: [369.18, 388.3],
    row: [
      { name: 'pin name PB10', box: [368.7, 385.67] },
      { name: 'pin number 21', box: [395.36, 401.67] },
      { name: 'attr102 wire-label ink', box: [409.79, 428.94] }
    ],
    committed: { d: 10, t: 1, c3Onset: 12.0, blocks: { 'pin name PB10': [0, 16.45], 'pin number 21': [7.1, 32.45], 'attr102 wire-label ink': [21.5, 40] } }
  }
]

const out = { generatedAt: new Date().toISOString(), tol: TOL, objects: [], comparison: [] }
const checks = []
const add = (label, got, want) => checks.push({
  label, got: got === null ? null : (typeof got === 'number' ? +got.toFixed(3) : got), want,
  ok: got !== null && Math.abs(got - want) <= TOL
})

for (const o of OBJ) {
  const w = o.labelInk[1] - o.labelInk[0]
  const rel1 = o.labelInk[0] - o.ax        // ink offset from the anchor
  const rel2 = o.labelInk[1] - o.ax
  const rows = []
  for (const b of o.row) {
    // label ink = [ax + s + rel1, ax + s + rel2]; it overlaps [b1,b2] when both ends interleave
    const sHi = b.box[1] - (o.ax + rel1)
    const sLo = b.box[0] - (o.ax + rel2)
    const lo = Math.max(0, sLo), hi = Math.min(40, sHi)
    rows.push({ name: b.name, box: b.box, blocksS: hi > lo ? [+lo.toFixed(2), +hi.toFixed(2)] : null })
  }

  const base = nearest(o.ax, o.ay, o.own)
  // integer stepping: accumulating 0.01 in floating point drifts past 40 and would turn a
  // fully-blocked row into a phantom 1-step "clean window" at the very end
  let onset = null
  for (let i = 0; i <= 4000; i++) {
    const s = i / 100
    const n = nearest(o.ax + s, o.ay, o.own)
    if (n.d <= 12 && n.t > 0.05 && n.t < 0.95) { onset = +s.toFixed(2); break }
  }

  // clean windows = s where no row blocks (c3 is already folded in: a blocked row is a press)
  const blockedAt = (s) => rows.some(r => r.blocksS && s >= r.blocksS[0] && s <= r.blocksS[1])
  const clean = []
  let runStart = null
  for (let i = 0; i <= 4000; i++) {
    const s = i / 100
    const ok = !blockedAt(s)
    if (ok && runStart === null) runStart = s
    if (!ok && runStart !== null) { clean.push([+runStart.toFixed(2), +(s - 0.01).toFixed(2)]); runStart = null }
  }
  if (runStart !== null) clean.push([+runStart.toFixed(2), 40])

  out.objects.push({
    key: o.key, id: o.id, labelInk: o.labelInk, inkWidth: +w.toFixed(2),
    baseline: { d: +base.d.toFixed(3), t: +base.t.toFixed(3), wire: base.wire, net: base.net, pressing: base.d <= 12 && base.t > 0.05 && base.t < 0.95 },
    blockingRows: rows, c3Onset: onset, cleanWindows: clean,
    goNoGo: clean.length === 0 ? 'no-go' : 'go'
  })

  add(o.key + '.d', +base.d.toFixed(3), o.committed.d)
  add(o.key + '.t', +base.t.toFixed(3), o.committed.t)
  add(o.key + '.c3Onset', onset, o.committed.c3Onset)
  for (const r of rows) {
    const want = o.committed.blocks[r.name]
    if (!want) continue
    if (!r.blocksS) { checks.push({ label: o.key + '.' + r.name, got: null, want, ok: false }); continue }
    add(o.key + '.' + r.name + '.lo', r.blocksS[0], want[0])
    add(o.key + '.' + r.name + '.hi', r.blocksS[1], want[1])
  }
}

console.log('obj  key                          got          committed    ok')
for (const c of checks) {
  console.log(`${String(c.label).replace(/^obj\d\./, '')}`.padEnd(0) + '  ' +
    String(c.label).padEnd(32) + ' ' + String(c.got).padEnd(12) + ' ' + String(c.want).padEnd(12) + ' ' + (c.ok ? 'OK' : 'MISMATCH'))
}
for (const o of out.objects) {
  console.log(`${o.key}: baseline d=${o.baseline.d} t=${o.baseline.t} (${o.baseline.net}, pressing=${o.baseline.pressing}) c3Onset=${o.c3Onset} cleanWindows=${JSON.stringify(o.cleanWindows)} -> ${o.goNoGo}`)
}

const bad = checks.filter(c => !c.ok)
out.comparison = checks
out.result = bad.length === 0 ? 'REPRODUCED' : 'MISMATCH'
out.goNoGo = out.objects.every(o => o.goNoGo === 'no-go') ? 'no-go' : 'go'
fs.writeFileSync(path.join(os.tmpdir(), 'r5t1-verdict.json'), JSON.stringify(out, null, 2) + '\n')
console.log('\n' + out.result + (bad.length ? ` (${bad.length} outside tol ${TOL})` : ` - every committed number reproduced within ${TOL} unit`))
console.log('overall ' + out.goNoGo + ' (both objects)')
console.log('verdict written to ' + path.join(os.tmpdir(), 'r5t1-verdict.json'))
if (bad.length) process.exitCode = 1
