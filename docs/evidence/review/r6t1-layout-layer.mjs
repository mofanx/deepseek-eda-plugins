// r6t1: layout-layer feasibility - READ ONLY.
//
// Question: is there a single offset constant in this repo that decides where a pin number
// (e.g. "31") and a net-flag name (e.g. attr43 "MCU-26") are drawn vertically, and if so can it
// be changed safely?
//
// Method: read the live page through the bridge (getAll / getCurrent* only - no create, no
// modify, no save), then derive the offsets arithmetically. Nothing is written to the document;
// the only file this script writes is the evidence JSON it is here to produce.
//
// Run from the repo root:
//   node docs/evidence/review/r6t1-layout-layer.mjs
//
// Note on the exit path: the bridge keeps a keep-alive socket, and Node's teardown can trip a
// libuv assertion on Windows after the work is done. The JSON is flushed before that, so the
// artifact is authoritative; the exit code is reported as-is rather than massaged.
//
// r2t1 revision (after r6t4 review, commit ee0fe70):
//   (1) the flag denominator is now the 13 netflag COMPONENTS (componentType === 'netflag'), not
//       the 14 flag-like Name attrs; the 14th belongs to a `part` (+3V3 bus), and GND is the
//       netflag that is not on a pin row -> 12/13.
//   (2) the safe-offset block now reports both directions: min up 4.37, min down 3.76, global
//       min 3.76 (downward), with the side effect of each.
//   (3) the upper bound now names both 6.42 (fixed MCU-33 label) and 5.82 (the moving pin-number
//       32), and states which one is adopted and why.
//   (4) the rollback question is answered instead of deferred.
// The no-go decision is unchanged.
import { writeFileSync } from 'node:fs'
import { HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'

const OUT = 'docs/evidence/current/r6t1-layout-layer-feasibility.json'

const probe = `
const attrs = (await eda.sch_PrimitiveAttribute.getAll()) || [];
const pages = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [];
const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const rows = attrs.map(a => ({
  key: a.key, value: a.value, x: a.x, y: a.y,
  parent: a.parentPrimitiveId ?? a.parent ?? null,
  visible: a.valueVisible === undefined ? null : a.valueVisible !== false,
}));
let components = [];
try {
  const all = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
  components = all.map(c => ({ id: String(c.primitiveId || c.id || ''), type: String(c.componentType || ''),
    designator: c.designator ?? null, x: c.x, y: c.y }));
} catch (e) {}
return { page: { uuid: page && page.uuid, name: page && page.name }, pages: pages.length, rows, components };
`

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const live = await bridge.execute(probe, { timeoutMs: 60_000 })

const rows = live.rows
const comps = live.components
const compById = new Map(comps.map(c => [c.id, c]))
const num = (v) => typeof v === 'number' && Number.isFinite(v)

const byKey = {}
for (const r of rows) byKey[r.key] = (byKey[r.key] ?? 0) + 1

const pinNumbers = rows.filter(r => r.key === 'Pin Number' && num(r.y))
const pinNames = rows.filter(r => r.key === 'Pin Name' && num(r.y))
const pinTypes = rows.filter(r => r.key === 'Pin Type')
const nameByname = new Map(pinNames.map(r => [r.parent ?? `${r.x},${r.y}`, r]))

// pair each pin number with its pin name by parent id
const pairs = []
for (const n of pinNumbers) {
  const nm = nameByname.get(n.parent)
  if (nm && num(nm.y)) pairs.push({ parent: n.parent, number: n.value, numberY: n.y, nameY: nm.y, delta: +(nm.y - n.y).toFixed(5) })
}

// the horizontal-pin case is the one that matters for "31": name sits exactly 4 above number
const horizontal = pairs.filter(p => Math.abs(p.delta + 4) < 1e-6)
const deltas = {}
for (const p of pairs) deltas[p.delta] = (deltas[p.delta] ?? 0) + 1

// offset from the pin row: for horizontal pins rowY = numberY + 0.91498
const OFFSET = 0.91498
const horizontalRows = [...new Set(horizontal.map(p => +(p.numberY + OFFSET).toFixed(5)))].sort((a, b) => a - b)
const rowGrid = horizontalRows.every(y => Math.abs(y / 5 - Math.round(y / 5)) < 1e-6)

const flagNames = rows.filter(r => r.key === 'Name' && String(r.parent ?? '').startsWith('layout:flag') && num(r.y))
const wireNames = rows.filter(r => r.key === 'Name' && String(r.parent ?? '').startsWith('layout:wire') && num(r.y))

// The denominator is the netflag COMPONENT count (what t53 checks), not the Name-attr count:
// the +3V3 bus carries a Name attr but its component is a `part`.
const netflagComps = comps.filter(c => c.type === 'netflag')
const netflagRows = flagNames
  .map(f => {
    const c = compById.get(f.parent)
    return { net: f.value, parent: f.parent, x: f.x, y: f.y, componentType: c?.type ?? 'MISSING', isNetflag: c?.type === 'netflag' }
  })
const netflagOnly = netflagRows.filter(r => r.isNetflag)
const nonNetflagNames = netflagRows.filter(r => !r.isNetflag)

const pinRows = [...new Set(pinNumbers.map(p => +(p.y + OFFSET).toFixed(2)))].sort((a, b) => a - b)
const onPinRow = (y) => pinRows.some(py => Math.abs(py - y) < 0.6)
for (const r of netflagRows) r.onPinRow = onPinRow(r.y)

// separation arithmetic for the measured pair (pixels, 8.25 px/unit frames)
const LABEL = { y1: 790.30, y2: 794.06 }        // attr111 blue ink (x 229.33-248.48)
const PRESS = { y1: 790.30, y2: 794.67 }        // pressed black band
const MCU33_LABEL = { y1: 780.12, y2: 783.88 }  // fixed: MCU-33 blue label, same x column
const PIN32 = { y1: 779.64, y2: 784.48 }        // moves with the other 69 pin numbers
const ROW805_LABEL_TOP = 800.48                 // fixed: next row's blue label
const PLUS3V3_RUN = 800                         // fixed: +3V3 horizontal run below

const minUp = +(PRESS.y2 - LABEL.y1).toFixed(2)            // lift until the band clears the label top
const maxUpFixed = +(LABEL.y1 - MCU33_LABEL.y2).toFixed(2) // before it reaches the fixed MCU-33 label
const maxUpMoving = +(LABEL.y1 - PIN32.y2).toFixed(2)      // conservative: treats pin 32 as fixed
const minDown = +(LABEL.y2 - PRESS.y1).toFixed(2)          // push until the band clears the label bottom
const maxDown = +(ROW805_LABEL_TOP - PRESS.y2).toFixed(2)  // before it reaches the next row's label
const distUpMinToMcu33Wire = +((PRESS.y1 - minUp) - 785).toFixed(2)   // how close the band gets to MCU-33's wire
const distDownMinTo3v3 = +((PRESS.y2 + minDown) - PLUS3V3_RUN).toFixed(2)

const doc = {
  task: 'r6t1 - layout-layer feasibility: can one offset constant separate the pin number from the net label?',
  mode: 'read-only. No document write, no canvas write, no save. The only file written is this JSON.',
  date: '2026-10-24',
  revision: 'r2t1 - accounting corrections after r6t4 (commit ee0fe70); decision unchanged',
  liveRead: { page: live.page, pages: live.pages, attributes: rows.length, components: comps.length },
  verdict: null,
  answers: {},
  counts: {},
  arithmetic: {},
  evidence: {},
  gates: {}
}

doc.counts = {
  attributesTotal: rows.length,
  byKey,
  components: comps.length,
  componentTypes: comps.reduce((o, c) => { o[c.type] = (o[c.type] ?? 0) + 1; return o }, {}),
  pinNumberClass: pinNumbers.length,
  pinNumberVisible: pinNumbers.filter(r => r.visible === true).length,
  pinNumberHidden: pinNumbers.filter(r => r.visible === false).length,
  pinNumberVisibilityUnknown: pinNumbers.filter(r => r.visible === null).length,
  pinNumberParents: new Set(pinNumbers.map(r => r.parent)).size,
  pinNameClass: pinNames.length,
  pinTypeClass: pinTypes.length,
  pinTypeVisible: pinTypes.filter(r => r.visible === true).length,
  flagLikeNameAttrs: flagNames.length,
  netflagComponents: netflagComps.length,
  netflagsOnPinRows: netflagOnly.filter(r => r.onPinRow).length,
  netflagsOffPinRows: netflagOnly.filter(r => !r.onPinRow).map(r => r.net),
  netflagDenominator: netflagOnly.length,
  nonNetflagNameAttrs: nonNetflagNames.map(r => ({ net: r.net, componentType: r.componentType, at: [r.x, r.y] })),
  wireLabelNameAttrs: wireNames.length
}

doc.counts.netflagRows = netflagRows
// the 13 that count, one row each, so the "on/off a pin row" split can be read directly
doc.counts.netflagTable = netflagOnly.map(r => ({ net: r.net, x: r.x, y: r.y, onPinRow: r.onPinRow }))

doc.arithmetic = {
  horizontalPins: horizontal.length,
  nameMinusNumberDelta: deltas,
  offsetFromPinRow: -OFFSET,
  horizontalRows,
  rowsOnFiveUnitGrid: rowGrid,
  note: 'the -0.91498 offset holds for all horizontal pins; the name-to-number delta is NOT a single value (-4 / -5 / 0 / +0.5 appear), so there is no one constant that covers every pin',
  bands: {
    label: LABEL,
    pressed: PRESS,
    mcu33LabelFixed: MCU33_LABEL,
    pin32Moving: PIN32,
    row805LabelTopFixed: ROW805_LABEL_TOP,
    plus3v3RunFixed: PLUS3V3_RUN
  }
}

doc.evidence.pinNumberPlacement = {
  inRepo: false,
  why: [
    'packages/schematic-easyeda/src/build.ts:393 - a placed part is adjusted with designator only: modify(placed, { designator })',
    'packages/schematic-easyeda/src/build.ts:427 - the ONLY attribute mutation in the tree: modify(attr, { fontSize: labelFontSize / 100 }), font size only, never x/y',
    'packages/eda-core/src/library.ts:107-117 - parseSymbolPins reads PIN x/y and negates y for API space; the Pin Number/Pin Name ATTR coordinates are read for key/value only and never used for placement',
    'grep for sch_PrimitiveAttribute.(create|modify|delete|getAll) over packages: 6 hits, all listed above or in tests'
  ],
  conclusion: 'the pin number y is a property of the vendor symbol document (C23922), rendered by the client relative to the pin; this repo never writes it'
}

doc.evidence.flagNamePlacement = {
  inRepo: 'partly - the flag component position, not the label offset',
  why: [
    'packages/schematic-easyeda/src/build.ts:398 - createNetFlag(identification, netName, c.x, c.y, rotation, mirror): we supply the component position',
    'packages/schematic-easyeda/src/build.ts:340 - comment: "The flag/port device draws its `Name` attr"',
    'packages/schematic/src/layout.ts:1858-1924 - flagPosition is computed per flag and passed as the component position'
  ],
  conclusion: 'the flag name shares the flag component position; moving it means moving the flag (and its stub/wire), one flag at a time'
}

doc.answers = {
  one: 'No such shared constant exists. The pin number y comes from the vendor symbol document; the flag name y comes from the flag component position computed in layout.ts. They are not the same lever, so changing one cannot fix both.',
  two: 'Not configurable. There is no y-offset parameter: the only in-repo knobs are the flag component position and netLabelFontSize (font size only). The pin number offset is hardcoded in the library symbol.',
  twoOffset: {
    premiseCorrection: 'the task states "any non-zero offset separates them" - that is false: the two ink boxes share their top edge (790.30), so a small shift leaves them overlapping',
    up: {
      min: minUp,
      max: maxUpFixed,
      maxConservative: maxUpMoving,
      meaning: 'lift the band until its bottom clears the label top; the bound is the fixed MCU-33 label bottom 783.88',
      sideEffect: 'moves toward MCU-33: at the 4.37 minimum the band sits ' + distUpMinToMcu33Wire + ' units above MCU-33\'s wire (785)'
    },
    down: {
      min: minDown,
      max: maxDown,
      meaning: 'push the band below the label bottom; the bound is the next row\'s label top 800.48',
      sideEffect: 'moves toward +3V3: at the 3.76 minimum the band bottom is ' + distDownMinTo3v3 + ' units above the +3V3 run (800)'
    },
    minimumSafe: minUp,
    globalMinimum: minDown,
    globalMinimumDirection: 'down',
    windowWidthUp: +(maxUpFixed - minUp).toFixed(2),
    upperBoundChoice: {
      adopted: maxUpFixed,
      adoptedWhy: 'the fixed obstacle is MCU-33\'s blue label (x 229.33-248.48, bottom 783.88), because it does not move when the pin numbers do; 6.42 is the true bound under the "all 70 move" premise',
      conservative: maxUpMoving,
      conservativeWhy: '5.82 comes from the black band ending at 784.48, which is the moving pin-number 32, not a fixed obstacle; using it is safe but understates the window by 0.60',
      rejected: 'PA11 measures x 252.85-269.33 in the same frame, x-disjoint from the pressed column x 232-244, so it cannot bound the shift even though its ink sits at y 776-778'
    },
    downCaveat: 'the "3.76 downward" figure is the minimum for moving THIS number. Under the document\'s own "one symbol-level offset moves all 70" premise, 3.76 also pushes the neighbour pin-30 band (799.88-804.73) deeper into the fixed row-805 label (800.48-804.24), where it already overlaps; so downward is the smaller number but not a page-level improvement. Adopted value remains 4.37 upward.'
  },
  three: 'A symbol-level change would move all 70 pin-number attributes at once (45 visible; one edit, but in the library, and for every project using C23922). The flag route instead moves 12 of the 13 netflag components individually (the "thirteen edits" case), and each move drags its stub and wire with it. The +3V3 bus is a `part`, not a netflag, so it is outside that denominator; GND is a netflag but sits off the pin rows at (400,840).',
  four: 'There is no constant to restore, so "put the original constant back" does not apply. What restoring would actually require: (a) if the flag route was used, move the same flags back and save, then cold-read; but reopening a document re-mints the 13 netflag instance ids, so a byte-identical comparison only holds within the same session - across a reopen you can compare geometry and net names, not ids; (b) if the symbol route was used, the only restore is reverting the symbol document itself, which this repo does not own and cannot address from here; a project-local copy may exist but the original museum copy is unreachable. Minimum snapshots to keep before any attempt: (1) the page document source (or a .epro2 project export) covering all 13 netflags plus the 70 pin-number attrs, (2) the C23922 symbol document source as it is today, (3) the cold-read invariant JSON (21 components / 8 part + 13 netflag / 55 wires / 55 name pairs / 2 pages / MAIN uuid b275cd23e45c4271bead56f66d4f98fe) so "nothing else moved" can be shown after the restore. Without all three, a rollback cannot be verified - only asserted.',
  five: 'no-go'
}

doc.corrections = {
  source: 'r6t4-review-layout-feasibility.json (j5), commit ee0fe70, overall partial, no-go unchanged',
  items: [
    {
      id: 'netflag-denominator',
      was: '12 of the 14 flag-like Name attrs on pin rows',
      now: '12 of the 13 netflag components on pin rows',
      why: 'the 14th Name attr belongs to the +3V3 bus component whose componentType is part, not netflag; t53 counts netflag by componentType, so 13 is the correct denominator',
      verified: 'live probe: componentTypes {part:8, netflag:13}; +3V3 parent layout:flag:_3V3:bus:240 maps to a part'
    },
    {
      id: 'minimum-safe-offset',
      was: '4.37 as the minimum safe offset',
      now: 'min up 4.37, min down 3.76, global min 3.76 (downward), with side effects',
      why: 'clearing the label downward needs only 794.06-790.30 = 3.76, which is smaller than the upward 4.37'
    },
    {
      id: 'upper-bound-attribution',
      was: '5.82 as the bound, from the 780.12-784.48 band',
      now: '6.42 against the fixed MCU-33 label; 5.82 only if the moving pin 32 is treated as fixed',
      why: '780.12-784.48 is an envelope of fixed MCU-33 blue (bottom 783.88) and moving pin-number 32 (bottom 784.48); under the all-70-move premise pin 32 moves, so 6.42 is the true bound; PA11 is x-disjoint'
    },
    {
      id: 'rollback',
      was: 'one sentence saying a constant restore is not available',
      now: 'a full answer: no constant, session-scoped id stability, symbol revert path, and the three snapshots required',
      why: 'the original task asked for a rollback assessment and the sentence deferred it'
    }
  ]
}

doc.verdict = {
  decision: 'no-go',
  unchanged: true,
  reasons: [
    'no single offset constant exists in the repo, so premise (1) of the task fails on the facts',
    'the pin number y is owned by the vendor symbol (hardcoded, orientation-dependent: deltas -4/-5/0/+0.5), so changing it is a symbol rebuild',
    'the only in-repo lever for the flag name is the flag component position, which is the "thirteen edits" case the standing rules already reject',
    'a symbol-level edit would change all 70 pin-number attributes on this page (45 visible) and any other project bound to the same library symbol'
  ],
  whatWouldWork: 'if the host ever gains a symbol-level lever, the safe window is a uniform lift of 4.37-6.42 units (below 4.37 the number stays inside the label, above 6.42 it reaches MCU-33\'s fixed label at 783.88); downward 3.76-5.81 also clears this label but deepens a neighbour overlap, so upward is the usable direction',
  doNot: 'do not edit the library symbol in place, do not rebuild the symbol, do not move 12 flags one by one, do not shrink the font (already no-go at 3.81/2.85)'
}

doc.reproduce = [
  'node docs/evidence/review/r6t1-layout-layer.mjs  # reads the live page, rewrites this JSON',
  'node docs/evidence/review/r2t1-netflag-count.mjs  # maps the 14 flag-like Names to componentType: +3V3 is a part',
  'node docs/evidence/review/t53-verify-main.mjs  # 21 components / 8 part + 13 netflag / 55 wires / 55 names / 2 pages',
  'node docs/evidence/review/shared/freshness.mjs --check  # FRESH v4, packages 5',
  'grep -n "sch_PrimitiveAttribute" packages/schematic-easyeda/src/build.ts  # 418 getAll, 427 modify fontSize only',
  'grep -n "createNetFlag" packages/schematic-easyeda/src/build.ts  # 398, position supplied by the IR'
]

doc.evidence.sourceQuotes = [
  {
    file: 'packages/schematic-easyeda/src/build.ts',
    line: 340,
    text: '// The flag/port device draws its \\`Name\\` attr; \\`Global Net Name\\` is hidden',
    meaning: 'the flag name is drawn by the device, not positioned by us'
  },
  {
    file: 'packages/schematic-easyeda/src/build.ts',
    line: 393,
    text: 'if (c.designator !== undefined) await eda.sch_PrimitiveComponent.modify(placed, { designator: c.designator });',
    meaning: 'a placed part is only adjusted by designator; pin number/name are never touched'
  },
  {
    file: 'packages/schematic-easyeda/src/build.ts',
    line: 398,
    text: 'placed = await placeOnce(() => eda.sch_PrimitiveComponent.createNetFlag(identification, c.netName, c.x, c.y, c.rotation, c.mirror));',
    meaning: 'we supply the flag position (c.x, c.y); the label offset is the device default'
  },
  {
    file: 'packages/schematic-easyeda/src/build.ts',
    line: 427,
    text: 'try { await eda.sch_PrimitiveAttribute.modify(attr, { fontSize: labelFontSize / 100 }) } catch (e) {',
    meaning: 'the only attribute mutation in the tree: font size, never x/y'
  },
  {
    file: 'packages/eda-core/src/library.ts',
    line: 117,
    text: 'pins.push({ number, ...name === undefined ? {} : { name }, x, y: -y })',
    meaning: 'only the PIN coordinates are carried (y negated for API space); the Pin Number/Pin Name ATTR coordinates are dropped'
  }
]

doc.gates.mainInvariants = {
  command: 'node docs/evidence/review/t53-verify-main.mjs',
  exitCode: 0,
  components: 21,
  parts: 8,
  netflags: 13,
  wires: 55,
  netNamePairs: 55,
  pages: 2,
  mainUuid: 'b275cd23e45c4271bead56f66d4f98fe',
  note: 't53 reports no hex counter; the "0 hex" item in the task has no corresponding field in this gate'
}

doc.gates.freshness = {
  command: 'node docs/evidence/review/shared/freshness.mjs --check',
  exitCode: 0,
  status: 'FRESH',
  baselineVersion: 4,
  packages: 5
}

doc.gates.reproducibility = {
  checkedBefore: 'MAIN b275cd23e45c4271bead56f66d4f98fe, 21 components, 8 part + 13 netflag, 55 wires, 55 name pairs, 2 pages',
  checkedAfter: 'identical (t53 exit 0 after the read-only run)',
  documentWrites: 0
}

doc.gates.pushState = {
  note: 'r2t1 resolved the reported divergence: HEAD, origin/master and the ahead/behind count were read with raw output at the start of this task',
  head: 'ee0fe70eabc7ab4022a1c32ed5e35d5156e9523e',
  origin: 'ee0fe70eabc7ab4022a1c32ed5e35d5156e9523e',
  revListLeftRight: '0 0',
  reading: 'j6 was right (ee0fe70 is pushed); j5\'s "origin d7acac3, ahead 2" was taken before that push completed and is stale, not a conflict in the repository'
}

writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n')
console.log('written ' + OUT)
console.log('verdict: ' + doc.verdict.decision)
console.log('pin numbers: ' + doc.counts.pinNumberClass + ' (visible ' + doc.counts.pinNumberVisible + ')')
console.log('netflags: ' + doc.counts.netflagComponents + ', on pin rows: ' + doc.counts.netflagsOnPinRows + '/' + doc.counts.netflagDenominator + ', off: ' + doc.counts.netflagsOffPinRows.join(','))
console.log('non-netflag Name attrs: ' + JSON.stringify(doc.counts.nonNetflagNameAttrs))
console.log('deltas: ' + JSON.stringify(deltas))
console.log('offset from pin row: ' + (-OFFSET) + ' rows on grid: ' + rowGrid)
console.log('up: ' + minUp + '..' + maxUpFixed + ' (conservative ' + maxUpMoving + '), down: ' + minDown + '..' + maxDown)
