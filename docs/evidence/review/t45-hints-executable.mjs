// t45: prove that every hint printed by the freshness gate is executable.
// Each case runs the real module in a child process so process.exit is observed
// as an exit code, and every relative path quoted in the output is then checked
// against the filesystem.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../../..')
const modUrl = new URL('./shared/freshness.mjs', import.meta.url).href
const baselinePath = join(repoRoot, 'docs/evidence/review/shared/freshness-baseline.json')

const run = (code) => {
  try {
    return { exit: 0, out: execFileSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error) {
    return { exit: error.status ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}
const quoted = (text) => [...text.matchAll(/docs\/[\w./-]+\.mjs/g)].map((m) => m[0])
const cases = []

const record = (name, result) => {
  const paths = quoted(result.out)
  cases.push({
    name,
    exit: result.exit,
    paths,
    pathChecks: paths.map((p) => ({ path: p, exists: existsSync(join(repoRoot, p)) })),
    out: result.out.trim(),
  })
}

// 1. NO_BASELINE
record('NO_BASELINE', run(`const m = await import(${JSON.stringify(modUrl)}); m.gateFreshness(${JSON.stringify(repoRoot)}, { baselinePath: 'no-such-baseline.json' })`))

// 2. STALE_BUILD: copy the real baseline but corrupt one digest, so no source file is touched
const stalePath = join(tmpdir(), `t45-stale-${process.pid}.json`)
const doc = JSON.parse(readFileSync(baselinePath, 'utf8'))
doc.packages['eda-core'].sha256 = '0'.repeat(64)
writeFileSync(stalePath, JSON.stringify(doc))
record('STALE_BUILD', run(`const m = await import(${JSON.stringify(modUrl)}); m.gateFreshness(${JSON.stringify(repoRoot)}, { baselinePath: ${JSON.stringify(stalePath)} })`))

// 3. lib-missing and 4. unbaselined live in throwaway trees
const tmp = mkdtempSync(join(tmpdir(), 't45-tree-'))
try {
  mkdirSync(join(tmp, 'packages/demo/src'), { recursive: true })
  writeFileSync(join(tmp, 'packages/demo/src/a.ts'), 'export const a = 1\n')
  const treeBaseline = join(tmp, 'baseline.json')
  const real = JSON.parse(run(`const m = await import(${JSON.stringify(modUrl)}); console.log(JSON.stringify(m.snapshot(${JSON.stringify(tmp)})))`).out)
  // Pin the real digest but claim a lib exists: the tree has no lib/ directory,
  // so drift must report lib-missing rather than content.
  writeFileSync(treeBaseline, JSON.stringify({ version: 1, packages: { demo: { ...real.packages.demo, hasLib: true } } }))
  record('LIB_MISSING', run(`const m = await import(${JSON.stringify(modUrl)}); m.gateFreshness(${JSON.stringify(tmp)}, { baselinePath: ${JSON.stringify(treeBaseline)} })`))

  mkdirSync(join(tmp, 'packages/extra/src'), { recursive: true })
  writeFileSync(join(tmp, 'packages/extra/src/b.ts'), 'export const b = 1\n')
  writeFileSync(treeBaseline, JSON.stringify({ version: 1, packages: { demo: real.packages.demo } }))
  record('UNBASELINED', run(`const m = await import(${JSON.stringify(modUrl)}); m.gateFreshness(${JSON.stringify(tmp)}, { baselinePath: ${JSON.stringify(treeBaseline)} })`))
} finally {
  rmSync(tmp, { recursive: true, force: true })
  rmSync(stalePath, { force: true })
}

// 5. usage line: run the file itself so import.meta.url === argv[1]
const modulePath = join(repoRoot, 'docs/evidence/review/shared/freshness.mjs')
try {
  const out = execFileSync('node', [modulePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  record('USAGE', { exit: 0, out })
} catch (error) {
  record('USAGE', { exit: error.status ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` })
}

const broken = cases.flatMap((c) => c.pathChecks.filter((p) => !p.exists))
console.log(JSON.stringify({ status: broken.length === 0 ? 'OK' : 'DEAD_PATH', broken, cases }, null, 1))
process.exitCode = broken.length === 0 ? 0 : 1
