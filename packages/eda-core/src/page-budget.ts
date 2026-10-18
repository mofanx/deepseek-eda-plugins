/**
 * The page-budget acceptance rule, in one place so it can be executed by the
 * regression instead of restated inside it (t8 flagged the restated constants;
 * t9 then proved the restated rule could not fail). Everything the rule needs
 * comes from the shared budget and the delivery metric — the test only feeds it
 * laid-out sheets and asserts the verdict.
 *
 * A page passes when it reaches {@link SCHEMATIC_PAGE_BUDGET.fillTarget}; a page
 * below the target passes only when all of these hold:
 * - it is already delivered on the smallest sheet the budget allows for its own
 *   content (`atMinimum`), so its size is not what is wasting the sheet;
 * - that smallest sheet still cannot reach the target (`ceiling < target`), so
 *   the shape — not the pagination — is the limit;
 * - it stays above {@link SCHEMATIC_PAGE_BUDGET.fillFloor}, the point where a
 *   sheet is more empty than drawn.
 * Two board-level rules back that up: the per-page part counts stay within one
 * module of each other (a width-greedy pack that strands a lone module fails),
 * and no two adjacent pages could have been merged into one (a pagination that
 * spreads a band per page fails).
 * @module @deepseek-ai/dsh-plugin-eda-core/page-budget
 */

import type { SchematicIrSheet, SchematicPageSize } from '@deepseek-ai/dsh-plugin-eda-sch'
import { SCHEMATIC_PAGE_BUDGET, contentCoverage, fittedPageSize, outwardContentBox } from '@deepseek-ai/dsh-plugin-eda-sch'
import { measurePageFill } from './measure.ts'
import type { SchematicInkBox } from './measure.ts'

/** Why a page or a board failed the budget. */
export type PageBudgetRule = 'target' | 'minimum' | 'ceiling' | 'floor' | 'distribution' | 'pagination'

/** One violation, named so a failure report says which rule fired. */
export interface PageBudgetViolation {
  /** Page name, or `''` for a board-level rule. */
  readonly page: string
  readonly rule: PageBudgetRule
  readonly detail: string
}

/** Per-page measurement the rule judges. */
export interface PageBudgetPage {
  readonly name: string
  /** Components of `kind: 'part'` (generated flags and ports excluded). */
  readonly parts: number
  /** Distinct functional modules on the page. */
  readonly blocks: number
  readonly pageSize: SchematicPageSize
  readonly fitted: boolean
  /** Delivery fill: ink bbox over the delivered sheet (see `measure.ts`). */
  readonly fill: number
  readonly box: SchematicInkBox
  /** Smallest sheet the budget allows for this page's own content. */
  readonly minSize: SchematicPageSize
  /** Whether the page is delivered on that smallest sheet. */
  readonly atMinimum: boolean
  /** Fill the page would reach on `minSize` — the structural ceiling. */
  readonly ceiling: number
}

/** Verdict for one laid-out document. */
export interface PageBudgetReport {
  readonly ok: boolean
  readonly pages: readonly PageBudgetPage[]
  readonly violations: readonly PageBudgetViolation[]
}

/**
 * Measure and judge every page of a laid-out document.
 * @param sheets - laid-out sheets, in delivery order.
 * @param planned - the frame the caller asked for.
 * @returns the per-page measurements and every violated rule.
 */
export function checkPageBudget(sheets: readonly SchematicIrSheet[], planned: SchematicPageSize): PageBudgetReport {
  const budget = SCHEMATIC_PAGE_BUDGET
  const pages: PageBudgetPage[] = sheets.map((sheet) => {
    const fill = measurePageFill(sheet, planned)
    const anchors = sheet.components
      .map(component => component.position)
      .filter((position): position is { x: number; y: number } => position !== undefined)
    // The fit budget applies to the *outward* box the layout fits with, not to
    // the ink box: measuring the ink and fitting the ink would make a converged
    // page look larger than its own minimum (t11: delivered 890, "minimum" 730).
    const minSize = fittedPageSize(outwardContentBox(anchors), planned)
    const blocks = new Set(sheet.components.map(component => component.block).filter(block => block !== undefined))
    return {
      name: sheet.name ?? '',
      parts: sheet.components.filter(component => component.kind === 'part').length,
      blocks: blocks.size,
      pageSize: fill.pageSize,
      fitted: fill.fitted,
      fill: fill.fill,
      box: fill.box,
      minSize,
      atMinimum: fill.pageSize.width === minSize.width && fill.pageSize.height === minSize.height,
      ceiling: contentCoverage(fill.box, minSize),
    }
  })

  const violations: PageBudgetViolation[] = []
  const parts = pages.map(page => page.parts)

  // Board-level: a module must not be stranded. The reference module is the
  // largest declared group, so the spread is allowed to be one module wide.
  const perBlock = new Map<string, number>()
  for (const sheet of sheets) {
    for (const component of sheet.components) {
      if (component.kind !== 'part' || component.block === undefined) continue
      perBlock.set(component.block, (perBlock.get(component.block) ?? 0) + 1)
    }
  }
  const moduleSize = Math.max(0, ...perBlock.values())
  if (pages.length > 1 && moduleSize > 0 && Math.max(...parts) - Math.min(...parts) > moduleSize) {
    violations.push({
      page: '',
      rule: 'distribution',
      detail: `per-page part counts ${parts.join('/')} spread more than one ${moduleSize}-part module`,
    })
  }

  // Board-level: no two adjacent pages could have shared one sheet. Checked
  // with the module gap, so a merge that only fits exactly is not flagged.
  const usableWidth = planned.width - 2 * budget.edgePadFramed
  const usableHeight = planned.height - 2 * budget.edgePadFramed
  for (let index = 1; index < pages.length; index += 1) {
    const previous = pages[index - 1] as PageBudgetPage
    const current = pages[index] as PageBudgetPage
    const previousWidth = previous.box.x2 - previous.box.x1
    const previousHeight = previous.box.y2 - previous.box.y1
    const currentWidth = current.box.x2 - current.box.x1
    const currentHeight = current.box.y2 - current.box.y1
    const sideBySide = previousWidth + currentWidth + budget.moduleGap <= usableWidth
      && Math.max(previousHeight, currentHeight) <= usableHeight
    const stacked = previousHeight + currentHeight + budget.moduleGap <= usableHeight
      && Math.max(previousWidth, currentWidth) <= usableWidth
    if (sideBySide || stacked) {
      violations.push({
        page: current.name,
        rule: 'pagination',
        detail: `${previous.name} and ${current.name} would still fit on one ${planned.width}x${planned.height} sheet`,
      })
    }
  }

  for (const page of pages) {
    if (page.fill >= budget.fillTarget) continue
    if (!page.atMinimum) {
      violations.push({
        page: page.name,
        rule: 'minimum',
        detail: `fill ${percent(page.fill)} below target while the page is ${page.pageSize.width}x${page.pageSize.height}, not its minimum ${page.minSize.width}x${page.minSize.height}`,
      })
    }
    if (page.ceiling >= budget.fillTarget) {
      violations.push({
        page: page.name,
        rule: 'ceiling',
        detail: `fill ${percent(page.fill)} below target but the shape reaches ${percent(page.ceiling)}`,
      })
    }
    if (page.fill < budget.fillFloor) {
      violations.push({
        page: page.name,
        rule: 'floor',
        detail: `fill ${percent(page.fill)} below the ${percent(budget.fillFloor)} floor`,
      })
    }
  }

  return { ok: violations.length === 0, pages, violations }
}

/** One-line verdict, for test output and evidence logs. */
export function describePageBudget(report: PageBudgetReport): string {
  const pages = report.pages
    .map(page => `${page.name || '?'}:${page.pageSize.width}x${page.pageSize.height}${page.fitted ? '*' : ''} parts=${page.parts} fill=${percent(page.fill)} min=${page.minSize.width}x${page.minSize.height}${page.atMinimum ? '=min' : ''}`)
    .join(' | ')
  const verdict = report.ok ? 'OK' : `FAIL(${report.violations.map(violation => violation.rule).join(',')})`
  return `[page-budget] ${verdict} ${pages}`
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
