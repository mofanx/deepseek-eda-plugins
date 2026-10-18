// t18: close the live loop after t15/t16/t17. The offline evidence (t15/t16/t17)
// measured the planned sheets; §14.12/§14.13 list "live read-back never re-run"
// as the open item. This script imports the t5 board through the real client
// with the current build, then reads the delivered pages back:
//
//   - page tab names must be the module list t16 emits (MCU+POWER+IO / MEM+CLK);
//   - the outer sheet border must measure the fitted page size the layout chose;
//   - rectangle and component counts must match the serializer's plan;
//   - every module frame must exist at its planned box and draw its title;
//   - importIntoEasyEda's netlist read-back must report zero error findings.
//
// Exit 0 when the live delivery matches the plan, 1 otherwise.
import { HttpEasyEdaBridge, importIntoEasyEda } from '../../../packages/schematic-easyeda/lib/index.js'
import { SCHEMATIC_PAGE_A3, layoutSchematic } from '../../../packages/schematic/lib/index.js'
import { checkPageBudget, computeBlockFrames, describePageBudget } from '../../../packages/eda-core/lib/index.js'
import { buildT5Board, measure } from '../tools/t5-board.mjs'

const fail = (message) => {
  console.error(`FAIL ${message}`)
  process.exit(1)
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

const { ir, pins } = await buildT5Board({ live: true })
const symbolUuid = ir.sheets[0].components[0].symbolUuid
const symbolPins = new Map([[symbolUuid, pins]])
const planned = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins })

console.log('== planned (offline) ==')
const budget = checkPageBudget(planned.sheets, SCHEMATIC_PAGE_A3)
console.log(describePageBudget(budget))
if (!budget.ok) fail(`planned board already fails the budget: ${JSON.stringify(budget.violations)}`)
const expected = measure(planned)
for (const page of expected) {
  console.log(`  planned ${page.index}: name="${page.name}" page=${page.pageSize.width}x${page.pageSize.height} parts=${page.parts} rects=${page.expectedRects}`)
}

const bridge = await HttpEasyEdaBridge.discover({ host: '127.0.0.1', timeoutMs: 60_000 })
console.log('bridge: discovered and an EasyEDA window is connected')
await bridge.execute('return 1', { timeoutMs: 10_000 })
console.log('execute: round-trip ok')

const projectName = `dsh-t18-${Date.now()}`
const report = await importIntoEasyEda(planned, { bridge, projectName, symbolPins, pageSize: SCHEMATIC_PAGE_A3, allowTabClose: true, timeoutMs: 90_000 })
console.log(`import: project ${report.projectUuid} (${report.pageUuids.length} page(s)), name "${projectName}"`)
for (const finding of report.findings) console.log(`  [${finding.severity}] ${finding.code}: ${finding.message}`)
const errors = report.findings.filter(finding => finding.severity === 'error')
if (errors.length > 0) fail(`${errors.length} error finding(s) in a clean live import`)
if (report.pageUuids.length !== planned.sheets.length) {
  fail(`imported ${report.pageUuids.length} page(s), planned ${planned.sheets.length}`)
}

// Live read-back: tab names, primitive counts, and every rectangle box.
const probe = `
const pages = await eda.dmt_Schematic.getAllSchematicPagesInfo() || [];
const out = [];
for (const uuid of ${JSON.stringify(report.pageUuids)}) {
  await eda.dmt_EditorControl.openDocument(uuid);
  const info = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
  let rects = [];
  try {
    const raw = await eda.sch_PrimitiveRectangle.getAll() || [];
    rects = raw.map(r => {
      const o = {};
      for (const pair of [['x','getState_TopLeftX'],['y','getState_TopLeftY'],['w','getState_Width'],['h','getState_Height'],['stroke','getState_StrokeStyle']]) {
        try { o[pair[0]] = typeof r[pair[1]] === 'function' ? r[pair[1]]() : null } catch (e) { o[pair[0]] = null }
      }
      return o;
    }).filter(r => [r.x, r.y, r.w, r.h].every(v => typeof v === 'number' && Number.isFinite(v)));
  } catch (e) {}
  let texts = 0; let components = 0;
  try { texts = ((await eda.sch_PrimitiveText.getAll()) || []).length } catch (e) {}
  try { components = ((await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []).length } catch (e) {}
  const textValues = [];
  try {
    const src = await eda.sys_FileManager.getDocumentSource();
    for (const line of src.split('\\n')) {
      if (!line.includes('"type":"TEXT"')) continue;
      const cut = line.indexOf('||');
      let inner = (cut < 0 ? line : line.slice(cut + 2)).trim();
      while (inner.endsWith('|')) inner = inner.slice(0, -1).trim();
      try { const parsed = JSON.parse(inner); if (typeof parsed.value === 'string') textValues.push(parsed.value) } catch (e) {}
    }
  } catch (e) {}
  out.push({ uuid, name: info && info.name, rects, texts, components, textValues });
}
return out;`
const live = await bridge.execute(probe, { timeoutMs: 60_000 })

console.log('== delivered (live read-back) ==')
const problems = []
for (const [index, page] of live.entries()) {
  const plan = expected[index]
  if (page.name !== plan.name) problems.push(`page ${index} name "${page.name}" != planned "${plan.name}"`)
  // The outer sheet border is the widest/tallest rect; its inset is 8, and the
  // client reports a rect's `y` as its bottom edge (the outer border of an A3
  // page reads y=1162, h=1154).
  const liveSize = {
    width: Math.max(0, ...page.rects.map(r => r.x + r.w)) + 8,
    height: Math.max(0, ...page.rects.map(r => r.y)) + 8,
  }
  if (!near(liveSize.width, plan.pageSize.width, 2) || !near(liveSize.height, plan.pageSize.height, 2)) {
    problems.push(`page ${index} size ${liveSize.width}x${liveSize.height} != planned ${plan.pageSize.width}x${plan.pageSize.height}`)
  }
  if (page.rects.length !== plan.expectedRects) problems.push(`page ${index} rects ${page.rects.length} != planned ${plan.expectedRects}`)
  if (page.components !== plan.parts) problems.push(`page ${index} components ${page.components} != planned ${plan.parts}`)

  const frames = computeBlockFrames(planned.sheets[index], plan.pageSize)
  let matched = 0
  for (const frame of frames) {
    const hit = page.rects.some(rect =>
      near(rect.x, frame.x) && near(rect.w, frame.width) && near(rect.h, frame.height)
      && near(rect.y, liveSize.height - frame.y))
    if (hit) matched += 1
    if (frame.title !== undefined && !page.textValues.includes(frame.title)) {
      problems.push(`page ${index} module frame title "${frame.title}" missing from the read-back`)
    }
  }
  if (matched !== frames.length) problems.push(`page ${index} module frames matched ${matched}/${frames.length}`)
  if (page.texts < 1) problems.push(`page ${index} read back no TEXT primitives`)
  console.log(`  live ${index}: name="${page.name}" borders→${liveSize.width}x${liveSize.height} rects=${page.rects.length} texts=${page.texts} components=${page.components} frames=${matched}/${frames.length}`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  MISMATCH ${problem}`)
  fail(`${problems.length} live/planned mismatch(es)`)
}
console.log('PASS')
