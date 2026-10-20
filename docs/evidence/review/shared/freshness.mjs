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
// What this module pins instead (baseline version 2, all content hashes, no
// mtime anywhere):
//   - `src/**/*.{ts,tsx,mts,cts}` per package (the compiled input);
//   - build configuration: root `package.json`, `pnpm-workspace.yaml`,
//     `tsconfig.json`, `tsconfig.base.json`, `tsdown.config.ts`, plus each
//     package's `package.json` / `tsconfig.json`. Changing any of them can
//     change the emitted bundle, so the gate must see it;
//   - `lib/index.js` digest, compared only with `--strict-lib` (or
//     `DSH_FRESHNESS_STRICT_LIB=1`). Daily runs keep it off so a legitimate
//     rebuild does not force a baseline update; release/CI runs turn it on to
//     catch "build a tampered source, then `git checkout` the source back".
//
// `--update` rewrites the baseline; run it only after a successful build
// (`npx tsc -b && npx tsdown`) on a tree whose sources are what you intend to pin.
//
// The gate runs before any bridge discovery and never performs network I/O, so
// a stale tree fails fast without touching the client.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const VERSION = 2
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo'])
const EXTS = ['.ts', '.tsx', '.mts', '.cts']
const ROOT_CONFIGS = ['package.json', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.base.json', 'tsdown.config.ts']
const PACKAGE_CONFIGS = ['package.json', 'tsconfig.json']

export const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'freshness-baseline.json')

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const hashFile = (path) => (existsSync(path) ? sha256(readFileSync(path)) : null)

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

/** Digests of the configuration files that decide what the build emits. */
export function configSnapshot(repoRoot) {
  const root = {}
  for (const file of ROOT_CONFIGS) {
    const digest = hashFile(join(repoRoot, file))
    if (digest !== null) root[file] = digest
  }
  const packages = {}
  for (const name of packageNames(repoRoot)) {
    const dir = join(repoRoot, 'packages', name)
    const files = {}
    for (const file of PACKAGE_CONFIGS) {
      const digest = hashFile(join(dir, file))
      if (digest !== null) files[file] = digest
    }
    packages[name] = files
  }
  return { root, packages }
}

/**
 * Digest of one package's source content plus its emitted bundle, independent of
 * file timestamps. `hasLib` is kept for baseline-v1 compatibility.
 */
export function fingerprint(repoRoot, name) {
  const pkg = join(repoRoot, 'packages', name)
  const src = join(pkg, 'src')
  const files = walkSource(src, [])
    .map((file) => ({ rel: relative(src, file).split(sep).join('/'), hash: sha256(readFileSync(file)) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const digest = sha256(files.map((file) => `${file.rel}\u0000${file.hash}\n`).join(''))
  const lib = hashFile(join(pkg, 'lib/index.js'))
  return { files: files.length, sha256: digest, hasLib: lib !== null, lib }
}

/** Full snapshot: one fingerprint per package plus the build-config digests. */
export function snapshot(repoRoot) {
  const packages = {}
  for (const name of packageNames(repoRoot)) packages[name] = fingerprint(repoRoot, name)
  return { version: VERSION, config: configSnapshot(repoRoot), packages }
}

export function readBaseline(path = BASELINE_PATH) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

const sameConfig = (pinned, now, scope, out) => {
  for (const [file, digest] of Object.entries(pinned)) {
    if (now?.[file] === undefined) out.push({ scope, file, reason: 'config-removed' })
    else if (now[file] !== digest) out.push({ scope, file, reason: 'config', baseline: digest, current: now[file] })
  }
  for (const file of Object.keys(now ?? {})) {
    if (pinned[file] === undefined) out.push({ scope, file, reason: 'config-added', current: now[file] })
  }
}

/**
 * Differences between a pinned baseline and a live snapshot, one entry each.
 * Baseline v1 (no `config`, no `lib` digest) stays readable: config is skipped
 * and only the boolean `hasLib` is enforced.
 */
export function drift(baseline, current, { strictLib = false } = {}) {
  const out = []
  if (baseline.config !== undefined) {
    sameConfig(baseline.config.root ?? {}, current.config.root, 'root-config', out)
    for (const [name, pinned] of Object.entries(baseline.config.packages ?? {})) {
      if (current.config.packages[name] === undefined) continue
      sameConfig(pinned, current.config.packages[name], `${name}:config`, out)
    }
  }
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
    if (pinned.lib != null && now.lib === null) {
      out.push({ package: name, reason: 'lib-missing', baseline: pinned.lib })
      continue
    }
    if (pinned.lib == null && pinned.hasLib === true && now.hasLib === false) {
      out.push({ package: name, reason: 'lib-missing', baseline: pinned.sha256 })
      continue
    }
    if (strictLib) {
      if (pinned.lib == null) out.push({ package: name, reason: 'lib-unpinned', hint: 'baseline predates lib pinning; run --update once' })
      else if (pinned.lib !== now.lib) out.push({ package: name, reason: 'lib-drift', baseline: pinned.lib, current: now.lib })
    }
  }
  for (const name of Object.keys(baseline.packages ?? {})) {
    if (current.packages[name] === undefined) out.push({ package: name, reason: 'removed' })
  }
  return out
}

const strictFromEnv = () => process.env.DSH_FRESHNESS_STRICT_LIB === '1'

/**
 * Exit 1 (before any network use) unless the tree matches the pinned baseline.
 * Returns the snapshot when fresh, so callers can report what ran.
 */
export function gateFreshness(repoRoot, { baselinePath = BASELINE_PATH, strictLib = strictFromEnv() } = {}) {
  const baseline = readBaseline(baselinePath)
  if (baseline === null) {
    console.error(JSON.stringify({
      status: 'NO_BASELINE',
      baselinePath,
      hint: 'run `node docs/evidence/review/shared/freshness.mjs --update` after a successful build',
    }))
    process.exit(1)
  }
  const current = snapshot(repoRoot)
  const problems = drift(baseline, current, { strictLib })
  if (problems.length > 0) {
    console.error(JSON.stringify({
      status: 'STALE_BUILD',
      reason: 'working tree differs from the pinned build baseline',
      strictLib,
      baselineVersion: baseline.version,
      drift: problems,
      hint: 'rebuild with `npx tsc -b && npx tsdown --config-loader native`; if the change is intended, then run `node docs/evidence/review/shared/freshness.mjs --update`',
    }, null, 1))
    process.exit(1)
  }
  return current
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  const args = process.argv.slice(2)
  const strictLib = args.includes('--strict-lib') || strictFromEnv()
  if (args.includes('--update')) {
    if (strictLib) console.error('note: --update always pins lib/index.js; --strict-lib only affects --check')
    const current = snapshot(repoRoot)
    const payload = { ...current, generatedAt: new Date().toISOString() }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(JSON.stringify({
      status: 'BASELINE_WRITTEN',
      path: BASELINE_PATH,
      packages: Object.keys(current.packages).length,
      files: Object.values(current.packages).reduce((sum, pkg) => sum + pkg.files, 0),
      configs: Object.keys(current.config.root).length + Object.values(current.config.packages).reduce((sum, cfg) => sum + Object.keys(cfg).length, 0),
      libPinned: Object.values(current.packages).filter((pkg) => pkg.lib !== null).length,
    }))
  } else if (args.includes('--check')) {
    const current = gateFreshness(repoRoot, { strictLib })
    console.log(JSON.stringify({
      status: 'FRESH',
      strictLib,
      packages: Object.keys(current.packages).length,
      files: Object.values(current.packages).reduce((sum, pkg) => sum + pkg.files, 0),
      configs: Object.keys(current.config.root).length + Object.values(current.config.packages).reduce((sum, cfg) => sum + Object.keys(cfg).length, 0),
    }))
  } else {
    console.log('usage: node docs/evidence/review/shared/freshness.mjs --update | --check [--strict-lib]')
    process.exitCode = 2
  }
}
