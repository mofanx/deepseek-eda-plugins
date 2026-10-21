// freshness-selftest.mjs — offline cases for the freshness gate's boundary fixes.
//
// The gate exits a process, so the only honest way to test it is to run it.
// Every case builds a throwaway repository under the OS temp dir, copies the
// real `freshness.mjs` next to it, and spawns that copy. The real repository is
// never written to; the temp roots are removed at the end.
//
// The three boundaries under test, all of which used to pass silently:
//   1. an `extends` cycle was collapsed into a dedup, so a config tsc rejects
//      could still certify FRESH;
//   2. only root and top-level package tsconfigs were roots, so a tsconfig at
//      any deeper path was invisible unless somebody extended it;
//   3. a `.d.ts` outside `src/` was not hashed at all, so editing one could not
//      invalidate the baseline.
//
// Usage: node docs/evidence/review/shared/freshness-selftest.mjs
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// `--gate <path>` lets a mutation experiment point the cases at a modified copy,
// so the real file is never edited just to prove the cases can go red.
const gateArg = process.argv.indexOf('--gate')
const realGate = gateArg >= 0 && process.argv[gateArg + 1] !== undefined
  ? resolve(process.argv[gateArg + 1])
  : join(here, 'freshness.mjs')
const cases = []

const write = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

/** A minimal workspace: root configs plus one package with a src file. */
function makeRepo(tag) {
  const root = mkdtempSync(join(tmpdir(), `freshness-${tag}-`))
  cpSync(realGate, join(root, 'docs/evidence/review/shared/freshness.mjs'))
  write(root, 'package.json', '{"name":"fixture","private":true}\n')
  write(root, 'pnpm-workspace.yaml', "packages:\n  - packages/*\n")
  write(root, 'tsdown.config.ts', 'export default {}\n')
  write(root, 'packages/p1/package.json', '{"name":"p1"}\n')
  write(root, 'packages/p1/src/a.ts', 'export const a = 1\n')
  return root
}

const run = (root, args) => {
  const script = join(root, 'docs/evidence/review/shared/freshness.mjs')
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  let json = null
  // --update prints its result on stdout and banners on stderr; failures do the
  // opposite. Try both rather than assuming one channel.
  for (const stream of [res.stdout, res.stderr]) {
    try {
      json = JSON.parse(stream.trim())
      break
    } catch {
      json = null
    }
  }
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim(), json }
}

const check = (name, ok, detail) => cases.push({ name, ok, detail })

// ---------------------------------------------------------------- fixture A
{
  const root = makeRepo('tsconfig')
  // A tsconfig two levels deep: invisible to the old root scan, and a root here.
  write(root, 'packages/p1/tsconfig.json', '{"extends":"./nested/tsconfig.base.json"}\n')
  write(root, 'packages/p1/nested/tsconfig.base.json', '{"compilerOptions":{"strict":true}}\n')

  const up = run(root, ['--update', '--force-dirty'])
  check('A1 update writes a v4 baseline', up.status === 0 && up.json?.status === 'BASELINE_WRITTEN', up.json)
  check('A2 nested tsconfig counted as a root (2, not 1)', up.json?.tsconfigs === 2, `tsconfigs=${up.json?.tsconfigs}`)

  const fresh = run(root, ['--check'])
  check('A3 clean tree is FRESH', fresh.status === 0 && fresh.json?.status === 'FRESH', fresh.json)

  // Cycle: nested config extends back to its own parent.
  write(root, 'packages/p1/nested/tsconfig.base.json', '{"extends":"../tsconfig.json"}\n')
  const cycle = run(root, ['--check'])
  const chain = cycle.json?.cycles?.[0]?.chain
  check(
    'A4 extends cycle fails closed with the chain',
    cycle.status === 1 && cycle.json?.status === 'EXTENDS_CYCLE' && Array.isArray(chain) && chain.length === 3 && chain[0] === chain[2],
    cycle.json,
  )

  // Restore the acyclic shape: FRESH again, and the detector is not sticky.
  write(root, 'packages/p1/nested/tsconfig.base.json', '{"compilerOptions":{"strict":true}}\n')
  const restored = run(root, ['--check'])
  check('A5 restoring the config restores FRESH', restored.status === 0 && restored.json?.status === 'FRESH', restored.json)

  // Diamond: same base reached twice, which is legitimate and must stay quiet.
  // Re-pin first: rewriting the config is real drift, and this case is about the
  // absence of a false cycle, not about drift.
  write(root, 'packages/p1/tsconfig.json', '{"extends":["./nested/a.json","./nested/b.json"]}\n')
  write(root, 'packages/p1/nested/a.json', '{"extends":"./base.json"}\n')
  write(root, 'packages/p1/nested/b.json', '{"extends":"./base.json"}\n')
  write(root, 'packages/p1/nested/base.json', '{"compilerOptions":{"strict":true}}\n')
  run(root, ['--update', '--force-dirty'])
  const diamond = run(root, ['--check'])
  check('A6 diamond is not reported as a cycle', diamond.status === 0 && diamond.json?.status === 'FRESH', diamond.json)

  // Unresolved extends keeps its old failure mode (regression).
  write(root, 'packages/p1/tsconfig.json', '{"extends":"./missing.json"}\n')
  const unresolved = run(root, ['--check'])
  check('A7 unresolved extends still fails', unresolved.status === 1 && unresolved.json?.status === 'EXTENDS_UNRESOLVED', unresolved.json)

  rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------- fixture B
{
  const root = makeRepo('decls')
  write(root, 'packages/p1/tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
  const dts = 'packages/p1/types/global.d.ts'
  const body = 'declare const ambient: number\n'

  const before = run(root, ['--update', '--force-dirty'])
  check('B1 baseline written without the declaration', before.status === 0 && before.json?.status === 'BASELINE_WRITTEN', before.json)
  check('B2 exactly one source file before the declaration', before.json?.files === 1, `files=${before.json?.files}`)

  // Adding a declaration outside src is a real change to compiled input.
  write(root, dts, body)
  const added = run(root, ['--check'])
  const driftAdded = added.json?.drift?.[0]
  check('B3 a new .d.ts outside src is STALE, not ignored', added.status === 1 && added.json?.status === 'STALE_BUILD' && driftAdded?.reason === 'content', added.json)

  // Pin it, then edit it: the bytes must be watched from now on.
  const pin = run(root, ['--update', '--force-dirty'])
  check('B4 pinning includes the declaration', pin.status === 0 && pin.json?.files === 2, `files=${pin.json?.files}`)
  const pinned = run(root, ['--check'])
  check('B5 pinned declaration is FRESH', pinned.status === 0 && pinned.json?.status === 'FRESH', pinned.json)

  write(root, dts, `${body}// edited\n`)
  const edited = run(root, ['--check'])
  check('B6 editing the declaration is STALE', edited.status === 1 && edited.json?.status === 'STALE_BUILD', edited.json)

  write(root, dts, body)
  const reverted = run(root, ['--check'])
  check('B7 restoring the bytes restores FRESH', reverted.status === 0 && reverted.json?.status === 'FRESH', reverted.json)

  rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------- report
let failed = 0
for (const entry of cases) {
  if (!entry.ok) failed += 1
  const detail = entry.ok ? '' : ` :: ${JSON.stringify(entry.detail)}`
  console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${detail}`)
}
console.log(`\n${cases.length - failed}/${cases.length} cases passed`)
process.exitCode = failed === 0 ? 0 : 1
