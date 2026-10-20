/**
 * t26 — live false-positive check for the WIRE_NET_LOST post-condition.
 *
 * The wire chunk refuses to trust `sch_PrimitiveWire.create`: it snapshots the
 * page's net set, places, re-reads, and reports (a) any net this chunk asked
 * for that never appeared and (b) any net that was there before and is gone
 * after. That guard is severity `error`, so a false positive would block
 * delivery of a perfectly good sheet.
 *
 * Two passes, because one is not enough:
 *   pass 1 — empty wire list. Places nothing, but the whole snapshot/re-read/
 *            before-set comparison runs over the page's real nets. Catches read
 *            instability and plumbing regressions.
 *   pass 2 — replay ONE real wire (its own net + its own line). The chunk's
 *            `seen` key is exactly `net + '|' + JSON.stringify(line)`, so this
 *            hits the dedupe skip: nothing is created, yet `intended` now holds
 *            a real net and the requested-net comparison loop — dead in pass 1 —
 *            actually runs. Zero mutation by construction, so the reference
 *            project is safe.
 *
 * Deliberately NOT covered here: a forced merge (true positive). That needs a
 * page we may destroy; the reference project is off-limits. It stays covered by
 * the executed-chunk tests in build.spec.ts.
 *
 * Preflight (P0.5): the source fingerprint must match the pinned build baseline.
 * Two earlier rounds produced inverted conclusions by measuring a stale
 * `lib/index.js` — `tsc -b` refreshes `lib/types/*` but NOT the bundle, and
 * these scripts import the bundle. Fail fast instead of measuring a ghost.
 */
import { join } from 'node:path'
import { gateFreshness } from './shared/freshness.mjs'
import { HttpEasyEdaBridge, renderWireChunkScript } from '../../../packages/schematic-easyeda/lib/index.js'

const repo = new URL('../../../', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')
gateFreshness(repo)

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })

/** Net set plus one wire we can replay, read straight off the live page. */
const pageState = () => bridge.execute(`
const s = new Set();
let sample = null;
for (const w of await eda.sch_PrimitiveWire.getAll() || []) {
  try {
    const n = w.getState_Net();
    if (typeof n === 'string' && n !== '') s.add(n);
    if (sample === null && typeof n === 'string' && n !== '') sample = { net: n, line: w.getState_Line() };
  } catch (e) {}
}
return { nets: s.size, wires: (await eda.sch_PrimitiveWire.getAll() || []).length, sample, page: (await eda.dmt_Schematic.getCurrentSchematicPageInfo()).uuid };`, {
  timeoutMs: 60_000,
})

const before = await pageState()
console.log(`page ${before.page}: ${before.nets} distinct wire nets, ${before.wires} wires`)

const problems = []
const check = (label, result, expectCreated) => {
  console.log(`${label}: status=${result.status} created=${result.created} failures=${JSON.stringify(result.failures)}`)
  if (result.status !== 'OK') problems.push(`${label} status ${result.status}`)
  if (result.created !== expectCreated) problems.push(`${label} created ${result.created} != ${expectCreated}`)
  if (!Array.isArray(result.failures) || result.failures.length !== 0) problems.push(`${label} failures ${JSON.stringify(result.failures)}`)
}

// Pass 1 — nothing placed; snapshot + re-read + before-set comparison only.
check('pass1 empty', await bridge.execute(renderWireChunkScript([], before.page, 0), { timeoutMs: 60_000 }), 0)

// Pass 2 — replay one real wire so the requested-net loop body runs. The seen
// key matches by construction, so the chunk takes the dedupe skip and creates
// nothing; `created` counts the skipped row, which is the proof it skipped.
const sample = before.sample
if (sample === null || !Array.isArray(sample.line) || sample.line.length === 0) {
  console.error('FAIL pass2: the page offered no wire to replay')
  process.exit(1)
}
const replay = [{ irId: 't26-replay', kind: 'wire', net: sample.net, dots: sample.line }]
check(`pass2 replay "${sample.net}"`, await bridge.execute(renderWireChunkScript(replay, before.page, 0), { timeoutMs: 60_000 }), 1)

const after = await pageState()
console.log(`after: ${after.nets} distinct wire nets, ${after.wires} wires`)
if (after.nets !== before.nets) problems.push(`net count moved ${before.nets} -> ${after.nets}`)
if (after.wires !== before.wires) problems.push(`wire count moved ${before.wires} -> ${after.wires}`)

if (problems.length > 0) {
  console.error(`FAIL ${problems.join('; ')}`)
  process.exit(1)
}
console.log(`PASS no false positive: both comparison directions ran over ${before.nets} nets, nothing created, page unchanged`)
