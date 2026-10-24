#!/usr/bin/env node
// Regression tests for t53's error classification (read-only).
//
// Why this exists: the four exit-2 reasons (BRIDGE_UNREACHABLE /
// BRIDGE_NO_EDA_WINDOW / EDA_NOT_CONNECTED / BRIDGE_WINDOW_DISCONNECTED) and the
// BRIDGE_CALL_FAILED fallback were only ever checked by hand, one env var at a
// time. Nothing pinned the exact reason strings, so a regex edit could change
// which reason a caller sees without any test turning red.
//
// What it does: runs the real gate (docs/evidence/review/t53-verify-main.mjs)
// once per case with T53_FORCE_CALL_ERROR / T53_FORCE_CALL_CODE, and asserts the
// EXACT reason string plus the exit code. It does not touch the document, the
// canvas, or the editor: the injected error is thrown before any bridge call,
// and the harness inside t53 skips discovery when T53_FORCE_CALL_ERROR is set.
//
// Read-only: every case either throws before contacting the relay, or (case e)
// performs t53's normal read-only read.
//
// Child output is captured through file descriptors, not pipes, so the script
// also works where pipe creation is restricted.

import { spawnSync } from 'node:child_process'
import { mkdirSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const gate = resolve(here, 't53-verify-main.mjs')
const workDir = resolve(here, '.t53-regression-tmp')

const EXIT_GATE_REFUSED = 2 // t53's "could not run" exit code

const cases = [
  {
    id: 'a',
    what: 'the exact string a live run produced at 12:39:01.011Z',
    env: { T53_FORCE_CALL_ERROR: 'EDA window "25883914a72e5cbb" disconnected' },
    expectReason: 'BRIDGE_WINDOW_DISCONNECTED',
  },
  {
    id: 'b1',
    what: 'wording variant "window lost"',
    env: { T53_FORCE_CALL_ERROR: 'window lost during execution' },
    expectReason: 'BRIDGE_WINDOW_DISCONNECTED',
  },
  {
    id: 'b2',
    what: 'wording variant "no such window"',
    env: { T53_FORCE_CALL_ERROR: 'requested no such window' },
    expectReason: 'BRIDGE_WINDOW_DISCONNECTED',
  },
  {
    id: 'b3',
    what: 'machine code SCHEMATIC_BRIDGE_WINDOW_LOST with a generic message',
    env: { T53_FORCE_CALL_ERROR: 'boom', T53_FORCE_CALL_CODE: 'SCHEMATIC_BRIDGE_WINDOW_LOST' },
    expectReason: 'BRIDGE_WINDOW_DISCONNECTED',
  },
  {
    id: 'b4',
    what: 'machine code SCHEMATIC_BRIDGE_DISCONNECTED with a generic message',
    env: { T53_FORCE_CALL_ERROR: 'boom', T53_FORCE_CALL_CODE: 'SCHEMATIC_BRIDGE_DISCONNECTED' },
    expectReason: 'BRIDGE_WINDOW_DISCONNECTED',
  },
  {
    id: 'c1',
    what: 'unrelated message must stay generic',
    env: { T53_FORCE_CALL_ERROR: 'some unrelated page error' },
    expectReason: 'BRIDGE_CALL_FAILED',
  },
  {
    id: 'c2',
    what: 'unrelated machine code must stay generic',
    env: { T53_FORCE_CALL_ERROR: 'boom', T53_FORCE_CALL_CODE: 'SCHEMATIC_BRIDGE_EXECUTION' },
    expectReason: 'BRIDGE_CALL_FAILED',
  },
  {
    id: 'd',
    what: 'no-window wording keeps the EDA_NOT_CONNECTED branch',
    env: { T53_FORCE_CALL_ERROR: 'not connected to any EDA window' },
    expectReason: 'EDA_NOT_CONNECTED',
  },
]

function runGate(extraEnv) {
  mkdirSync(workDir, { recursive: true })
  const outPath = join(workDir, 'stdout.json')
  const errPath = join(workDir, 'stderr.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [gate, '--json'], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', outFd, errFd],
      timeout: 180_000,
    })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const stdout = readFileSync(outPath, 'utf8')
  const stderr = readFileSync(errPath, 'utf8')
  let parsed = null
  try {
    parsed = JSON.parse(stdout)
  } catch {
    parsed = null
  }
  return { status: result.status, signal: result.signal, stdout, stderr, parsed }
}

function relayWindowCount() {
  // Read-only probe of the relay. Returns null when the relay cannot be reached.
  return new Promise((resolvePromise) => {
    fetch('http://127.0.0.1:49620/health')
      .then((r) => r.json())
      .then((h) => resolvePromise(typeof h.edaWindowCount === 'number' ? h.edaWindowCount : null))
      .catch(() => resolvePromise(null))
  })
}

async function main() {
  const lines = []
  let failures = 0
  let skipped = 0

  lines.push('[t53-classification-regression] read-only, no document access')
  lines.push('')

  for (const c of cases) {
    const r = runGate(c.env)
    const got = r.parsed && r.parsed.reason ? String(r.parsed.reason) : '(no reason; exit ' + r.status + ')'
    const gotExit = r.parsed && typeof r.parsed.exit === 'number' ? r.parsed.exit : r.status
    const reasonOk = got === c.expectReason
    const exitOk = gotExit === EXIT_GATE_REFUSED
    const ok = reasonOk && exitOk && r.status === EXIT_GATE_REFUSED
    if (!ok) failures++
    lines.push(
      (ok ? '  PASS  ' : '  FAIL  ') +
        c.id + '  ' + c.what + '\n' +
        '        expected reason=' + c.expectReason + ' exit=' + EXIT_GATE_REFUSED + '\n' +
        '        actual   reason=' + got + ' exit=' + gotExit + ' (process status ' + r.status + ')',
    )
    if (!ok && r.stderr.trim()) {
      lines.push('        stderr: ' + r.stderr.trim().split('\n')[0])
    }
  }

  // (e) no env at all: t53 must still refuse with BRIDGE_NO_EDA_WINDOW when the
  // relay has no window. When a window IS registered this branch is unreachable
  // without tearing down a live registration, so the case is reported as skipped
  // rather than silently passed.
  const count = await relayWindowCount()
  const r = runGate({})
  if (count === 0) {
    const got = r.parsed && r.parsed.reason ? String(r.parsed.reason) : '(no reason; exit ' + r.status + ')'
    const gotExit = r.parsed && typeof r.parsed.exit === 'number' ? r.parsed.exit : r.status
    const ok = got === 'BRIDGE_NO_EDA_WINDOW' && gotExit === EXIT_GATE_REFUSED
    if (!ok) failures++
    lines.push(
      (ok ? '  PASS  ' : '  FAIL  ') + 'e   no env, relay has 0 windows -> no-window branch\n' +
        '        expected reason=BRIDGE_NO_EDA_WINDOW exit=' + EXIT_GATE_REFUSED + '\n' +
        '        actual   reason=' + got + ' exit=' + gotExit + ' (process status ' + r.status + ')',
    )
  } else if (count === null) {
    skipped++
    lines.push('  SKIP  e   no env -> BRIDGE_NO_EDA_WINDOW: relay unreachable, cannot distinguish the branches')
  } else {
    // A window is registered: the run is a normal read-only gate run, which must
    // still exit 0 (5/5) rather than crash. That is a weaker but real assertion.
    const gotExit = r.parsed && typeof r.parsed.exit === 'number' ? r.parsed.exit : r.status
    const ok = r.status === 0 && gotExit === 0 && r.parsed && r.parsed.ok === true
    if (!ok) failures++
    lines.push(
      (ok ? '  PASS  ' : '  FAIL  ') + 'e   no env, but ' + count + ' window(s) registered -> gate runs instead\n' +
        '        expected exit=0 ok=true (window present, no-window branch unreachable)\n' +
        '        actual   exit=' + gotExit + ' ok=' + (r.parsed ? r.parsed.ok : '?') + ' (process status ' + r.status + ')\n' +
        '        note: BRIDGE_NO_EDA_WINDOW itself is NOT asserted in this run; it was observed live at\n' +
        '              2026-10-24T12:58:01.022Z when no window was registered (see r8t11 evidence).',
    )
  }

  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* leave the temp dir behind rather than mask a real failure */
  }

  const total = cases.length + 1
  lines.push('')
  lines.push(
    '### ' + (failures === 0 ? 'ALL GREEN' : 'FAILURES: ' + failures) +
      ' - ' + (total - failures - skipped) + '/' + total + ' passed' +
      (skipped ? ', ' + skipped + ' skipped' : '') +
      ', exit-code contract: every branch must be ' + EXIT_GATE_REFUSED,
  )
  console.log(lines.join('\n'))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('[t53-classification-regression] crashed: ' + (e && e.message))
  process.exit(1)
})
