import { describe, expect, it } from 'vitest'
import {
  SCHEMATIC_PAGE_A3,
  SCHEMATIC_PAGE_A4,
  SCHEMATIC_PAGE_BUDGET,
  contentCoverage,
  fittedPageSize,
  layoutSchematic,
  outwardContentBox,
  snapToGrid,
} from '@deepseek-ai/dsh-plugin-eda-sch'
import { checkPageBudget, describePageBudget, measurePageFill, titleBlockTop } from '../src/index.js'
import type {
  SchematicIr,
  SchematicIrComponent,
  SchematicIrPin,
  SchematicIrSheet,
  SchematicSymbolPin,
} from '@deepseek-ai/dsh-plugin-eda-sch'

const pin = (id: string, net: string, electric: SchematicIrPin['electric']): SchematicIrPin =>
  ({ id, name: id.toUpperCase(), number: id.replace('p', ''), electric, net })

/**
 * Five six-part modules chained by their own nets: the board the pagination,
 * the tail-page rebalance, and the title-block margins were tuned against.
 * Layout adds generated net flags for the unwired pins, so a page's content box
 * covers parts *and* flags.
 */
function board(perModule = 6, modules = 5): SchematicIr {
  const components: SchematicIrComponent[] = []
  const wires: SchematicIr['sheets'][number]['wires'] = []
  const blocks = ['MCU', 'POWER', 'IO', 'MEM', 'CLK', 'SENSOR', 'RADIO']
    .slice(0, modules)
    .map(name => ({ name, title: name }))
  let n = 0
  for (const block of blocks) {
    for (let i = 0; i < perModule; i++) {
      const id = `u${++n}`
      components.push({
        id,
        kind: 'part',
        designator: id.toUpperCase(),
        deviceUuid: `dev-${id}`,
        block: block.name,
        pins: [pin('p1', `${block.name}-A${i}`, 'INPUT'), pin('p2', `${block.name}-B${i}`, 'OUTPUT')],
      })
      if (i > 0) {
        wires.push({ id: `w${id}`, kind: 'wire', net: `${block.name}-A${i}`, dots: [[0, 0, 10, 0]] })
        wires.push({ id: `wb${id}`, kind: 'bus', net: `${block.name}-B${i}`, dots: [[0, 0, 10, 0]] })
      }
    }
  }
  return { sheets: [{ components, wires, busEntries: [], junctions: [], attrs: [], blocks }] }
}

/**
 * The shape the t5 live capture used: five six-part modules, two pins per part,
 * every part bound to the same library symbol so the shard geometry is driven by
 * the symbol's pin offsets rather than by a per-part synthetic symbol. This is
 * the board that produces the narrow tall modules.
 */
function t5Board(): { ir: SchematicIr; pins: readonly SchematicSymbolPin[] } {
  const names = ['MCU', 'POWER', 'IO', 'MEM', 'CLK']
  const pins: SchematicSymbolPin[] = [
    { number: '1', name: 'P1', x: 20, y: -10 },
    { number: '2', name: 'P2', x: 20, y: 10 },
  ]
  const components: SchematicIrComponent[] = []
  const wires: SchematicIr['sheets'][number]['wires'] = []
  let n = 0
  for (const block of names) {
    for (let i = 0; i < 6; i++) {
      const id = `u${++n}`
      components.push({
        id,
        kind: 'part',
        designator: id.toUpperCase(),
        deviceUuid: 'dev',
        symbolUuid: 'sym',
        block,
        pins: [
          { ...pin('p1', `${block}-A${i}`, 'BI'), name: pins[0]!.name, number: pins[0]!.number },
          { ...pin('p2', `${block}-B${i}`, 'BI'), name: pins[1]!.name, number: pins[1]!.number },
        ],
      })
      if (i > 0) wires.push({ id: `w${id}`, kind: 'wire', net: `${block}-A${i}`, dots: [[0, 0, 10, 0]] })
    }
  }
  return {
    ir: { sheets: [{ name: 'MAIN', components, wires, busEntries: [], junctions: [], attrs: [], blocks: names.map(name => ({ name, title: name })) }] },
    pins,
  }
}

/** Lay out one document and judge it with the delivery rule. */
function judge(
  ir: SchematicIr,
  planned = SCHEMATIC_PAGE_A3,
  options: { symbolPins?: ReadonlyMap<string, readonly SchematicSymbolPin[]>; moduleColumns?: number } = {},
): ReturnType<typeof checkPageBudget> {
  const laid = layoutSchematic(ir, {
    pageSize: planned,
    ...(options.symbolPins === undefined ? {} : { symbolPins: options.symbolPins }),
    ...(options.moduleColumns === undefined ? {} : { moduleColumns: options.moduleColumns }),
  })
  const report = checkPageBudget(laid.sheets, planned)
  console.log(describePageBudget(report))
  for (const violation of report.violations) console.log(`  ${violation.rule}: ${violation.detail}`)
  return report
}

/** Rules that fired, as a set, so a test can name the ones it expects. */
const rules = (report: ReturnType<typeof checkPageBudget>): string[] =>
  [...new Set(report.violations.map(violation => violation.rule))].sort()

describe('delivery budget: one metric, one rule', () => {
  it('pins the five-row title block top at 679 on A4 and 1024 on A3', () => {
    // height − 16 inset − 5×26 rows; the framed content edge is 24 above it.
    expect(titleBlockTop(SCHEMATIC_PAGE_A4)).toBe(679)
    expect(titleBlockTop(SCHEMATIC_PAGE_A3)).toBe(1024)
    expect(SCHEMATIC_PAGE_A4.height - 170).toBe(655)
    expect(SCHEMATIC_PAGE_A3.height - 170).toBe(1024 + 24 - 48)
  })

  it('describes a page with no authored name using a placeholder', () => {
    // Generated page names are the norm now, but an unnamed authored sheet must
    // still measure and print without a `null`/`undefined` leaking into the log.
    const unnamed: SchematicIrSheet = {
      components: [{
        id: 'u1',
        kind: 'part',
        designator: 'U1',
        position: { x: 200, y: 200 },
        pins: [],
      }],
      wires: [],
      busEntries: [],
      junctions: [],
      attrs: [],
    }
    const report = checkPageBudget([unnamed], SCHEMATIC_PAGE_A4)
    expect(report.pages[0]?.name).toBe('')
    expect(describePageBudget(report)).toContain('?:')
  })

  it('keeps the budget numbers in one place and snaps on the grid', () => {
    // The regression reads the budget instead of restating it (t8's drift risk).
    expect(SCHEMATIC_PAGE_BUDGET.fillTarget).toBe(0.35)
    expect(SCHEMATIC_PAGE_BUDGET.fillFloor).toBe(0.25)
    expect(SCHEMATIC_PAGE_BUDGET.fillFloor).toBeLessThan(SCHEMATIC_PAGE_BUDGET.fillTarget)
    expect(snapToGrid(1234)).toBe(1230)
    expect(snapToGrid(1235)).toBe(1240)
    expect(snapToGrid(1234, 100)).toBe(1200)
    expect(contentCoverage({ x1: 0, y1: 0, x2: 100, y2: 50 }, { width: 200, height: 100 })).toBe(0.25)
  })

  it('fits a content box inside the planned frame and never below the title block', () => {
    const b = SCHEMATIC_PAGE_BUDGET
    const small = fittedPageSize({ x1: 0, y1: 0, x2: 10, y2: 10 }, SCHEMATIC_PAGE_A3)
    expect(small).toEqual({ width: b.minFittedWidth, height: b.minFittedHeight })
    const planned = fittedPageSize({ x1: 0, y1: 0, x2: 2000, y2: 2000 }, SCHEMATIC_PAGE_A3)
    expect(planned).toEqual(SCHEMATIC_PAGE_A3)
    // The outward box pads each edge with its own allowance.
    expect(outwardContentBox([{ x: 100, y: 200 }])).toEqual({
      x1: 100 - b.outwardX,
      y1: 200 - b.outwardTop,
      x2: 100 + b.outwardX,
      y2: 200 + b.outwardBottom,
    })
    expect(outwardContentBox([])).toEqual({ x1: 0, y1: 0, x2: 0, y2: 0 })
  })

  it('measures an empty page as zero and a drawn page as its ink box over the delivered sheet', () => {
    const empty: SchematicIrSheet = { components: [], wires: [], busEntries: [], junctions: [], attrs: [] }
    const blank = measurePageFill(empty, SCHEMATIC_PAGE_A3)
    expect(blank.fill).toBe(0)
    expect(blank.fitted).toBe(false)
    expect(blank.pageSize).toEqual(SCHEMATIC_PAGE_A3)

    const { ir, pins } = t5Board()
    const laid = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([['sym', pins]]) })
    // The compact layout leaves page 0 dense enough to keep the planned frame,
    // while the two-module tail converges; measure a converged page.
    const fitted = laid.sheets.find(sheet => sheet.pageSize !== undefined) as SchematicIrSheet
    const first = measurePageFill(fitted, SCHEMATIC_PAGE_A3)
    expect(first.fitted).toBe(true)
    // The ink box covers the module frames, so it is larger than the anchor box.
    expect(first.box.x1).toBeGreaterThan(0)
    expect(first.box.x2).toBeLessThan(first.pageSize.width)
    expect(first.fill).toBeGreaterThan(SCHEMATIC_PAGE_BUDGET.fillTarget)

    // Unplaced components and unbound pins contribute nothing: a part without a
    // position is skipped, and a pin without an endpoint only adds its owner.
    const partial: SchematicIrSheet = {
      components: [
        { id: 'x1', kind: 'part', designator: 'X1', deviceUuid: 'dev', pins: [] },
        { id: 'x2', kind: 'part', designator: 'X2', deviceUuid: 'dev', position: { x: 10, y: 10 }, pins: [pin('p1', 'A', 'INPUT')] },
        { id: 'x3', kind: 'part', designator: 'X3', deviceUuid: 'dev', position: { x: 100, y: 100 }, pins: [] },
      ],
      wires: [],
      busEntries: [],
      junctions: [],
      attrs: [],
    }
    const sparse = measurePageFill(partial, SCHEMATIC_PAGE_A3)
    expect(sparse.box).toEqual({ x1: 10, y1: 10, x2: 100, y2: 100 })
    expect(sparse.fill).toBeCloseTo((90 * 90) / (SCHEMATIC_PAGE_A3.width * SCHEMATIC_PAGE_A3.height), 10)
  })

  it('passes the flat five-module A3 board', () => {
    const report = judge(board())
    expect(rules(report)).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.pages.length).toBeGreaterThanOrEqual(2)
    for (const page of report.pages) expect(page.fill).toBeGreaterThanOrEqual(SCHEMATIC_PAGE_BUDGET.fillTarget)
    expect(report.pages.some(page => page.fitted)).toBe(true)
  })

  it('passes the flat five-module A4 board', () => {
    const report = judge(board(), SCHEMATIC_PAGE_A4)
    expect(report.ok).toBe(true)
    expect(report.pages.map(page => page.parts)).toEqual([6, 6, 6, 6, 6])
    for (const page of report.pages) {
      expect(page.fill).toBeGreaterThanOrEqual(SCHEMATIC_PAGE_BUDGET.fillTarget)
      // The A4 page is delivered exactly on the minimum the rule computes: the
      // metric and the fit budget are composable (t11: delivered 890 vs 730).
      expect(page.minSize).toEqual(page.pageSize)
      expect(page.atMinimum).toBe(true)
    }
  })

  it('passes the t5-shaped board without leaning on a hardcoded part split', () => {
    const { ir, pins } = t5Board()
    const report = judge(ir, SCHEMATIC_PAGE_A3, { symbolPins: new Map([['sym', pins]]) })
    expect(rules(report)).toEqual([])
    expect(report.ok).toBe(true)
    // Rebalanced 3 + 2 instead of the width-greedy 4 + 1. The first page packs
    // two modules beside each other and one below, so it is dense enough to
    // keep its planned frame; the two-module tail still converges.
    expect(report.pages.map(page => page.parts)).toEqual([18, 12])
    expect(report.pages.some(page => page.fitted)).toBe(true)
    expect(report.pages.every(page => page.fill >= SCHEMATIC_PAGE_BUDGET.fillTarget)).toBe(true)
  })

  it('centres a converged page on the sheet it converges to', () => {
    // The fit used to place the outward box at a fixed 60-unit margin, which
    // left 140 on the left and 250 on the right on both pages (t9). A converged
    // page now centres that box in the width it actually delivers. Centring is
    // defined on the module parts: the generated net flags hang off their right
    // edge, so a box over every component is asymmetric by construction.
    const { ir, pins } = t5Board()
    const laid = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([['sym', pins]]) })
    const converged = laid.sheets.filter(sheet => sheet.pageSize !== undefined)
    expect(converged.length).toBeGreaterThan(0)
    for (const sheet of converged) {
      expect(sheet.pageSize).toBeDefined()
      const size = sheet.pageSize!
      const anchors = sheet.components
        .filter(component => component.kind === 'part')
        .map(component => component.position)
        .filter((position): position is { x: number; y: number } => position !== undefined)
      expect(anchors.length).toBeGreaterThan(0)
      const box = outwardContentBox(anchors)
      const left = box.x1
      const right = size.width - box.x2
      // Centred to within one placement grid step; the old fixed margin left a
      // 110-unit difference on the same pages.
      expect(Math.abs(left - right)).toBeLessThanOrEqual(SCHEMATIC_PAGE_BUDGET.grid)
      expect(left).toBeGreaterThan(SCHEMATIC_PAGE_BUDGET.fittedMargin)
    }
  })

  it('accepts a page that really is capped: at its minimum sheet and still below target', () => {
    // Hand-built: one module of two parts stacked in a single column, so the
    // anchors span 700 vertically and 0 across. The fit budget therefore lands
    // on the 592-wide floor and the full A3 height, and the drawn box (pins
    // 40..160 across, 140..900 down, padded by the frame) covers ~34% of it —
    // below target, but there is no smaller sheet to deliver. This is the only
    // case the ceiling clause may pass.
    const sheet: SchematicIrSheet = {
      name: 'CAPPED',
      pageSize: { width: SCHEMATIC_PAGE_BUDGET.minFittedWidth, height: SCHEMATIC_PAGE_A3.height },
      blocks: [{ name: 'MCU', title: 'MCU' }],
      components: [
        {
          id: 'u1',
          kind: 'part',
          designator: 'U1',
          deviceUuid: 'dev',
          block: 'MCU',
          position: { x: 100, y: 200 },
          pins: [
            { ...pin('p1', 'A', 'INPUT'), endpoint: { x: 40, y: 140 } },
            { ...pin('p2', 'B', 'OUTPUT'), endpoint: { x: 160, y: 180 } },
          ],
        },
        {
          id: 'u2',
          kind: 'part',
          designator: 'U2',
          deviceUuid: 'dev',
          block: 'MCU',
          position: { x: 100, y: 900 },
          pins: [
            { ...pin('p1', 'C', 'INPUT'), endpoint: { x: 40, y: 800 } },
            { ...pin('p2', 'D', 'OUTPUT'), endpoint: { x: 160, y: 860 } },
          ],
        },
      ],
      wires: [],
      busEntries: [],
      junctions: [],
      attrs: [],
    }
    const report = checkPageBudget([sheet], SCHEMATIC_PAGE_A3)
    console.log(describePageBudget(report))
    const page = report.pages[0]!
    expect(page.fill).toBeLessThan(SCHEMATIC_PAGE_BUDGET.fillTarget)
    expect(page.fill).toBeGreaterThanOrEqual(SCHEMATIC_PAGE_BUDGET.fillFloor)
    expect(page.atMinimum).toBe(true)
    expect(page.ceiling).toBeLessThan(SCHEMATIC_PAGE_BUDGET.fillTarget)
    expect(report.violations).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('rejects a page that ships the planned frame instead of converging', () => {
    // Control 1: the same laid pages, but delivered without the fitted size —
    // exactly the regression where the fit stops running. The rule must fail it
    // on its own checks, not because a test knows the part split.
    const { ir, pins } = t5Board()
    const laid = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([['sym', pins]]) })
    const unconverged = laid.sheets.map(sheet => ({ ...sheet, pageSize: undefined }))
    const report = checkPageBudget(unconverged, SCHEMATIC_PAGE_A3)
    console.log(describePageBudget(report))
    for (const violation of report.violations) console.log(`  ${violation.rule}: ${violation.detail}`)
    expect(report.ok).toBe(false)
    // The compact tail is no longer below the 25% floor, so the failure is the
    // two real defects: the page is not at its minimum and its shape could
    // still reach the target.
    expect(rules(report)).toEqual(['ceiling', 'minimum'])
    // Page 0 still clears the target on the full A3 frame; page 1 does not.
    expect(report.pages[0]!.fill).toBeGreaterThanOrEqual(SCHEMATIC_PAGE_BUDGET.fillTarget)
    const tail = report.pages[1]!
    expect(tail.fill).toBeLessThan(SCHEMATIC_PAGE_BUDGET.fillTarget)
    expect(tail.atMinimum).toBe(false)
    expect(tail.fill).toBeGreaterThanOrEqual(SCHEMATIC_PAGE_BUDGET.fillFloor)
  })

  /** Hand-built one-column module page: six parts stacked, the t9 shape. */
  const columnPage = (name: string): SchematicIrSheet => ({
    name,
    blocks: [{ name: 'MCU', title: 'MCU' }],
    components: Array.from({ length: 6 }, (_, i) => ({
      id: `${name}-u${i}`,
      kind: 'part',
      designator: `U${i}`,
      deviceUuid: 'dev',
      block: 'MCU',
      position: { x: 100, y: 200 + i * 130 },
      pins: [{ ...pin(`p${i}`, `N${i}`, 'INPUT') }],
    })),
    wires: [],
    busEntries: [],
    junctions: [],
    attrs: [],
  })

  /** Hand-built compact module: `parts` parts in two sub-columns. */
  const modulePage = (name: string, block: string, parts: number, x: number, y: number): SchematicIrSheet => ({
    name,
    blocks: [{ name: block, title: block }],
    components: Array.from({ length: parts }, (_, i) => ({
      id: `${name}-${block}-${i}`,
      kind: 'part',
      designator: `U${i}`,
      deviceUuid: 'dev',
      block,
      position: { x: x + (i % 2) * 300, y: y + Math.floor(i / 2) * 120 },
      pins: [{ ...pin(`p${i}`, `N${i}`, 'BI') }],
    })),
    wires: [],
    busEntries: [],
    junctions: [],
    attrs: [],
  })

  it('rejects the one-module-per-page pagination that the old rule let through', () => {
    // Control 2: the t9 finding, built directly so it cannot be masked by a
    // later packing improvement. Five pages at ~7% each used to pass because
    // their "structural ceiling" was low. The rule fails every one of them on
    // the floor and on not being at their minimum — no part list involved.
    const report = checkPageBudget(['A', 'B', 'C', 'D', 'E'].map(columnPage), SCHEMATIC_PAGE_A3)
    console.log(describePageBudget(report))
    expect(report.pages.length).toBe(5)
    expect(report.pages.map(page => page.parts)).toEqual([6, 6, 6, 6, 6])
    for (const page of report.pages) {
      expect(page.fill).toBeLessThan(SCHEMATIC_PAGE_BUDGET.fillTarget)
      expect(page.fill).toBeLessThan(SCHEMATIC_PAGE_BUDGET.fillFloor)
    }
    expect(report.ok).toBe(false)
    expect(rules(report)).toEqual(['floor', 'minimum'])
  })

  it('rejects a width-greedy pack that strands a module', () => {
    // Control 3: four modules on the first page and one alone on the second.
    // The per-page spread (24 vs 6) exceeds one module, so the board fails even
    // though no single page is below the floor. Built from laid module groups,
    // not from the packer, so the distribution rule is exercised on its own.
    const four = ['MCU', 'POWER', 'IO', 'MEM'].map((block, index) =>
      modulePage('A', block, 6, 200 + (index % 2) * 620, 200 + Math.floor(index / 2) * 420))
    const pageA: SchematicIrSheet = {
      ...(four[0] as SchematicIrSheet),
      blocks: four.flatMap(sheet => sheet.blocks ?? []),
      components: four.flatMap(sheet => sheet.components),
    }
    const report = checkPageBudget([pageA, modulePage('B', 'CLK', 6, 200, 200)], SCHEMATIC_PAGE_A3)
    console.log(describePageBudget(report))
    expect(report.pages.map(page => page.parts)).toEqual([24, 6])
    expect(report.ok).toBe(false)
    expect(rules(report)).toContain('distribution')
  })

  it('rejects a pagination that leaves two mergeable pages', () => {
    // Control 4: two five-part modules each alone on an A3 page. Each drawn box
    // is small enough that both would still fit side by side on one sheet — the
    // pagination is not minimal. Hand-built, so compact packing cannot merge
    // them for us and hide the rule.
    const report = checkPageBudget([
      modulePage('P1', 'A', 5, 200, 200),
      modulePage('P2', 'B', 5, 200, 200),
    ], SCHEMATIC_PAGE_A3)
    console.log(describePageBudget(report))
    expect(report.pages.length).toBe(2)
    expect(report.ok).toBe(false)
    expect(rules(report)).toContain('pagination')
  })

  it('flags hand-built sheets that would have fitted together on one sheet', () => {
    // Two one-part sheets on a full A3 frame: small enough that both the
    // side-by-side and the stacked test have to be evaluated, and both hold.
    const small = (name: string, y: number): SchematicIrSheet => ({
      name,
      blocks: [{ name: 'MCU', title: 'MCU' }],
      components: [{
        id: 'u1',
        kind: 'part',
        designator: 'U1',
        deviceUuid: 'dev',
        block: 'MCU',
        position: { x: 100, y },
        pins: [
          { ...pin('p1', 'A', 'INPUT'), endpoint: { x: 40, y: y - 20 } },
          { ...pin('p2', 'B', 'OUTPUT'), endpoint: { x: 160, y: y + 20 } },
        ],
      }],
      wires: [],
      busEntries: [],
      junctions: [],
      attrs: [],
    })
    const report = checkPageBudget([small('P1', 100), small('P2', 300)], SCHEMATIC_PAGE_A3)
    console.log(describePageBudget(report))
    expect(report.pages.length).toBe(2)
    expect(report.ok).toBe(false)
    expect(rules(report)).toEqual(['floor', 'minimum', 'pagination'])
  })

  it('keeps the planned frame when a framed page already clears the target', () => {
    // Seven compact modules fill two A3 pages (4 + 3). Each page's tight box
    // clears the target, so the layout keeps the planned frame instead of
    // converging, and never reports a fitted size.
    const laid = layoutSchematic(board(6, 7), { pageSize: SCHEMATIC_PAGE_A3 })
    expect(laid.sheets.some(sheet => sheet.pageSize === undefined)).toBe(true)
    expect(laid.sheets.length).toBeGreaterThan(1)
    for (const sheet of laid.sheets) expect(sheet.components.length).toBeGreaterThan(0)
  })
})
