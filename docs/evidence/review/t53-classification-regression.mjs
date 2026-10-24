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
// once per case, injecting the failure through the gate's own test hooks
// (T53_FORCE_DISCOVER_CODE / T53_FORCE_CALL_ERROR / T53_FORCE_CALL_CODE), and
// asserts the EXACT reason string plus the exit code. Every case is a hard
// assertion: none of them depends on the live relay's window state. It does not
// touch the document, the canvas, or the editor: each injected error is thrown
// before any real bridge call and is classified by the gate's own catch blocks.
//
// Read-only: no case reaches the editor; a real discover()/execute() is never
// performed while a hook is set.
//
// The gate path is overridable so the interception test can point this suite at
// a deliberately broken copy: node t53-classification-regression.mjs <gatePath>
//
// Child output is captured through file descriptors, not pipes, so the script
// also works where pipe creation is restricted.

import { spawnSync } from 'node:child_process'
import { mkdirSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const gate = process.argv[2] ? resolve(process.argv[2]) : resolve(here, 't53-verify-main.mjs')
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
  {
    id: 'e',
    what: 'discover() fails with SCHEMATIC_BRIDGE_NO_EDA -> no-window branch, no live window needed',
    // Injected at the discover() call, not at execute(): this is the branch that
    // used to be untestable because it needed the relay to have zero registered
    // windows. The message is deliberately neutral so the CODE is what decides.
    env: { T53_FORCE_DISCOVER_CODE: 'SCHEMATIC_BRIDGE_NO_EDA' },
    expectReason: 'BRIDGE_NO_EDA_WINDOW',
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

async function main() {
  const lines = []
  let failures = 0

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

  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* leave the temp dir behind rather than mask a real failure */
  }

  const total = cases.length
  lines.push('')
  lines.push(
    '### ' + (failures === 0 ? 'ALL GREEN' : 'FAILURES: ' + failures) +
      ' - ' + (total - failures) + '/' + total + ' hard assertions passed' +
      ' (every case asserts an exact reason AND exit=' + EXIT_GATE_REFUSED + '; none is conditional)',
  )
  console.log(lines.join('\n'))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('[t53-classification-regression] crashed: ' + (e && e.message))
  process.exit(1)
})
