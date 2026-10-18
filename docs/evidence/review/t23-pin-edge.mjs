// t23: the 48-pin edge case behind the label pile in t19.
//
// A net whose pin sits exactly on the estimated body's padded edge used to fail
// every routing candidate (the stub "touched" the body) and fall back to a flag
// sitting on the pin itself: 48 nets, 48 flags, one column, 10-unit pitch —
// exactly the unreadable column §14.15 archived. `segmentCrossesRect` now lets
// an endpoint on that edge be legal, so the same probe must route 48 wires and
// emit no flags. The assertion is on the routing outcome, not on a screenshot.
//
// Exit 0 when the 48-pin worst case routes with stubs and no on-pin flags.
import { SCHEMATIC_PAGE_A3, layoutSchematic } from '../../../packages/schematic/lib/index.js'

const fail = (message) => {
  console.error(`FAIL ${message}`)
  process.exit(1)
}

// 48 pins, 10-unit pitch (= 100 mil), every net unique and used once: the
// worst case for per-pin labelling, and the shape t19 hit with a real C23922.
const pins = []
for (let index = 0; index < 48; index += 1) {
  pins.push({ number: String(index + 1), name: `P${index + 1}`, x: 40, y: 240 - index * 10 })
}
const components = [{
  id: 'u1', kind: 'part', designator: 'U1', block: 'MCU', deviceUuid: 'dev', symbolUuid: 'sym',
  pins: pins.map((pin, index) => ({
    id: `u1p${index}`, number: pin.number, name: pin.name, electric: 'BI', net: `MCU-${pin.number}`,
  })),
}]
const ir = { sheets: [{ name: 'MAIN', components, wires: [], busEntries: [], junctions: [], attrs: [], blocks: [{ name: 'MCU', title: 'MCU' }] }] }
const sheet = layoutSchematic(ir, { pageSize: SCHEMATIC_PAGE_A3, symbolPins: new Map([['sym', pins]]) }).sheets[0]

const flags = sheet.components.filter(component => String(component.id).startsWith('layout:flag:'))
const wires = sheet.wires ?? []
const stubLengths = wires.map(wire => {
  const chain = wire.dots?.[0] ?? []
  const first = { x: chain[0], y: chain[1] }
  const last = { x: chain[chain.length - 2], y: chain[chain.length - 1] }
  return Math.abs(last.x - first.x) + Math.abs(last.y - first.y)
})

console.log(`pins=${pins.length} wires=${wires.length} flags=${flags.length} page=${sheet.pageSize?.width}x${sheet.pageSize?.height}`)
if (wires.length !== 48) fail(`expected 48 routed nets, got ${wires.length}`)
if (flags.length !== 0) fail(`expected no on-pin flags, got ${flags.length}`)
if (!stubLengths.every(length => length > 0)) fail('a routed net has a zero-length stub')
console.log(`stub length min=${Math.min(...stubLengths)} max=${Math.max(...stubLengths)}`)
console.log('PASS 48 one-pin nets route with stubs instead of collapsing onto the pin')
