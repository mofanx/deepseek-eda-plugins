// r6t3 step 2: READ ONLY. Which pin-number attributes are actually visible, and is the "31"
// anchor an absolute page coordinate? The pixel scan found no black glyph at x 218-229 (where
// "31" would sit if x=224 were absolute), while the band at x 230.18-248.00 is about six
// characters wide - the width of the label text, not of a two-digit number.
import { writeFileSync } from 'node:fs'
import { HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'

const probe = `
const attrs = (await eda.sch_PrimitiveAttribute.getAll()) || [];
const pick = attrs.filter(a => a.key === 'Pin Number' || a.key === 'Pin Name');
return pick.map(a => ({ key: a.key, value: a.value, x: a.x, y: a.y,
  parent: a.parentPrimitiveId ?? a.parent ?? null,
  visible: a.valueVisible === undefined ? null : a.valueVisible !== false }));
`
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const rows = await bridge.execute(probe, { timeoutMs: 60_000 })
const num = rows.filter(r => r.key === 'Pin Number')
const pick = num.filter(r => r.value === '31' || r.value === '21' || r.value === '10')
const summary = {
  pinNumbers: num.length,
  visible: num.filter(r => r.visible === true).length,
  hidden: num.filter(r => r.visible === false).length,
  unknown: num.filter(r => r.visible === null).length,
  probes: pick,
  hiddenValues: num.filter(r => r.visible === false).map(r => r.value).slice(0, 40)
}
writeFileSync(process.argv[2] ?? 'r6t3-pin-visibility.json', JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary.probes, null, 2))
console.log('pin numbers', summary.pinNumbers, 'visible', summary.visible, 'hidden', summary.hidden, 'unknown', summary.unknown)
