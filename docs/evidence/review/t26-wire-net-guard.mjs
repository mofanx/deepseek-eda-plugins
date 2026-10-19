/**
 * t26 — live false-positive check for the WIRE_NET_LOST post-condition.
 *
 * The wire chunk refuses to trust `sch_PrimitiveWire.create`: it snapshots the
 * page's net set, places, re-reads, and reports any net this chunk asked for
 * that never appeared, plus any net that was there before and is gone after.
 * That guard is severity `error`, so a false positive would block delivery of a
 * perfectly good sheet. This script runs the REAL generated chunk (not a
 * reimplementation) against the REAL delivered page and asserts it stays quiet.
 *
 * The true-positive side (a forced merge naming the lost net) needs a page we
 * may destroy, so it is covered by the executed-chunk tests in build.spec.ts.
 *
 * Preflight (P0.5): the tsdown bundle must be newer than every source file.
 * Two earlier rounds produced inverted conclusions by measuring a stale
 * `lib/index.js` — `tsc -b` refreshes `lib/types/*` but NOT the bundle, and
 * these scripts import the bundle. Fail fast instead of measuring a ghost.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HttpEasyEdaBridge, renderWireChunkScript } from '../../../packages/schematic-easyeda/lib/index.js'

const repo = new URL('../../../', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')

const newest = (dir) => {
  let best = { path: dir, mtime: 0 }
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name)
    if (name.isDirectory()) {
      const nested = newest(full)
      if (nested.mtime > best.mtime) best = nested
    } else if (name.name.endsWith('.ts')) {
      const { mtimeMs } = statSync(full)
      if (mtimeMs > best.mtime) best = { path: full, mtime: mtimeMs }
    }
  }
  return best
}

const src = newest(join(repo, 'packages', 'schematic-easyeda', 'src'))
const lib = join(repo, 'packages', 'schematic-easyeda', 'lib', 'index.js')
const libMtime = statSync(lib).mtimeMs
if (libMtime < src.mtime) {
  console.error(`FAIL preflight: ${lib} is older than ${src.path} — run \`npx tsdown\` before measuring`)
  process.exit(1)
}
console.log(`PASS preflight: bundle ${new Date(libMtime).toISOString()} >= newest src ${new Date(src.mtime).toISOString()}`)

const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const netsOnPage = () => bridge.execute(`
const s = new Set();
for (const w of await eda.sch_PrimitiveWire.getAll() || []) { try { const n = w.getState_Net(); if (typeof n === 'string' && n !== '') s.add(n) } catch (e) {} }
return { nets: s.size, page: (await eda.dmt_Schematic.getCurrentSchematicPageInfo()).uuid };`, { timeoutMs: 60_000 })

const before = await netsOnPage()
console.log(`page ${before.page} carries ${before.nets} distinct wire nets`)

// Empty wire list: places nothing, but still runs the whole guard, so any
// reported loss would be a false positive on a real page.
const result = await bridge.execute(renderWireChunkScript([], before.page, 0), { timeoutMs: 60_000 })
const after = await netsOnPage()
console.log(`chunk status=${result.status} created=${result.created} failures=${JSON.stringify(result.failures)}`)
console.log(`nets after=${after.nets}`)

const problems = []
if (result.status !== 'OK') problems.push(`status ${result.status}`)
if (result.created !== 0) problems.push(`created ${result.created} != 0`)
if (!Array.isArray(result.failures) || result.failures.length !== 0) problems.push(`failures ${JSON.stringify(result.failures)}`)
if (after.nets !== before.nets) problems.push(`net count moved ${before.nets} -> ${after.nets}`)

if (problems.length > 0) {
  console.error(`FAIL ${problems.join('; ')}`)
  process.exit(1)
}
console.log(`PASS no false positive: the guard stayed quiet across ${before.nets} nets on a real page`)
