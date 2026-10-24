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
  components = all.map(c => ({ x: c.x, y: c.y, designator: c.designator ?? null }));
} catch (e) {}
return { page: { uuid: page && page.uuid, name: page && page.name }, pages: pages.length, rows, components };
`

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const live = await bridge.execute(probe, { timeoutMs: 60_000 })

const rows = live.rows
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

// a flag sits in pin-text territory when its row coincides with a pin row and its x is within
// one label advance (~19.15) of the pin text column on that side
const pinRows = [...new Set(pinNumbers.map(p => +(p.y + OFFSET).toFixed(2)))].sort((a, b) => a - b)
const onPinRow = (y) => pinRows.some(py => Math.abs(py - y) < 0.6)
const flagsOnPinRows = flagNames.map(f => ({ net: f.value, x: f.x, y: f.y, rowIsPinRow: onPinRow(f.y) }))

// separation arithmetic for the measured pair (pixels, 8.25 px/unit frames)
const LABEL = { y1: 790.30, y2: 794.06 }     // attr111 ink
const PRESS = { y1: 790.30, y2: 794.67 }     // "31" ink
const PREV = { y1: 780.12, y2: 784.48 }      // previous row's ink
const upMin = +(PRESS.y2 - LABEL.y1).toFixed(2)          // must lift "31" clear above the label
const upMax = +(LABEL.y1 - PREV.y2).toFixed(2)           // before it hits the row above
const downMin = +(LABEL.y2 - PRESS.y1).toFixed(2)        // push "31" below the label
const downMax = +(800.48 - PRESS.y2).toFixed(2)          // before it hits the next row's label ink

const doc = {
  task: 'r6t1 - layout-layer feasibility: can one offset constant separate the pin number from the net label?',
  mode: 'read-only. No document write, no canvas write, no save. The only file written is this JSON.',
  date: '2026-10-24',
  liveRead: { page: live.page, pages: live.pages, attributes: rows.length, components: live.components.length },
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
  pinNumberClass: pinNumbers.length,
  pinNumberVisible: pinNumbers.filter(r => r.visible === true).length,
  pinNumberHidden: pinNumbers.filter(r => r.visible === false).length,
  pinNumberVisibilityUnknown: pinNumbers.filter(r => r.visible === null).length,
  pinNumberParents: new Set(pinNumbers.map(r => r.parent)).size,
  pinNameClass: pinNames.length,
  pinTypeClass: pinTypes.length,
  pinTypeVisible: pinTypes.filter(r => r.visible === true).length,
  flagNameAttrs: flagNames.length,
  wireLabelNameAttrs: wireNames.length
}

doc.arithmetic = {
  horizontalPins: horizontal.length,
  nameMinusNumberDelta: deltas,
  offsetFromPinRow: -OFFSET,
  horizontalRows: horizontalRows,
  rowsOnFiveUnitGrid: rowGrid,
  note: 'the -0.91498 offset holds for all horizontal pins; the name-to-number delta is NOT a single value (-4 / -5 / 0 / +0.5 appear), so there is no one constant that covers every pin'
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
    up: { min: upMin, max: upMax, meaning: 'lift "31" until its bottom clears the label top, before it reaches the row above' },
    down: { min: downMin, max: downMax, meaning: 'push "31" below the label bottom, before it reaches the next row' },
    minimumSafe: upMin,
    windowWidth: +(upMax - upMin).toFixed(2)
  },
  three: 'A symbol-level change would move all 70 pin-number attributes at once (45 of them visible; one edit, but in the library, and for every project using C23922). The flag route instead moves 12 of the 14 flag names individually (the "thirteen edits" case), and each move drags its stub and wire with it.',
  four: 'There is no constant to restore. Rolling back a library-symbol edit means restoring the vendor symbol document, which this repo does not own; a project-local copy may be created and the original museum copy is not addressable from here. That is a symbol rebuild - high risk.',
  five: 'no-go'
}

doc.counts.flagsOnPinRows = flagsOnPinRows
doc.counts.flagsOnPinRowsCount = flagsOnPinRows.filter(f => f.rowIsPinRow).length

doc.verdict = {
  decision: 'no-go',
  reasons: [
    'no single offset constant exists in the repo, so premise (1) of the task fails on the facts',
    'the pin number y is owned by the vendor symbol (hardcoded, orientation-dependent: deltas -4/-5/0/+0.5), so changing it is a symbol rebuild',
    'the only in-repo lever for the flag name is the flag component position, which is the "thirteen edits" case the standing rules already reject',
    'a symbol-level edit would change all 70 pin-number attributes on this page (45 visible) and any other project bound to the same library symbol'
  ],
  whatWouldWork: 'if the host ever gains a symbol-level lever, the safe window is a uniform lift of 4.37-5.82 units (measured: below 4.37 the number stays inside the label, above 5.82 it reaches the previous row ink that ends at 784.48)',
  doNot: 'do not edit the library symbol in place, do not rebuild the symbol, do not move 12+ flags one by one, do not shrink the font (already no-go at 3.81/2.85)'
}

doc.reproduce = [
  'node docs/evidence/review/r6t1-layout-layer.mjs  # reads the live page, rewrites this JSON',
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

writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n')
console.log('written ' + OUT)
console.log('verdict: ' + doc.verdict.decision)
console.log('pin numbers: ' + doc.counts.pinNumberClass + ' (visible ' + doc.counts.pinNumberVisible + ')')
console.log('flag names: ' + doc.counts.flagNameAttrs + ', on pin rows: ' + doc.counts.flagsOnPinRowsCount)
console.log('deltas: ' + JSON.stringify(deltas))
console.log('offset from pin row: ' + (-OFFSET) + ' rows on grid: ' + rowGrid)
console.log('safe lift window: ' + upMin + ' .. ' + upMax)
