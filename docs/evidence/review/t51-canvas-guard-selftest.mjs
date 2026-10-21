// t51: offline self-test for the canvas-ownership guard. No bridge, no browser.
//
// The guard decides "is the canvas painting my probe?" from two screenshots. That is
// a heuristic, so the only thing worth testing offline is its DECISION TABLE: every
// failure mode must refuse, and no accepted path may report a write. The frame
// capture and the pixel diff are injected here; the real ones are exercised by the
// live runs (t28/t29/t32), which is where they can actually fail.
//
// Cases:
//   A  frames differ            -> allow, wrote=0
//   B  frames identical (MAIN)  -> refuse CANVAS_NOT_ON_PROBE, wrote=0
//   C  ratio below threshold    -> refuse CANVAS_NOT_ON_PROBE (0.001 < 0.002)
//   D  screenshot fails         -> refuse SHOT_FAILED (fail-closed)
//   E  probe === MAIN           -> refuse PROBE_IS_MAIN, and no openDocument at all
//   F  cached verdict, active id switched -> cache is dropped, re-tested

import { assertOwnCanvas, makeWriteGuard } from './shared/canvas-owner.mjs'

const PROBE = 'probe-page-0001'
const MAIN = 'main-page-0001'

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
}

function makeFakes({ ratio = 0.5, shootThrows = false, shootNull = false, activeAfterOpen = null } = {}) {
  const state = { active: MAIN, opened: [], writes: 0, shots: 0 }
  const readActive = async () => state.active
  const openDocument = async (id) => {
    state.opened.push(id)
    state.active = id
    if (activeAfterOpen) state.active = activeAfterOpen(id)
    state.writes += 0 // page switch is not a write; kept explicit for clarity
  }
  const shoot = async (file) => {
    state.shots++
    if (shootThrows) throw new Error('dpx failed')
    if (shootNull) return null
    return file
  }
  const diff = async () => {
    // The fake canvas paints the probe only when the probe is the active id, unless
    // the case deliberately asks for a different ratio.
    const r = state.active === PROBE ? ratio : 0
    return { ratio: r, diffPixels: Math.round(r * 1000), totalPixels: 1000 }
  }
  return { state, readActive, openDocument, shoot, diff }
}

// ---- A: frames differ -> allow
{
  const f = makeFakes({ ratio: 0.42 })
  const v = await assertOwnCanvas({ probe: PROBE, main: MAIN, readActive: f.readActive, openDocument: f.openDocument, shoot: f.shoot, diff: f.diff, settleMs: 0 })
  record('A canvas=probe -> allow', v.ok === true && v.reason === 'CANVAS_ON_PROBE' && v.wrote === 0,
    { ok: v.ok, reason: v.reason, ratio: v.frames?.diff?.ratio, shots: f.state.shots })
}

// ---- B: frames identical -> refuse
{
  const f = makeFakes({ ratio: 0 })
  const v = await assertOwnCanvas({ probe: PROBE, main: MAIN, readActive: f.readActive, openDocument: f.openDocument, shoot: f.shoot, diff: f.diff, settleMs: 0 })
  record('B canvas=MAIN -> refuse', v.ok === false && v.reason === 'CANVAS_NOT_ON_PROBE' && v.wrote === 0,
    { ok: v.ok, reason: v.reason, ratio: v.frames?.diff?.ratio })
}

// ---- C: below threshold -> refuse
{
  const f = makeFakes({ ratio: 0.001 })
  const v = await assertOwnCanvas({ probe: PROBE, main: MAIN, readActive: f.readActive, openDocument: f.openDocument, shoot: f.shoot, diff: f.diff, settleMs: 0, minRatio: 0.002 })
  record('C ratio 0.001 < 0.002 -> refuse', v.ok === false && v.reason === 'CANVAS_NOT_ON_PROBE',
    { ok: v.ok, reason: v.reason, ratio: v.frames?.diff?.ratio, minRatio: 0.002 })
}

// ---- D: screenshot fails -> fail-closed
{
  const f = makeFakes({ shootNull: true })
  const v = await assertOwnCanvas({ probe: PROBE, main: MAIN, readActive: f.readActive, openDocument: f.openDocument, shoot: f.shoot, diff: f.diff, settleMs: 0 })
  record('D screenshot fails -> refuse', v.ok === false && v.reason === 'SHOT_FAILED' && v.wrote === 0,
    { ok: v.ok, reason: v.reason })
}

// ---- E: probe === MAIN -> refuse before touching the client
{
  const f = makeFakes({})
  const v = await assertOwnCanvas({ probe: MAIN, main: MAIN, readActive: f.readActive, openDocument: f.openDocument, shoot: f.shoot, diff: f.diff, settleMs: 0 })
  record('E probe===MAIN -> refuse', v.ok === false && v.reason === 'PROBE_IS_MAIN' && f.state.opened.length === 0 && f.state.shots === 0,
    { ok: v.ok, reason: v.reason, opened: f.state.opened.length, shots: f.state.shots })
}

// ---- F: cached verdict is dropped when the active id leaves the probe
{
  const f = makeFakes({ ratio: 0.42 })
  const guard = makeWriteGuard({
    probe: PROBE, main: MAIN,
    readActive: f.readActive, openDocument: f.openDocument, shoot: f.shoot, diff: f.diff,
    settleMs: 0, ttlMs: 60_000,
  })
  const first = await guard('first')
  const shotsAfterFirst = f.state.shots
  const cached = await guard('second')
  const shotsAfterCached = f.state.shots
  f.state.active = MAIN // someone else takes the canvas
  const afterSwitch = await guard('third')
  record('F cache drops on active switch',
    first.ok === true && first.cached === false &&
    cached.ok === true && cached.cached === true && shotsAfterCached === shotsAfterFirst &&
    afterSwitch.cached === false && f.state.shots > shotsAfterFirst,
    {
      first: { ok: first.ok, cached: first.cached },
      second: { ok: cached.ok, cached: cached.cached, shotsAfterCached },
      third: { ok: afterSwitch.ok, cached: afterSwitch.cached, shots: f.state.shots, reason: afterSwitch.reason },
    })
}

// ---- G: a client that cannot pin the probe -> refuse (fail-closed, not "assume ok")
{
  const f = makeFakes({ ratio: 0.42, activeAfterOpen: (id) => (id === PROBE ? MAIN : id) })
  const v = await assertOwnCanvas({ probe: PROBE, main: MAIN, readActive: f.readActive, openDocument: f.openDocument, shoot: f.shoot, diff: f.diff, settleMs: 0 })
  record('G probe cannot be pinned -> refuse', v.ok === false && v.reason === 'PROBE_NOT_ACTIVE' && v.wrote === 0,
    { ok: v.ok, reason: v.reason, opened: f.state.opened })
}

const passed = results.filter((r) => r.pass).length
const failed = results.filter((r) => !r.pass)
console.log(JSON.stringify({ status: failed.length === 0 ? 'OK' : 'FAIL', passed, total: results.length, cases: results }, null, 1))
process.exitCode = failed.length === 0 ? 0 : 1
