// Content-based freshness gate shared by the evidence scripts under docs/evidence/review.
//
// Why not mtime. The first version of these gates compared
// `max(src/**/*.ts mtime) > max(lib/**/*.js mtime)`. That is wrong in both
// directions:
//   - false stale: `git checkout -- <file>` restores the bytes but rewrites the
//     mtime, so a tree whose content is byte-identical to HEAD can still look
//     "newer than lib" and be rejected. Every revert after a mutation probe
//     triggers it.
//   - no discrimination: a genuine edit and a restored file produce the same
//     STALE_BUILD output, so the operator cannot tell "rebuild needed" from
//     "you touched the clock".
//
// What this module does instead. It pins a SHA-256 digest of every package's
// `src/**/*.ts` in a committed baseline (freshness-baseline.json) and compares
// digests. mtime is never read. `--update` rewrites the baseline; run it only
// after a successful build on a tree whose sources are what you intend to pin.
//
// The gate runs before any bridge discovery and never performs network I/O, so
// a stale tree fails fast without touching the client.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const VERSION = 1
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo'])
const EXTS = ['.ts', '.tsx', '.mts', '.cts']

export const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'freshness-baseline.json')

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function walkSource(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkSource(full, out)
    } else if (EXTS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

/** Package directory names under `packages/` that own a `src/` directory. */
export function packageNames(repoRoot) {
  const root = join(repoRoot, 'packages')
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'src')))
    .map((entry) => entry.name)
    .sort()
}

/** Digest of one package's source content, independent of file timestamps. */
export function fingerprint(repoRoot, name) {
  const pkg = join(repoRoot, 'packages', name)
  const src = join(pkg, 'src')
  const files = walkSource(src, [])
    .map((file) => ({ rel: relative(src, file).split(sep).join('/'), hash: sha256(readFileSync(file)) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const digest = sha256(files.map((file) => `${file.rel}\u0000${file.hash}\n`).join(''))
  return { files: files.length, sha256: digest, hasLib: existsSync(join(pkg, 'lib')) }
}

/** Full snapshot: one fingerprint per package. */
export function snapshot(repoRoot) {
  const packages = {}
  for (const name of packageNames(repoRoot)) packages[name] = fingerprint(repoRoot, name)
  return { version: VERSION, packages }
}

export function readBaseline(path = BASELINE_PATH) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Differences between a pinned baseline and a live snapshot, one entry each. */
export function drift(baseline, current) {
  const out = []
  for (const [name, now] of Object.entries(current.packages)) {
    const pinned = baseline.packages?.[name]
    if (pinned === undefined) {
      out.push({ package: name, reason: 'unbaselined', current: now.sha256, files: now.files })
      continue
    }
    if (pinned.sha256 !== now.sha256) {
      out.push({ package: name, reason: 'content', baseline: pinned.sha256, current: now.sha256, files: now.files })
      continue
    }
    if (pinned.hasLib && !now.hasLib) out.push({ package: name, reason: 'lib-missing', baseline: pinned.sha256, current: now.sha256 })
  }
  for (const name of Object.keys(baseline.packages ?? {})) {
    if (current.packages[name] === undefined) out.push({ package: name, reason: 'removed' })
  }
  return out
}

/**
 * Exit 1 (before any network use) unless the source content matches the pinned
 * baseline. Returns the snapshot when fresh, so callers can report what ran.
 */
export function gateFreshness(repoRoot, { baselinePath = BASELINE_PATH } = {}) {
  const baseline = readBaseline(baselinePath)
  if (baseline === null) {
    console.error(JSON.stringify({
      status: 'NO_BASELINE',
      baselinePath,
      hint: 'run `node docs/evidence/review/lib/freshness.mjs --update` after a successful build',
    }))
    process.exit(1)
  }
  const current = snapshot(repoRoot)
  const problems = drift(baseline, current)
  if (problems.length > 0) {
    console.error(JSON.stringify({
      status: 'STALE_BUILD',
      reason: 'source content differs from the pinned build baseline',
      drift: problems,
      hint: 'rebuild with `npx tsc -b`; if the source change is intended, then run `node docs/evidence/review/lib/freshness.mjs --update`',
    }, null, 1))
    process.exit(1)
  }
  return current
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  const args = process.argv.slice(2)
  if (args.includes('--update')) {
    const current = snapshot(repoRoot)
    const payload = { ...current, generatedAt: new Date().toISOString() }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(JSON.stringify({
      status: 'BASELINE_WRITTEN',
      path: BASELINE_PATH,
      packages: Object.keys(current.packages).length,
      files: Object.values(current.packages).reduce((sum, pkg) => sum + pkg.files, 0),
    }))
  } else if (args.includes('--check')) {
    const current = gateFreshness(repoRoot)
    console.log(JSON.stringify({
      status: 'FRESH',
      packages: Object.keys(current.packages).length,
      files: Object.values(current.packages).reduce((sum, pkg) => sum + pkg.files, 0),
    }))
  } else {
    console.log('usage: node docs/evidence/review/lib/freshness.mjs --update | --check')
    process.exitCode = 2
  }
}
