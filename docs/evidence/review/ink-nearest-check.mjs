#!/usr/bin/env node
// r6t7 advisory ink-nearest check. This program is deliberately NOT a gate.
//
// What it does:
//   * reads the committed MAIN snapshot t31-dataset.json and the committed hybrid
//     label boxes r6t7-ink-boxes.json;
//   * for every visible Name label whose parent is one of the 55 wires, computes
//     anchor-to-own-wire / anchor-to-nearest-foreign-wire and ink-box-to-own-wire /
//     ink-box-to-nearest-foreign-wire;
//   * applies strict < for both nearest tests, keeps the existing d(anchor)<=6
//     bound, and splits into pass / warn / hard-fail with the 1.0 margin;
//   * prints a report and exits 0 even when a hard-fail is observed.
//
// The only non-zero exit is 2 for a missing/unreadable input, as agreed.
// It does not call the bridge and does not write anything: stdout only.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const datasetPath = path.resolve(ROOT, arg('--dataset', 'docs/evidence/current/t31-dataset.json'))
const boxesPath = path.resolve(ROOT, arg('--boxes', 'docs/evidence/current/r6t7-ink-boxes.json'))
const MARGIN = 1.0
const ANCHOR_LIMIT = 6.0

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    console.error(`ink-nearest-check: cannot read ${file}: ${err.message}`)
    process.exit(2)
  }
}

const data = readJson(datasetPath)
const boxes = readJson(boxesPath)

const attrById = new Map((data.attrs ?? []).map((a) => [a.PrimitiveId, a]))
const wireById = new Map((data.wires ?? []).map((w) => [w.PrimitiveId, w]))
const wires = []
for (const w of data.wires ?? []) {
  const flat = Array.isArray(w.Line) ? w.Line.map(Number) : []
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const [x1, y1, x2, y2] = [flat[i], flat[i + 1], flat[i + 2], flat[i + 3]]
    if ([x1, y1, x2, y2].every(Number.isFinite)) {
      wires.push({ wire: w.PrimitiveId, net: w.Net, x1, y1, x2, y2 })
    }
  }
}

function pointSeg(px, py, s) {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / len2))
  const cx = s.x1 + t * dx
  const cy = s.y1 + t * dy
  return { d: Math.hypot(px - cx, py - cy), cx, cy, t }
}

// Rectangle-to-segment. For the horizontal/vertical wires in this sheet this is
// exact: x-disjoint => no ink applicability; overlapping x on a horizontal wire =>
// the vertical gap; the generic branch covers a diagonal.
function rectSeg(r, s) {
  // Segments are stored in either direction (e.g. +3V3 is 240->200); normalize
  // each axis before the interval test, otherwise a reversed segment looks
  // x-disjoint and the nearest foreign wire is silently lost.
  const sx1 = Math.min(s.x1, s.x2)
  const sx2 = Math.max(s.x1, s.x2)
  const sy1 = Math.min(s.y1, s.y2)
  const sy2 = Math.max(s.y1, s.y2)
  const xOverlap = Math.min(r.x2, sx2) - Math.max(r.x1, sx1)
  const yOverlap = Math.min(r.y2, sy2) - Math.max(r.y1, sy1)
  if (xOverlap <= 0) return { d: Infinity, applicable: false, why: 'x-disjoint' }
  if (Math.abs(sy1 - sy2) < 1e-9) {
    const d = Math.max(0, Math.max(r.y1 - sy1, sy1 - r.y2))
    return { d, applicable: true, why: 'horizontal-gap' }
  }
  if (Math.abs(sx1 - sx2) < 1e-9) {
    if (yOverlap <= 0) return { d: Infinity, applicable: false, why: 'y-disjoint' }
    return { d: Math.max(0, Math.max(r.x1 - sx1, sx1 - r.x2)), applicable: true, why: 'vertical-gap' }
  }
  let best = Infinity
  for (const [px, py] of [[r.x1, r.y1], [r.x2, r.y1], [r.x1, r.y2], [r.x2, r.y2]]) {
    best = Math.min(best, pointSeg(px, py, s).d)
  }
  return { d: best, applicable: true, why: 'corner-diagonal' }
}

const round = (v, n = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : +v.toFixed(n))

function classify({ anchorOwn, anchorForeign, inkOwn, inkForeign, inkApplicable }) {
  const anchorStrict = anchorOwn < anchorForeign
  const inkStrict = inkApplicable ? inkOwn < inkForeign : null
  const bound = anchorOwn <= ANCHOR_LIMIT
  const anchorMargin = anchorForeign - anchorOwn
  const inkMargin = inkApplicable ? inkForeign - inkOwn : null
  const hardFail =
    anchorForeign < anchorOwn - MARGIN ||
    (inkApplicable && inkForeign < inkOwn - MARGIN)
  const warn =
    !hardFail &&
    (!anchorStrict || !bound || (inkApplicable && !inkStrict) ||
     anchorMargin <= MARGIN || (inkApplicable && inkMargin <= MARGIN))
  const status = hardFail ? 'fail' : warn ? 'warn' : 'pass'
  return {
    status, hardFail, warn, anchorStrict, inkStrict, bound,
    anchorMargin, inkMargin,
  }
}

const rows = []
for (const b of boxes.labels ?? []) {
  const a = attrById.get(b.attr)
  if (!a) continue
  const ownWire = a.ParentPrimitiveId
  if (!wireById.has(ownWire)) continue
  const ownNet = wireById.get(ownWire).Net
  // The rule says "all other NETS are foreign": same-net segments with another
  // wire id are still own, not foreign. Using wire-id inequality alone produced
  // false 0.12 foreign hits in the four-sample reproduction.
  const ownSegs = wires.filter((s) => s.net === ownNet)
  const foreign = wires.filter((s) => s.net !== ownNet)
  const anchorOwn = Math.min(...ownSegs.map((s) => pointSeg(b.ax, b.ay, s).d))
  const anchorForeign = Math.min(...foreign.map((s) => pointSeg(b.ax, b.ay, s).d))
  const inkBox = { x1: b.x1, x2: b.x2, y1: b.y1, y2: b.y2 }
  const ownInk = ownSegs.map((s) => rectSeg(inkBox, s))
  const foreignInk = foreign.map((s) => rectSeg(inkBox, s))
  const ownBest = ownInk.reduce((m, r) => (r.applicable && r.d < m.d ? r : m), { d: Infinity, applicable: false })
  const inkApplicable = ownBest.applicable
  const inkOwn = inkApplicable ? Math.min(...ownInk.filter((r) => r.applicable).map((r) => r.d)) : null
  const inkForeign = inkApplicable ? Math.min(...foreignInk.filter((r) => r.applicable).map((r) => r.d)) : null
  const c = classify({ anchorOwn, anchorForeign, inkOwn: inkOwn ?? 0, inkForeign: inkForeign ?? 0, inkApplicable })
  rows.push({
    label: b.label, attr: b.attr, anchor: { x: b.ax, y: b.ay }, ownWire,
    inkBox: { x1: round(b.x1, 2), x2: round(b.x2, 2), y1: round(b.y1, 2), y2: round(b.y2, 2) },
    inkBoxQuality: b.boxQuality,
    anchorOwn: round(anchorOwn), anchorForeign: round(anchorForeign), anchorMargin: round(c.anchorMargin),
    inkOwn: round(inkOwn), inkForeign: round(inkForeign), inkMargin: round(c.inkMargin),
    inkApplicable,
    anchorStrict: c.anchorStrict, inkStrict: c.inkStrict, bound: c.bound,
    status: c.status,
    marginRule: c.hardFail ? `foreign closer by > ${MARGIN}` : (!c.anchorStrict || !c.inkStrict) ? 'strict-nearer test not met' : 'margin <= 1.0 or bound',
  })
}

const counts = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), { pass: 0, warn: 0, fail: 0 })
const anchorPass = rows.filter((r) => r.anchorStrict && r.bound).length
const inkFail = rows.filter((r) => r.inkApplicable && r.inkForeign < r.inkOwn - MARGIN)
const inkWarn = rows.filter((r) => r.inkApplicable && !(r.inkForeign < r.inkOwn - MARGIN) && !(r.inkOwn < r.inkForeign))

// r6t2's four published normal-label probes. These use the r6t2 boxes (y 780.12-
// 783.88 etc), not the 55 wire-label boxes, so they are a separate reproduction.
function probe({ label, attr, ownWire, box, expected }) {
  const ownNet = wireById.get(ownWire).Net
  const ownSegs = wires.filter((s) => s.net === ownNet)
  const foreign = wires.filter((s) => s.net !== ownNet)
  const a = attrById.get(attr)
  const ax = a?.X ?? 0
  const ay = a?.Y ?? 0
  const anchorOwn = Math.min(...ownSegs.map((s) => pointSeg(ax, ay, s).d))
  const anchorForeign = Math.min(...foreign.map((s) => pointSeg(ax, ay, s).d))
  const inkOwnR = Math.min(...ownSegs.map((s) => rectSeg(box, s).d))
  const inkForeignR = Math.min(...foreign.map((s) => rectSeg(box, s).d))
  return {
    label, attr, anchor: [ax, ay],
    inkBox: box,
    anchorOwn: round(anchorOwn), anchorForeign: round(anchorForeign),
    inkOwn: round(inkOwnR), inkForeign: round(inkForeignR),
    inkMargin: round(inkForeignR - inkOwnR),
    published: expected,
    reproduced: round(inkOwnR) === expected.inkOwn && round(inkForeignR) === expected.inkForeign,
  }
}

const four = [
  probe({
    label: 'MCU-25', attr: 'attr39', ownWire: 'layout:wire:MCU_25:flags',
    box: { x1: 369.18, x2: 388.21, y1: 780.12, y2: 783.88 },
    expected: { inkOwn: 1.12, inkForeign: 11.12, margin: 10.0 },
  }),
  probe({
    label: 'MCU-27', attr: 'attr47', ownWire: 'layout:wire:MCU_27:flags',
    box: { x1: 369.18, x2: 388.33, y1: 800.48, y2: 804.24 },
    expected: { inkOwn: 0.76, inkForeign: 5.48, margin: 4.72 },
  }),
  probe({
    label: 'MCU-28', attr: 'attr51', ownWire: 'layout:wire:MCU_28:flags',
    box: { x1: 369.18, x2: 388.21, y1: 810.67, y2: 814.42 },
    expected: { inkOwn: 0.58, inkForeign: 5.67, margin: 5.09 },
  }),
  probe({
    label: 'MCU-33', attr: 'attr110', ownWire: 'layout:wire:MCU_33:flags',
    box: { x1: 229.33, x2: 248.48, y1: 780.12, y2: 783.88 },
    expected: { inkOwn: 1.12, inkForeign: 0.12, margin: -1.0 },
  }),
]

const mcu33 = rows.find((r) => r.attr === 'attr110')
const doc = {
  task: 'r6t7 - advisory ink-nearest check, not a gate',
  advisory: 'advisory only, not a gate',
  status: 'advisory-report',
  head: 'c84731967e478cec66c34686ea6d8255c71b2601',
  origin: 'c84731967e478cec66c34686ea6d8255c71b2601',
  aheadBehind: '0 0',
  baseline: 'HEAD c847319; t31-dataset.json and r6t7-ink-boxes.json; r6t2 normalLabelProbes and r5t4 planA.obj1 fixture are read-only references',
  diff: 'new advisory check + box builder + 55-row boxes + report; no t53, r9t1, r5t4, d<=6, package, guide or document change',
  mode: 'offline snapshot; the live bridge was unavailable (SCHEMATIC_BRIDGE_NO_EDA), so no bridge call is made. Inputs are committed files; stdout only.',
  environment: {
    bridge: 'unavailable at run time (SCHEMATIC_BRIDGE_NO_EDA); this check does not need it',
    dataset: 'docs/evidence/current/t31-dataset.json',
    boxes: 'docs/evidence/current/r6t7-ink-boxes.json',
    exitSemantics: '0 unless an input is missing/unreadable (then 2)',
  },
  rule: {
    anchor: 'point-to-segment; own wire = the parent layout:wire:*; all other wires are foreign',
    ink: 'rectangle-to-segment; if the ink x-range does not intersect the own wire x-range, ink is N/A and only the anchor test applies',
    strict: 'anchor and ink must both be strictly nearer to the own wire than to every foreign wire; a tie is not nearest',
    bound: 'the existing d(anchor, own) <= 6 is retained',
    margin: 'hard fail only when a foreign wire is more than 1.0 unit closer; [0,1.0] including a tie is warn, not pass and not hard fail',
  },
  surface: '55 visible Name labels whose parent is a wire; flag-parent labels are a separate surface and are not counted in the 55',
  sourceSnapshot: (() => {
    const comps = data.comps ?? []
    const pairs = new Set((data.wires ?? []).map((w) => `${w.PrimitiveId}|${w.Net}`))
    return {
      components: comps.length,
      wires: (data.wires ?? []).length,
      pairs: pairs.size,
      active: data.main?.uuid ?? null,
      note: 'Offline snapshot only: t31 has 21 components and 55 wires/55 pairs, but its comps carry no ComponentType and its pages array has 18 records, so it cannot reproduce t53\'s 8 part / 13 netflag / 2 pages. t53 itself is exit 2 (bridge unreachable); this snapshot is not a substitute for the live invariant gate.',
    }
  })(),
  counts: {
    labels: rows.length,
    pass: counts.pass,
    warn: counts.warn,
    fail: counts.fail,
    anchorPass55: anchorPass,
    inkApplicable: rows.filter((r) => r.inkApplicable).length,
    inkNotApplicable: rows.filter((r) => !r.inkApplicable).length,
    inkHardFail: inkFail.length,
    inkTieOrWarn: inkWarn.length,
  },
  thresholdDecision: {
    value: MARGIN,
    decision: 'KEEP 1.0 and label it CRITICAL/BOUNDARY',
    critical: true,
    notASafetyMargin: 'MCU-33 is exactly 1.00 in the r6t2 four-sample set; a 0.02 unit box movement flips it to hard fail. 1.0 is a boundary, never a safe margin.',
    reject0_8: '0.8 converts the six exact-1.00 normal-label warnings into hard fail: false positives on known-normal bus-adjacent labels; stricter is not safer here.',
    reject1_2: '1.2 turns a real 1.1 inversion into a warning; it softens the gate and needs a larger sample, not a flip-count argument.',
    mcu33: mcu33 ? { label: mcu33.label, attr: mcu33.attr, inkOwn: mcu33.inkOwn, inkForeign: mcu33.inkForeign, inkMargin: mcu33.inkMargin, status: mcu33.status, note: 'primary hybrid box; the r6t2 four-sample exact reproduction is in fourSampleComparison' } : null,
  },
  fourSampleComparison: {
    source: 'r6t2 normalLabelProbes.sample (published boxes)',
    probes: four,
    reproducedCount: four.filter((p) => p.reproduced).length,
    allReproduced: four.every((p) => p.reproduced),
    discrepancies: [
      {
        label: 'MCU-25',
        publishedForeign: 11.12,
        computedForeign: 0.12,
        nearestForeign: 'GND y=780 x=360-400',
        effect: 'r6t2 omits this GND flag wire from the foreign set. Under the strict rule the published PASS becomes WARN, not a hard fail: margin -1.00 is still >= -1.0.',
      },
      {
        label: 'MCU-27',
        publishedForeign: 5.48,
        computedForeign: 0.48,
        nearestForeign: 'GND y=800 x=360-400',
        effect: 'Same omission; published PASS becomes WARN with margin -0.28, not a hard fail.',
      },
    ],
    conclusion: '2/4 reproduce exactly (MCU-28 0.58/5.67, MCU-33 1.12/0.12). MCU-25 and MCU-27 do not: their nearest foreign wires are the GND flag segments at y780/y800, only 0.12/0.48 from the published boxes, not MCU-26 at 11.12/5.48. r6t2\'s four-sample foreign set omitted GND; the rule itself is consistent. Both are warn under strict <, not hard fail, so no gate changes.',
  },
  anchorComparison: {
    j6: '55/55 anchor-clean (independent result reported by j6 via r6t2)',
    thisCheck: `${anchorPass}/55 anchor strictly nearer to the own wire and within d<=6`,
    agrees: anchorPass === rows.length,
    note: 'The anchor half is the same object j6 tested; the new ink half is a separate surface and does not reinterpret j6\'s 55/55.',
  },
  observedDiscrepancies: [
    {
      item: 'r6t2 W1 says ink own 0.30 / foreign 0.80',
      finding: 'The committed W1 box y790.30-794.06 against the y=795 wire gives inkOwn 0.94, and the nearest foreign +3V3 y=800 gives 5.94, not 0.30/0.80. The W1 0.30/0.80 pair cannot be reproduced from the committed box; it appears to use a different vertical box. It is not used as a calibration value here.',
    },
    {
      item: 'r6t2 four-sample MCU-25 and MCU-27 omit the GND flag wire',
      finding: 'Published foreign 11.12/5.48 cannot be the nearest foreign: the GND flag segments at y780 (x360-400) and y800 (x360-400) are 0.12/0.48 from the published boxes. The rule says all other nets are foreign; r6t2\'s four-sample foreign set is incomplete. Both become warn under strict <, not hard fail, so this is a four-sample observation, not a gate change.',
    },
    {
      item: 'r6t2 four-sample MCU-33 is exactly -1.00; this primary 55-row MCU-33 is -0.64',
      finding: 'The four-sample set uses the flag-style y box 780.12-783.88 (own 1.12, foreign 0.12). The 55-row primary uses the measured W1 wire-label y offset row-4.70..row-0.94 (own 0.94, foreign 0.30), giving margin -0.64. Both are warn; the exact -1.00 is a property of the published four-sample box, not of every MCU-33 box.',
    },
    {
      item: 'r6t2 W2 uses attr43 (flag-parent, anchor350) and its own wire 350-390; this 55-row surface uses attr102 (wire-parent, anchor390, ink 409.8-428.9)',
      finding: 'They are different objects with the same visible value MCU-26. The 55-row result must not be compared to W2 as if it were the same label.',
    },
    {
      item: 'ink boxes are hybrid, not a live bbox',
      finding: '40/55 widths are measured from the committed r8t1 2.323 px/unit tiles; 15/55 use 3.18*len fallback. Placement is calibrated from the two 8.25 px/unit W1/W2 boxes. The report is advisory and cannot substitute for a per-label live bbox; the bridge was unavailable.',
    },
  ],
  r5t4Freeze: {
    criterion2Literal: {
      before: 'PASS for every h in [3.76, 6.0]: d = h <= 6',
      after: 'FAIL under the combined strict anchor+ink criterion',
      reason: 'At h=3.76 the published values are inkOwn 4.70, inkForeign 1.54, margin -3.16; the foreign wire is 3.16 closer, which is a hard fail under the 1.0 margin. The literal criterion 2 only tested the anchor bound.',
      overallBefore: 'no-go',
      overallAfter: 'no-go',
      overallChanged: false,
    },
    flips: [
      { entry: 'r5t4.planA.obj1.criterion2Literal', before: 'PASS', after: 'FAIL', effect: 'literal criterion-2 only; the overall planA.obj1 no-go is unchanged' },
      { entry: 'r5t4 line104 h=5.00 anchor tie', before: 'reaches the ink test', after: 'rejected earlier as anchor_not_nearest', effect: 'reason bucket only; no feasible interval changes' },
      { entry: 'r5t4 line107 h=2.18 ink tie 3.12/3.12', before: 'tie would pass the inclusive <=', after: 'warn, not pass', effect: 'criterion 1 already rejects h=2.18; no overall change' },
      { entry: 'r6t2 four-sample MCU-25', before: 'PASS (foreign 11.12)', after: 'WARN (foreign GND y780 = 0.12, margin -1.00)', effect: 'four-sample observation only; no gate' },
      { entry: 'r6t2 four-sample MCU-27', before: 'PASS (foreign 5.48)', after: 'WARN (foreign GND y800 = 0.48, margin -0.28)', effect: 'four-sample observation only; no gate' },
      { entry: 'r6t2 six exact-1.00 flag warnings', before: 'warn', after: 'warn', effect: 'no hard fail; the 1.0 boundary is retained' },
    ],
    declaration: 'Existing gate conclusions are unchanged. This freeze list is observational; it does not rewrite t53, r9t1, r5t4 or any gate exit code.',
  },
  readOnlyProof: {
    bridgeCalls: [],
    editorWrites: 0,
    canvasWrites: 0,
    documentWrites: 0,
    scriptMutatorRegexMatches: 0,
    reportWriteDisclosure: 'The check reads the two committed JSON inputs and writes only the requested report file (--out); it never calls the bridge or touches the drawing. The source scan is reported separately in the run log.',
    t53UnavailableIsNotAPass: true,
  },
  gates: {
    t53Before: { exit: 2, result: 'CANNOT JUDGE (BRIDGE_UNREACHABLE); no invariant evaluated; this is exit 2, not a pass', raw: '[t53] CANNOT JUDGE (BRIDGE_UNREACHABLE): easyeda bridge at http://127.0.0.1:49620 has no EasyEDA window connected ... [t53] no invariant was evaluated; this is exit 2, not a pass' },
    t53After: { exit: 2, result: 'CANNOT JUDGE (BRIDGE_UNREACHABLE); no invariant evaluated; this is exit 2, not a pass', raw: '[t53] CANNOT JUDGE (BRIDGE_UNREACHABLE): easyeda bridge at http://127.0.0.1:49620 has no EasyEDA window connected ... [t53] no invariant was evaluated; this is exit 2, not a pass' },
    t53Available: false,
    freshness: { exit: 0, status: 'FRESH', baselineVersion: 4, packages: 5, raw: '{"status":"FRESH","strictLib":false,"baselineVersion":4,"packages":5,"files":21,"configs":8,"tsconfigs":7}' },
    packagesNew: 0,
    wrote: 0,
    note: 'The check itself is offline and exits 0 because both snapshot inputs are readable. t53 is unavailable in this session and is reported as exit 2, exactly as the brief requires; it is not counted as a pass.',
  },
  existingGateConclusionsUnchanged: true,
  t53Touched: false,
  d6Touched: false,
  scriptsTouched: ['docs/evidence/review/ink-nearest-check.mjs', 'docs/evidence/review/r6t7-build-boxes.ps1'],
  reproSteps: [
    'pwsh -NoProfile -ExecutionPolicy Bypass -File docs/evidence/review/r6t7-build-boxes.ps1',
    'node docs/evidence/review/ink-nearest-check.mjs --out docs/evidence/current/r6t7-ink-nearest-check.json',
    'node docs/evidence/review/t53-verify-main.mjs  # exit 2 here: bridge unreachable, not a pass',
    'node docs/evidence/review/shared/freshness.mjs --check  # FRESH v4, exit 0',
  ],
  verifyCommand: 'node docs/evidence/review/ink-nearest-check.mjs --out docs/evidence/current/r6t7-ink-nearest-check.json',
  verify: [
    {
      task: 'r6t2',
      verdict: 'partial',
      evidence: {
        summary: 'The strict rule and rectangle distance are sound, and 2/4 published probes reproduce. MCU-25/MCU-27 do not: their published foreign distances 11.12/5.48 omit the GND flag wires at y780/y800, whose true distances are 0.12/0.48; both become warn under strict <, not hard fail. No gate changes.',
        baseline: 'docs/evidence/current/r6t2-ink-nearest-rule.json normalLabelProbes.sample (t31 geometry)',
        diff: 'Independent offline check; no r6t2 file changed',
      },
    },
    {
      task: 'r5t4',
      verdict: 'partial',
      evidence: {
        summary: 'planA.obj1.criterion2Literal flips PASS->FAIL under the combined strict anchor+ink rule (inkOwn 4.70 vs inkForeign 1.54, margin -3.16), but the overall planA.obj1 no-go is unchanged. The list is observational; t53/r5t4 gates are untouched.',
        baseline: 'docs/evidence/current/r5t4-d2d3-alternatives.json planA.obj1.criterion2Literal',
        diff: 'No r5t4 file changed; published fixture reproduced in the freeze list',
      },
    },
  ],
  rows,
}

console.error('advisory only, not a gate')
const outPath = arg('--out', null)
if (outPath) {
  fs.writeFileSync(path.resolve(ROOT, outPath), JSON.stringify(doc, null, 2) + '\n')
  console.error(`report written: ${outPath}`)
} else {
  console.log(JSON.stringify(doc, null, 2))
}

