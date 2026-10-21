#!/usr/bin/env node
// t53: MAIN invariant gate. Read-only, one command, verdict by exit code.
//
//   node docs/evidence/review/t53-verify-main.mjs          # human readable
//   node docs/evidence/review/t53-verify-main.mjs --json   # machine readable
//
// RUN IT BEFORE AND AFTER EVERY BRIDGE SCRIPT. The contract is the exit code:
//   0  all five invariants hold
//   1  at least one invariant broke - the diff id lists are printed
//   2  the gate could not run: bridge unreachable or the editor is not connected
//      (2 is NOT a pass: no evidence was collected)
//
// What it asserts (all against docs/evidence/current/t31-dataset.json, the
// pre-incident snapshot of the same MAIN page):
//   1. component count is 21;
//   2. by type: part = 8, netflag = 13;
//   3. the component id set equals the baseline id set, BOTH directions empty
//      (not just the same count - a swap of one id for another must fail);
//   4. 55 wires and the wire `id|net` pair set equals the baseline pair set;
//   5. the page count and the MAIN page uuid are unchanged.
//
// On the page assertion: t31 recorded 18 pages (MAIN + 17 orphan probe pages
// that cannot be deleted, see 14.35.8). Page ids also die when the editor window
// re-registers, so a fixed 18 would fail forever. The gate therefore pins the
// current, reviewed value (2: MAIN + one P1) and the MAIN uuid from t31; both are
// overridable (--pages=N) but a change must be a deliberate edit, not drift.
//
// Strictly read-only: getAll(undefined,false), the wire list and the page list.
// No save, no delete, no create, no modify, no openDocument. The only mutation is
// an in-memory one used by the test hooks below; it never reaches the editor.
//
// Test hooks (self-proof, no writes to the document):
//   T53_INJECT_EXTRA_ID=deadbeefdeadbeef   pretend a stray component exists -> 1
//   T53_DROP_COMPONENT=u1                  pretend a baseline component vanished -> 1
//   T53_DROP_WIRE='layout:wire:_3V3:flags' pretend one wire pair vanished -> 1
//   T53_FORCE_UNREACHABLE=1                exercise the BRIDGE_UNREACHABLE path -> 2
//   T53_FORCE_NO_EDA=1                     exercise the EDA_NOT_CONNECTED path -> 2

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}
const finish = (code) => setTimeout(() => process.exit(code), 250)

const baseline = JSON.parse(readFileSync(resolve(repo, 'docs/evidence/current/t31-dataset.json'), 'utf8'))
const baselineIds = new Set(baseline.comps.map((c) => String(c.PrimitiveId)))
const baselinePairs = new Set(baseline.wires.map((w) => `${w.PrimitiveId}|${w.Net ?? ''}`))
const baselineMain = baseline.main.uuid
const expectedPages = Number(arg('pages', '2'))

const result = {
  at: new Date().toISOString(),
  gate: 'MAIN invariants',
  readOnly: true,
  baseline: { source: 'docs/evidence/current/t31-dataset.json', components: baselineIds.size, wires: baselinePairs.size, main: baselineMain, pages: expectedPages },
  checks: [],
  exit: null,
}

const fail = (reason, detail) => {
  result.exit = 2
  result.ok = false
  result.reason = reason
  result.detail = detail
  emit()
  throw new Error('__T53_BAIL__')
}
const emit = () => {
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 1) + '\n')
    return
  }
  if (result.exit === 2) {
    process.stdout.write(`[t53] CANNOT JUDGE (${result.reason}): ${result.detail}\n`)
    process.stdout.write('[t53] no invariant was evaluated; this is exit 2, not a pass\n')
    return
  }
  process.stdout.write('[t53] MAIN invariant gate - read-only\n')
  for (const c of result.checks) {
    process.stdout.write(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}\n`)
    for (const line of c.evidence ?? []) process.stdout.write(`        ${line}\n`)
  }
  process.stdout.write(`[t53] ${result.ok ? 'PASS' : 'FAIL'} exit ${result.exit}\n`)
}

async function main() {
  if (process.env.T53_FORCE_UNREACHABLE === '1') {
    fail('BRIDGE_UNREACHABLE', 'forced by T53_FORCE_UNREACHABLE=1')
  } else if (process.env.T53_FORCE_NO_EDA === '1') {
    fail('EDA_NOT_CONNECTED', 'forced by T53_FORCE_NO_EDA=1')
  }

  const { HttpEasyEdaBridge } = await import(pathToFileURL(resolve(repo, 'packages/eda-core/lib/index.js')).href)

  let bridge
  try {
    bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 15_000 })
  } catch (e) {
    fail('BRIDGE_UNREACHABLE', String((e && e.message) || e).slice(0, 200))
  }

  const READ = `
  const all = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
  const wires = (await eda.sch_PrimitiveWire.getAll()) || [];
  const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: String(p.uuid), name: String(p.name) }));
  const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
  return {
    comps: all.map(c => ({ id: String(c.primitiveId || c.id), type: String(c.componentType || '') })),
    wires: wires.map(w => ({ id: String(w.primitiveId || w.id || ''), net: String(w.net || '') })),
    pages,
    active: active && String(active.uuid),
  };
  `

  let live
  try {
    live = await bridge.execute(READ, { timeoutMs: 120_000 })
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200)
    if (/NO_EDA|not connected|edaConnected/i.test(msg)) fail('EDA_NOT_CONNECTED', msg)
    fail('BRIDGE_CALL_FAILED', msg)
  }

  // ---- in-memory test hooks (never touch the document) ----
  if (process.env.T53_INJECT_EXTRA_ID) live.comps.push({ id: process.env.T53_INJECT_EXTRA_ID, type: 'netflag' })
  if (process.env.T53_DROP_COMPONENT) live.comps = live.comps.filter((c) => c.id !== process.env.T53_DROP_COMPONENT)
  if (process.env.T53_DROP_WIRE) live.wires = live.wires.filter((w) => w.id !== process.env.T53_DROP_WIRE)

  const liveIds = new Set(live.comps.map((c) => c.id))
  const livePairs = new Set(live.wires.map((w) => `${w.id}|${w.net}`))
  const parts = live.comps.filter((c) => c.type === 'part')
  const flags = live.comps.filter((c) => c.type === 'netflag')
  const extraIds = live.comps.map((c) => c.id).filter((id) => !baselineIds.has(id))
  const missingIds = [...baselineIds].filter((id) => !liveIds.has(id))
  const extraPairs = [...livePairs].filter((p) => !baselinePairs.has(p))
  const missingPairs = [...baselinePairs].filter((p) => !livePairs.has(p))
  const mainPage = live.pages.find((p) => p.uuid === baselineMain)

  const check = (name, pass, detail, evidence = []) => result.checks.push({ name, pass, detail, evidence })

  check('components = 21', live.comps.length === baselineIds.size, `${live.comps.length} / expected ${baselineIds.size}`)
  check('part = 8, netflag = 13', parts.length === 8 && flags.length === 13, `part=${parts.length} netflag=${flags.length}`, parts.length !== 8 || flags.length !== 13 ? [`other types: ${live.comps.length - parts.length - flags.length}`] : [])
  check(
    'component id set = baseline (both directions)',
    extraIds.length === 0 && missingIds.length === 0,
    `extra=${extraIds.length} missing=${missingIds.length}`,
    [...extraIds.map((id) => `+ ${id} (not in baseline)`), ...missingIds.map((id) => `- ${id} (missing from MAIN)`), ...(live.comps.length !== liveIds.size ? [`duplicate ids in the read: ${live.comps.length - liveIds.size}`] : [])],
  )
  check(
    'wires = 55 and id|net pairs = baseline',
    live.wires.length === baselinePairs.size && extraPairs.length === 0 && missingPairs.length === 0,
    `wires=${live.wires.length} pairs=${livePairs.size} extra=${extraPairs.length} missing=${missingPairs.length}`,
    [...extraPairs.map((p) => `+ ${p} (unexpected wire pair)`), ...missingPairs.map((p) => `- ${p} (wire pair missing)`)],
  )
  check(
    'pages unchanged, MAIN id intact',
    live.pages.length === expectedPages && Boolean(mainPage),
    `pages=${live.pages.length} MAIN=${mainPage ? 'present' : 'MISSING'} active=${live.active}`,
    [...(live.pages.length !== expectedPages ? [`pages: ${live.pages.map((p) => `${p.name}/${p.uuid.slice(0, 8)}`).join(', ')}`] : []), ...(mainPage ? [] : [`MAIN ${baselineMain} not in the page list`])],
  )

  result.ok = result.checks.every((c) => c.pass)
  result.counts = {
    components: live.comps.length,
    part: parts.length,
    netflag: flags.length,
    wires: live.wires.length,
    wirePairs: livePairs.size,
    pages: live.pages.length,
  }
  result.exit = result.ok ? 0 : 1
  result.diff = { extraIds, missingIds, extraPairs, missingPairs }
  emit()
  finish(result.exit)

}

try {
  await main()
} catch (e) {
  if (e && e.message === '__T53_BAIL__') {
    await new Promise((r) => setTimeout(r, 400))
    process.exit(2)
  }
  if (!asJson) process.stdout.write(`[t53] UNEXPECTED ${String((e && e.message) || e)}\n`)
  process.exit(2)
}