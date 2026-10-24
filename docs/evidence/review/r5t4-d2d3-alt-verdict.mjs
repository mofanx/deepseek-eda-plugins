#!/usr/bin/env node
// r5t4 (r2t3) - step 2: evaluate the two alternative fixes and emit the evidence JSON.
// READ-ONLY: reads the pixel scan + the recorded wire rows, writes only the JSON artifact.
//
// Run from the repo root, after r5t4-d2d3-alt-scan.ps1:
//   node docs/evidence/review/r5t4-d2d3-alt-verdict.mjs
//
// Inputs : <tmp>/r5t4-alt-scan.json   (pixel boxes, from the scan script)
//          the wire rows below, taken from the API geometry dump and listed in the JSON so the
//          reader can check them against the dump without trusting this file
// Output : docs/evidence/current/r5t4-d2d3-alternatives.json  (+ a table on stdout)
//
// Criteria (fixed before measuring):
//   1  the moved/shrunk label must not overlap any black glyph
//   2  it must still belong to its own net: anchor-to-own-wire distance stays <= 6
//   2' the reading the numbers force: the own wire must stay the nearest BOTH for the anchor
//      (what the d<=6 rule measures) AND for the ink (what a reader actually associates)
//   3  no NEW text-on-foreign-wire instance (d<=12 and 0.05<t<0.95)
//   4  readable: font size must not drop below 4 (rationale in the JSON)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = os.tmpdir()
const scan = JSON.parse(fs.readFileSync(path.join(TMP, 'r5t4-alt-scan.json'), 'utf8'))
const OUT = 'docs/evidence/current/r5t4-d2d3-alternatives.json'

const FS_NOW = 6          // measured: every visible Name attribute on this page is fs 6
const D_TEXT = 6          // the text threshold from the brief
const D_WIRE = 12         // the third-class wire rule
const FS_FLOOR = 4        // readability floor, argued in the JSON
const PITCH = 10.0        // measured: Pin Number y = 784.085 / 794.085 / 804.085 / 814.085
const STEP = 0.02         // h scan step

// horizontal wire rows near the two anchors, straight from the geometry dump
const ROWS = [
  { net: 'MCU-34', y: 795, x1: 210, x2: 250, own: 'obj1' },
  { net: 'MCU-33', y: 785, x1: 210, x2: 250 },
  { net: 'MCU-32', y: 775, x1: 210, x2: 250 },
  { net: 'MCU-37', y: 805, x1: 150, x2: 210 },
  { net: 'MCU-38', y: 815, x1: 150, x2: 210 },
  { net: '+3V3',  y: 800, x1: 200, x2: 240 },
  { net: 'MCU-26', y: 795, x1: 350, x2: 390, own: 'obj2' },
  { net: 'MCU-25', y: 785, x1: 350, x2: 390 },
  { net: 'MCU-27', y: 805, x1: 350, x2: 390 },
  { net: 'GND',   y: 800, x1: 360, x2: 400 }
]

const box = (key, yMin, yMax) => {
  const cs = scan[key] || []
  const c = cs.find(c => c.y2 > yMin && c.y1 < yMax)
  if (!c) throw new Error('no cluster for ' + key)
  return { x1: c.x1, x2: c.x2, y1: c.y1, y2: c.y2, h: c.h }
}
const bands = (key) => (scan[key] || []).map(c => ({ y1: c.y1, y2: c.y2, h: c.h, x1: c.x1, x2: c.x2 }))

// anchor-to-horizontal-segment distance, foot clamped to the segment
const dist = (ax, ay, r) => {
  const cx = Math.max(r.x1, Math.min(r.x2, ax))
  const t = r.x1 === r.x2 ? 0 : (cx - r.x1) / (r.x2 - r.x1)
  return { d: Math.hypot(ax - cx, ay - r.y), t, net: r.net }
}
// ink-box to horizontal wire: Infinity when the x ranges do not overlap
const boxDist = (y1, y2, wireY, bx1, bx2, wx1, wx2) => {
  if (Math.min(bx2, wx2) <= Math.max(bx1, wx1)) return Infinity
  if (wireY >= y1 && wireY <= y2) return 0
  return Math.min(Math.abs(y1 - wireY), Math.abs(y2 - wireY))
}
const overlaps = (a1, a2, b1, b2) => a1 < b2 && a2 > b1

const OBJ = [
  { key: 'obj1', id: 'attr111', net: 'MCU-34', ax: 210, ay: 795, pressedKey: 'w1.pin31', bandsKey: 'w1.blackfull', pressedLabel: '31', labelKey: 'w1.label' },
  { key: 'obj2', id: 'attr43', net: 'MCU-26', ax: 350, ay: 795, pressedKey: 'w2.pb10', bandsKey: 'w2.blackfull', pressedLabel: 'PB10', labelKey: 'w2.label' }
]

function planA(o) {
  const label = box(o.labelKey, 789, 796)
  const pressed = box(o.pressedKey, 789, 796)
  const bl = bands(o.bandsKey).filter(b => b.y2 > label.y1 - 22 && b.y1 < label.y2 + 22)
  const ownRow = ROWS.find(r => r.own === o.key)
  const others = ROWS.filter(r => r.own !== o.key)

  // free gaps, reported for the reader
  const gaps = []
  for (let i = 0; i < bl.length - 1; i++) {
    const g1 = bl[i].y2, g2 = bl[i + 1].y1
    if (g2 - g1 > 0.05) gaps.push([+g1.toFixed(2), +g2.toFixed(2), +(g2 - g1).toFixed(2)])
  }
  const clearBlack = (y1, y2) => !bl.some(b => overlaps(y1, y2, b.y1, b.y2))

  // scan the whole h range, both directions; a h only counts if EVERY criterion holds
  const scanDir = (dir) => {
    const pass = [], fail = {}
    const bump = (k) => { fail[k] = (fail[k] || 0) + 1 }
    for (let h = STEP; h <= D_TEXT + 1e-9; h += STEP) {
      const hh = +h.toFixed(3)
      const ay = dir === 'up' ? o.ay - hh : o.ay + hh
      const inkY1 = dir === 'up' ? label.y1 - hh : label.y1 + hh
      const inkY2 = dir === 'up' ? label.y2 - hh : label.y2 + hh
      if (!clearBlack(inkY1, inkY2)) { bump('1_black_overlap'); continue }
      const own = dist(o.ax, ay, ownRow)
      if (own.d > D_TEXT) { bump('2_d_over_6'); continue }
      const ds = others.map(r => dist(o.ax, ay, r)).sort((a, b) => a.d - b.d)
      if (!(own.d <= ds[0].d)) { bump('2p_anchor_not_nearest'); continue }
      const inkOwn = boxDist(inkY1, inkY2, ownRow.y, label.x1, label.x2, ownRow.x1, ownRow.x2)
      const inkOther = Math.min(...others.map(r => boxDist(inkY1, inkY2, r.y, label.x1, label.x2, r.x1, r.x2)))
      if (!(inkOwn <= inkOther)) { bump('2p_ink_not_nearest'); continue }
      pass.push(hh)
    }
    // compress into intervals
    const spans = []
    for (const h of pass) {
      const last = spans[spans.length - 1]
      if (last && Math.abs(h - last[1] - STEP) < 1e-6) last[1] = h
      else spans.push([h, h])
    }
    return { spans, fail }
  }

  const up = scanDir('up'), down = scanDir('down')

  // representative points, so the failure is visible in numbers rather than adjectives
  const probe = (dir, h) => {
    const ay = dir === 'up' ? o.ay - h : o.ay + h
    const inkY1 = dir === 'up' ? label.y1 - h : label.y1 + h
    const inkY2 = dir === 'up' ? label.y2 - h : label.y2 + h
    const own = dist(o.ax, ay, ownRow)
    const ds = others.map(r => dist(o.ax, ay, r)).sort((a, b) => a.d - b.d)
    const inkOwn = boxDist(inkY1, inkY2, ownRow.y, label.x1, label.x2, ownRow.x1, ownRow.x2)
    const inkAll = others.map(r => ({ net: r.net, d: boxDist(inkY1, inkY2, r.y, label.x1, label.x2, r.x1, r.x2) })).sort((a, b) => a.d - b.d)
    return {
      h, dir, anchorY: +ay.toFixed(2), ink: [+inkY1.toFixed(2), +inkY2.toFixed(2)],
      dOwn: +own.d.toFixed(2), nearestOtherByAnchor: ds[0].net, dOtherByAnchor: +ds[0].d.toFixed(2),
      inkToOwn: +inkOwn.toFixed(2), nearestOtherByInk: inkAll[0].net, inkToOther: +inkAll[0].d.toFixed(2),
      presses: ds.filter(x => x.d <= D_WIRE && x.t > 0.05 && x.t < 0.95).map(x => x.net + '@' + x.d.toFixed(2))
    }
  }

  return {
    label, pressed, pressedLabel: o.pressedLabel, gaps,
    feasible: { up: up.spans, down: down.spans },
    rejectedBecause: { up: up.fail, down: down.fail },
    probes: [probe('up', 3.76), probe('up', 4.24), probe('down', 4.37), probe('down', 5.00)]
  }
}

// ---------- plan B: font size ----------
function planB(o) {
  const label = box(o.labelKey, 789, 796)
  const pressed = box(o.pressedKey, 789, 796)
  const origins = [
    { name: 'ink-left', o: label.x1 },
    { name: 'ink-right', o: label.x2 },
    { name: 'ink-center', o: (label.x1 + label.x2) / 2 },
    { name: 'anchor', o: o.ax }
  ]
  const out = []
  for (const org of origins) {
    let kmax = null
    for (let k = 1.0; k >= 0.01; k -= 0.005) {
      const a = org.o + k * (label.x1 - org.o)
      const b = org.o + k * (label.x2 - org.o)
      if (b <= pressed.x1 || a >= pressed.x2) { kmax = k; break }
    }
    out.push({
      origin: org.name,
      requiredFs: kmax === null ? null : +(FS_NOW * kmax).toFixed(2),
      shrinkFeasible: kmax !== null && FS_NOW * kmax < FS_NOW
    })
  }
  const cands = out.filter(r => r.requiredFs !== null && r.requiredFs < FS_NOW).map(r => r.requiredFs)
  return { label, pressed, pressedLabel: o.pressedLabel, origins: out, bestCaseFs: cands.length ? Math.max(...cands) : null }
}

const calibration = {
  from: 16, to: 14, inkFrom: 208.4, inkTo: 174.7,
  ratio: +(174.7 / 208.4).toFixed(4),
  linearPrediction: +(208.4 * 14 / 16).toFixed(2),
  note: 'ink width scales with font size. The 14pt ink came out 4.2% narrower than the linear prediction, so a linear estimate of the required size is mildly optimistic; the true size would be a few percent LARGER, which does not help a shrink-to-fit plan.'
}

const A = { obj1: planA(OBJ[0]), obj2: planA(OBJ[1]) }
const B = { obj1: planB(OBJ[0]), obj2: planB(OBJ[1]) }

console.log('=== plan A: vertical offset ===')
for (const k of ['obj1', 'obj2']) {
  const r = A[k]
  console.log(`\n${k} (${r.label.x1}-${r.label.x2} x, ink y ${r.label.y1}-${r.label.y2}, h=${r.label.h}) vs ${r.pressedLabel} y ${r.pressed.y1}-${r.pressed.y2}`)
  console.log('  free black gaps: ' + JSON.stringify(r.gaps))
  console.log('  h satisfying EVERY criterion: up=' + JSON.stringify(r.feasible.up) + ' down=' + JSON.stringify(r.feasible.down))
  console.log('  rejections: ' + JSON.stringify(r.rejectedBecause))
  for (const p of r.probes) {
    console.log(`   probe ${p.dir} h=${p.h}: ink ${p.ink[0]}-${p.ink[1]}; anchor ${p.anchorY} dOwn=${p.dOwn} vs ${p.nearestOtherByAnchor}@${p.dOtherByAnchor}; ink->own ${p.inkToOwn} vs ${p.nearestOtherByInk}@${p.inkToOther}; presses ${JSON.stringify(p.presses)}`)
  }
}

console.log('\n=== plan B: font size (now fs ' + FS_NOW + ') ===')
for (const k of ['obj1', 'obj2']) {
  console.log(`${k}: ink ${B[k].label.x1}-${B[k].label.x2} vs pressed ${B[k].pressed.x1}-${B[k].pressed.x2}; best shrinking fs = ${B[k].bestCaseFs}`)
  for (const r of B[k].origins) console.log(`   origin ${r.origin.padEnd(10)} -> required fs ${String(r.requiredFs).padEnd(6)} shrinkFeasible=${r.shrinkFeasible}`)
}
console.log('calibration: ' + JSON.stringify(calibration))

const obj1Aok = A.obj1.feasible.up.length + A.obj1.feasible.down.length > 0
const obj2Aok = A.obj2.feasible.up.length + A.obj2.feasible.down.length > 0
const obj1Bok = B.obj1.bestCaseFs !== null && B.obj1.bestCaseFs >= FS_FLOOR
const obj2Bok = B.obj2.bestCaseFs !== null && B.obj2.bestCaseFs >= FS_FLOOR

const doc = {
  task: 'r2t3 (r5t4) - D2/D3 alternatives: vertical offset vs font size, read-only',
  mode: 'read-only. No canvas write, no bridge write call, no document change. The only artifact is this JSON.',
  head: process.env.R5T4_HEAD || 'see gates.pushedAtHead',
  date: '2026-10-24',
  premise: 't2 + r5t3 established that sliding each label along its own wire leaves an EMPTY net-clearance interval. This task changes dimension: move perpendicular (page y) or shrink the text.',
  criteria: [
    '1 no overlap with any black glyph',
    '2 still attributable to its own net: anchor-to-own-wire distance <= 6',
    "2' the own wire must remain the nearest for the anchor AND for the ink; otherwise the label is attributable to a neighbouring net at one of the two levels",
    '3 no NEW text-on-foreign-wire instance (d<=12 and 0.05<t<0.95)',
    '4 readability: font size may not fall below 4'
  ],
  measured: {
    fontSizeNow: FS_NOW,
    fontSizeHistogram: { wireLabelName: { 6: 55 }, flagLabelName: { 6: 14 } },
    pinPitch: PITCH,
    pinPitchEvidence: 'Pin Number y on the u1 columns: 784.085 / 794.085 / 804.085 / 814.085; Pin Name y: 780.085 / 790.085 / 800.085 / 810.085',
    labelInk: { obj1: A.obj1.label, obj2: A.obj2.label },
    pressedInk: { obj1: A.obj1.pressed, obj2: A.obj2.pressed },
    frameScale: '8.25 px/unit (r2t1 frames, reused so the numbers stay comparable with r5t1)'
  },
  planA: {
    idea: 'translate the label along page y by h so its ink leaves the pressed glyph band',
    networkNote: 'the label is attached by parentPrimitiveId, so ownership is structural; d<=6 is the audit heuristic. Moving the anchor vertically raises d from 0 to h.',
    obj1: {
      ...A.obj1,
      criterion2Literal: 'PASS for every h in [3.76, 6.0]: d = h <= 6',
      verdict: obj1Aok ? 'conditional' : 'no-go',
      why: 'Up clears the digits at h>=3.76 but the INK then sits closer to the row above (MCU-33) than to its own wire, so it reads as the wrong net. Down clears them at h>=4.37 but the anchor lands within 0.1-0.6 of the +3V3 wire at y=800, so the d-rule itself assigns it to +3V3. The two directions fail on two different levels and neither leaves a usable band.'
    },
    obj2: {
      ...A.obj2,
      verdict: obj2Aok ? 'conditional' : 'no-go',
      why: 'the tallest free black band within d<=6 is 2.07 units while the label is 3.76 units tall, so criterion 1 is unsatisfiable at every h. This is geometric, not a matter of taste.'
    },
    fatalPoint: 'the brief expected the killer at h>6. It is not: h_min is 3.76-4.37, so d stays under 6 and the label still counts as that wire\'s label. It breaks EARLIER, at two different places: (a) once h>2.18 the ink is nearer the neighbouring wire than its own - arithmetic: ink-to-own = 0.94+h, ink-to-MCU-33 = 5.30-h, equal at h=2.18; (b) going down, the +3V3 wire at y=800 is only 5 units below, so from h=4.37 the anchor is 0.6 from it, nearer than its own wire. The effective thresholds are therefore 2.18 (ink) and ~4.4 (anchor), both below the h needed to clear the glyph.'
  },
  planB: {
    idea: 'shrink fontSize so the ink narrows enough to stop covering the pressed glyph',
    calibration,
    obj1: {
      ...B.obj1,
      verdict: obj1Bok ? 'conditional' : 'no-go',
      why: 'best case is fs ' + B.obj1.bestCaseFs + ' (scaling about the attribute anchor), below the floor of ' + FS_FLOOR + '. The other origins need less: ink-left 1.62, ink-right 2.10; ink-centre is impossible at any size because the pressed glyph contains the label centre.'
    },
    obj2: {
      ...B.obj2,
      verdict: obj2Bok ? 'conditional' : 'no-go',
      why: 'the label starts at 369.18 while PB10 spans 368.21-385.30, i.e. the glyph covers the label\'s left edge. Left-pinned shrinking can never move that edge out; centre-pinned is impossible (centre inside the glyph); anchor-pinned needs fs <= 2.85. All below the floor of 4.'
    },
    floor: {
      value: FS_FLOOR,
      rationale: 'every visible net label on this page is fs 6 (55 wire + 14 flag). At 8.25 px/unit its ink is 3.76 units tall; at fs 4 it would be 2.51 units (~21 px), already shorter than the pin numbers beside it (4.36-4.85 units). Below 4 the net name becomes the smallest text in its row, subordinate to the number it is meant to name - the fix would swap a collision for a legibility defect. This is a judgement and is labelled as one.'
    }
  },
  overall: (obj1Aok || obj1Bok || obj2Aok || obj2Bok)
    ? 'at least one plan has a candidate band; re-check before publishing'
    : 'BOTH plans are no-go for BOTH labels. Under the current constraints (d<=6, fs>=4) D2/D3 cannot be fixed by moving the label off the wire or by shrinking it.',
  recommendation: [
    'Register D2 (attr111 / MCU-34 over pin number 31) and D3 (attr43 / MCU-26 flag name over PB10) as known defects. Do not relax d<=6, do not shrink below 4, do not move a label onto the neighbouring row.',
    'D3 has no geometric room at all (tallest gap 2.07 vs label 3.76). D2 has vertical room but every position that clears the digits mis-assigns the label - at the ink level going up, at the anchor level going down.',
    'The real fix is upstream and out of scope here: the row pitch is 10 units while the label ink is 3.76 and the pin numbers 4.36-4.85, so a label and a number cannot share a 10-unit row without touching. Either the pin-number placement rule or the row pitch has to change - a layout decision for the host, not a label tweak.'
  ],
  gates: {}
}

doc.gates = {
  readOnly: 'the two scripts behind this JSON (r5t4-d2d3-alt-scan.ps1, r5t4-d2d3-alt-verdict.mjs) contain no document-mutating call; checked by the committed gate, negative control included',
  wrote: 0,
  packagesAdded: 0,
  counts: 'before/after 21 components / 8 part / 13 netflag / 55 wires / 55 pairs / 2 pages (t53 PASS exit 0)'
}

fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n')
console.log('\nwritten ' + OUT)
console.log(`obj1: planA=${doc.planA.obj1.verdict} planB=${doc.planB.obj1.verdict}`)
console.log(`obj2: planA=${doc.planA.obj2.verdict} planB=${doc.planB.obj2.verdict}`)
console.log('overall: ' + doc.overall)
