// t16: page names derived from the modules a page carries. Before this pass a
// paginated sheet kept its authored name and numbered continuations (`MAIN`,
// `MAIN 2`), so the tab and title block said nothing about the content. The
// packer now lists up to three module titles (`MCU+POWER+IO`) and falls back to
// the authored name when a page carries too many modules or the composed name
// is too long. This script records the t5 board's emitted names; it does not
// assert.
import { SCHEMATIC_PAGE_A3, layoutSchematic } from '../../../packages/schematic/lib/index.js'
import { buildT5Board } from '../tools/t5-board.mjs'

const { ir, pins } = await buildT5Board()
const laid = layoutSchematic(ir, {
  pageSize: SCHEMATIC_PAGE_A3,
  symbolPins: new Map([[ir.sheets[0].components[0].symbolUuid, pins]]),
})

for (const [index, sheet] of laid.sheets.entries()) {
  const modules = [...new Set(sheet.components.filter(component => component.kind === 'part').map(component => component.block))]
  const parts = sheet.components.filter(component => component.kind === 'part').length
  const size = sheet.pageSize ?? SCHEMATIC_PAGE_A3
  console.log(`${index}: name="${sheet.name}" modules=${modules.join('+')} parts=${parts} page=${size.width}x${size.height}`)
}
