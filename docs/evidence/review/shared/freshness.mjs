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
// What this module pins instead (baseline version 4, all content hashes, no
// mtime anywhere):
//   - `src/**/*.{ts,tsx,mts,cts}` per package (the compiled input), plus any
//     `.d.ts` outside `src/` (ambient declarations are compiled input too; they
//     are pinned under an `outside-src/` prefix);
//   - build configuration: root `package.json`, `pnpm-workspace.yaml`,
//     `tsdown.config.ts`, plus each package's `package.json`;
//   - the **recursive tsconfig closure**: every `tsconfig*.json` at the root and
//     every one inside a package at any depth, expanded along `extends`
//     (relative paths and node_modules package specifiers). A file reached only
//     through `extends` is pinned too, so editing it cannot pass unnoticed;
//   - `lib/index.js` digest, compared only with `--strict-lib` (or
//     `DSH_FRESHNESS_STRICT_LIB=1`). Daily runs keep it off so a legitimate
//     rebuild does not force a baseline update; release/CI runs turn it on to
//     catch "build a tampered source, then `git checkout` the source back".
//
// An `extends` target that cannot be resolved (or a tsconfig that cannot be
// parsed) is never skipped silently: the gate exits 1 with `EXTENDS_UNRESOLVED`
// and lists every offending file. A cycle in the `extends` chain is reported as
// `EXTENDS_CYCLE` (exit 1) with the chain: TypeScript rejects circular configs,
// so collapsing the cycle into a dedup would certify a tree tsc cannot build.
//
// Baseline v1/v2 remain readable. They predate the tsconfig closure, so a check
// against them reports `FRESH_V1_READ` / `FRESH_V2_READ` (compatibility mode)
// instead of a plain FRESH — the closure was not verified.
//
// `--update` rewrites the baseline; run it only after a successful build
// (`npx tsc -b && npx tsdown`) on a tree whose sources are what you intend to pin.
//
// `--update` refuses to pin an uncommitted tree. If any file in the pinned scope
// (anything under `packages/`, the root `package.json` / `pnpm-workspace.yaml` /
// `tsdown.config.ts`, and every `tsconfig*.json`) is modified, staged, deleted or
// untracked, it exits 3 with `UPDATE_REFUSED_DIRTY_TREE` and lists those paths —
// the baseline is not touched. Pinning uncommitted bytes is how a baseline ends up
// certifying content that never existed in any commit, so the default is refusal;
// `--force-dirty` is the deliberate escape hatch and prints a loud warning.
// A tree where `git status` cannot run at all also refuses
// (`UPDATE_REFUSED_GIT_UNAVAILABLE`), because "cannot prove clean" is not clean.
//
// The gate runs before any bridge discovery and never performs network I/O, so
// a stale tree fails fast without touching the client.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const VERSION = 4
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo'])
const EXTS = ['.ts', '.tsx', '.mts', '.cts']
const ROOT_CONFIGS = ['package.json', 'pnpm-workspace.yaml', 'tsdown.config.ts']
const PACKAGE_CONFIGS = ['package.json']
const TSCONFIG_RE = /^tsconfig.*\.json$/

export const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'freshness-baseline.json')

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const hashFile = (path) => (existsSync(path) ? sha256(readFileSync(path)) : null)
const toPosix = (path) => path.split(sep).join('/')

/** Tolerant JSON reader for tsconfig files (comments and trailing commas allowed). */
export function parseJsonc(text) {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

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

const tryFile = (candidate) => (existsSync(candidate) ? candidate : null)

/** Resolve one `extends` specifier the way TypeScript does for the common cases. */
export function resolveExtends(spec, fromFile, repoRoot) {
  const baseDir = dirname(fromFile)
  if (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) {
    const target = resolve(baseDir, spec)
    return tryFile(target) ?? tryFile(`${target}.json`)
  }
  const parts = spec.split('/')
  const scoped = spec.startsWith('@')
  const pkgName = scoped ? parts.slice(0, 2).join('/') : parts[0]
  const subPath = parts.slice(scoped ? 2 : 1).join('/')
  const relative = subPath === '' ? 'tsconfig.json' : subPath
  let dir = baseDir
  for (;;) {
    const candidate = join(dir, 'node_modules', pkgName, relative)
    const found = tryFile(candidate) ?? tryFile(`${candidate}.json`)
    if (found !== null) return found
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const rootCandidate = join(repoRoot, 'node_modules', pkgName, relative)
  return tryFile(rootCandidate) ?? tryFile(`${rootCandidate}.json`)
}

function walkTsconfigs(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && entry.name !== 'lib') walkTsconfigs(full, out)
    } else if (TSCONFIG_RE.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Every `tsconfig*.json` that the closure starts from: the root files plus every
 * one inside a package, at any depth (a `src/tsconfig.json` or a per-feature one
 * is a project root too; only node_modules/lib/dist are skipped).
 */
function tsconfigRoots(repoRoot) {
  const roots = []
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isFile() && TSCONFIG_RE.test(entry.name)) roots.push(join(repoRoot, entry.name))
  }
  for (const name of packageNames(repoRoot)) {
    walkTsconfigs(join(repoRoot, 'packages', name), roots)
  }
  return roots.sort()
}

/**
 * Recursive tsconfig closure: every file reachable through `extends`, plus any
 * file that could not be resolved or parsed (reported as a warning, never dropped).
 *
 * A node already fully expanded is not visited twice (a diamond is fine). A node
 * that reappears while it is still on the current chain is a cycle: TypeScript
 * rejects those, so the gate reports it instead of silently collapsing it.
 */
export function tsconfigClosure(repoRoot) {
  const files = {}
  const warnings = []
  const seenCycles = new Set()
  const visit = (file, chain) => {
    const rel = toPosix(relative(repoRoot, file))
    if (files[rel] !== undefined) {
      const at = chain.indexOf(rel)
      if (at >= 0) {
        const cycle = [...chain.slice(at), rel]
        const key = cycle.join(' -> ')
        if (!seenCycles.has(key)) {
          seenCycles.add(key)
          warnings.push({ file: rel, reason: 'cycle', chain: cycle })
        }
      }
      return
    }
    const raw = readFileSync(file)
    files[rel] = sha256(raw)
    let parsed
    try {
      parsed = parseJsonc(raw.toString('utf8'))
    } catch (error) {
      warnings.push({ file: rel, reason: 'parse', message: String(error?.message ?? error) })
      return
    }
    const extendsList = parsed?.extends
    const specs = Array.isArray(extendsList) ? extendsList : extendsList == null ? [] : [extendsList]
    for (const spec of specs) {
      if (typeof spec !== 'string') {
        warnings.push({ file: rel, reason: 'unresolved', extends: String(spec) })
        continue
      }
      const resolved = resolveExtends(spec, file, repoRoot)
      if (resolved === null) warnings.push({ file: rel, reason: 'unresolved', extends: spec })
      else visit(resolved, [...chain, rel])
    }
  }
  for (const root of tsconfigRoots(repoRoot)) visit(root, [])
  const sorted = {}
  for (const key of Object.keys(files).sort()) sorted[key] = files[key]
  return { files: sorted, warnings: warnings.sort((a, b) => (a.file < b.file ? -1 : 1)) }
}

/** Digests of the configuration files (outside the tsconfig closure). */
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
  const tsconfig = tsconfigClosure(repoRoot)
  return { root, packages, tsconfig: tsconfig.files, warnings: tsconfig.warnings }
}

function walkOutsideDeclarations(pkg, dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name === 'lib') continue
      if (dir === pkg && entry.name === 'src') continue
      walkOutsideDeclarations(pkg, full, out)
    } else if (entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Digest of one package's source content plus its emitted bundle, independent of
 * file timestamps. `hasLib` is kept for baseline-v1 compatibility.
 *
 * Ambient declarations outside `src/` (e.g. `types/global.d.ts`) are compiled
 * input too, so they are pinned under an `outside-src/` prefix; a package with
 * none hashes exactly as before.
 */
export function fingerprint(repoRoot, name) {
  const pkg = join(repoRoot, 'packages', name)
  const src = join(pkg, 'src')
  const inside = walkSource(src, [])
    .map((file) => ({ rel: relative(src, file).split(sep).join('/'), hash: sha256(readFileSync(file)) }))
  const outside = walkOutsideDeclarations(pkg, pkg, [])
    .map((file) => ({ rel: `outside-src/${relative(pkg, file).split(sep).join('/')}`, hash: sha256(readFileSync(file)) }))
  const files = [...inside, ...outside].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const digest = sha256(files.map((file) => `${file.rel}\u0000${file.hash}\n`).join(''))
  const lib = hashFile(join(pkg, 'lib/index.js'))
  return { files: files.length, sha256: digest, hasLib: lib !== null, lib }
}

/** Full snapshot: one fingerprint per package plus the configuration digests. */
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
 * v1/v2 baselines predate the tsconfig closure and stay readable: config is
 * skipped there and only the boolean `hasLib` is enforced.
 */
export function drift(baseline, current, { strictLib = false } = {}) {
  const out = []
  if (baseline.config !== undefined) {
    // v1/v2 pinned tsconfig files inside root/packages config. v3 pins them in
    // the recursive closure instead, so a legacy baseline must not report them
    // as removed (it cannot verify the closure, hence the FRESH_Vn_READ marker).
    const legacy = baseline.version < 3
    const keep = (files) => Object.fromEntries(Object.entries(files ?? {}).filter(([file]) => !(legacy && TSCONFIG_RE.test(file))))
    sameConfig(keep(baseline.config.root), keep(current.config.root), 'root-config', out)
    for (const [name, pinned] of Object.entries(baseline.config.packages ?? {})) {
      if (current.config.packages[name] === undefined) continue
      sameConfig(keep(pinned), keep(current.config.packages[name]), `${name}:config`, out)
    }
  }
  if (baseline.version >= 3) {
    sameConfig(baseline.config?.tsconfig ?? {}, current.config.tsconfig, 'tsconfig', out)
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
 * Returns the snapshot when fresh, annotated with the baseline version so the
 * CLI can report compatibility mode. Unresolvable `extends` always fails.
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
  if (current.config.warnings.length > 0) {
    const cycles = current.config.warnings.filter((w) => w.reason === 'cycle')
    if (cycles.length > 0) {
      console.error(JSON.stringify({
        status: 'EXTENDS_CYCLE',
        reason: 'a tsconfig extends chain loops back on itself; TypeScript rejects a circular config, so this tree cannot be certified fresh',
        cycles,
        hint: 'break the cycle (or drop the redundant extends) and re-run; a circular project must not pass as FRESH',
      }, null, 1))
      process.exit(1)
    }
    console.error(JSON.stringify({
      status: 'EXTENDS_UNRESOLVED',
      reason: 'a tsconfig extends target could not be resolved or parsed; the closure is incomplete',
      warnings: current.config.warnings,
      hint: 'fix the extends path (or the JSON) and re-run; an incomplete closure must not pass as FRESH',
    }, null, 1))
    process.exit(1)
  }
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
  return { ...current, baselineVersion: baseline.version }
}

/** True for the paths `--update` would pin: packages/**, root configs, any tsconfig. */
export function isPinnedPath(path) {
  const posix = path.split(sep).join('/')
  if (posix.startsWith('packages/')) return true
  if (ROOT_CONFIGS.includes(posix)) return true
  return TSCONFIG_RE.test(posix.split('/').pop() ?? '')
}

/**
 * Report uncommitted changes inside the pinned scope.
 *
 * "Dirty" means modified, staged, deleted, renamed or untracked — anything whose
 * bytes are not what a fresh clone of HEAD would contain. A git failure is
 * reported separately: refusing is safer than pinning unverifiable content.
 * @param repoRoot - repository root to inspect.
 * @returns `{ok:true, dirty:string[]}` or `{ok:false, error:string}`.
 */
export function dirtyPinnedPaths(repoRoot) {
  const res = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' })
  if (res.error !== undefined || res.status !== 0) {
    const detail = res.error?.message ?? res.stderr ?? `git exited ${String(res.status)}`
    return { ok: false, error: detail.trim() }
  }
  const dirty = []
  for (const line of res.stdout.split('\n')) {
    if (line.trim() === '') continue
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    path = path.replace(/^"|"$/g, '')
    if (isPinnedPath(path)) dirty.push(`${line.slice(0, 2)} ${path}`)
  }
  return { ok: true, dirty }
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  const args = process.argv.slice(2)
  const strictLib = args.includes('--strict-lib') || strictFromEnv()
  const baselineArg = args.indexOf('--baseline')
  const baselinePath = baselineArg >= 0 && args[baselineArg + 1] !== undefined ? resolve(args[baselineArg + 1]) : BASELINE_PATH
  if (args.includes('--update')) {
    const forceDirty = args.includes('--force-dirty')
    const dirty = dirtyPinnedPaths(repoRoot)
    const blocked = !dirty.ok || dirty.dirty.length > 0
    if (blocked && !forceDirty) {
      if (!dirty.ok) {
        console.error(JSON.stringify({
          status: 'UPDATE_REFUSED_GIT_UNAVAILABLE',
          reason: 'git status could not be read, so a clean tree cannot be proven',
          error: dirty.error,
          hint: 'run this inside the git checkout; --force-dirty overrides, but the baseline then certifies unverifiable bytes',
        }, null, 1))
      } else {
        console.error(JSON.stringify({
          status: 'UPDATE_REFUSED_DIRTY_TREE',
          reason: 'uncommitted changes inside the pinned scope; the baseline was not written',
          files: dirty.dirty,
          hint: 'commit or revert these paths, then re-run --update; --force-dirty pins them anyway and prints a warning',
        }, null, 1))
      }
      process.exitCode = 3
    } else {
      if (blocked) {
        console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
        console.error('!! WARNING: --force-dirty is pinning an UNCOMMITTED tree.           !!')
        console.error('!! The baseline will certify bytes that are in no commit.           !!')
        for (const entry of dirty.ok ? dirty.dirty : [`git status failed: ${dirty.error}`]) console.error(`!!   ${entry}`)
        console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
      }
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
        tsconfigs: Object.keys(current.config.tsconfig).length,
        warnings: current.config.warnings.length,
        libPinned: Object.values(current.packages).filter((pkg) => pkg.lib !== null).length,
        ...(blocked ? { forcedDirty: true } : {}),
      }))
    }
  } else if (args.includes('--check')) {
    const current = gateFreshness(repoRoot, { strictLib, baselinePath })
    const compat = current.baselineVersion < VERSION
    console.log(JSON.stringify({
      status: compat ? `FRESH_V${current.baselineVersion}_READ` : 'FRESH',
      strictLib,
      baselineVersion: current.baselineVersion,
      packages: Object.keys(current.packages).length,
      files: Object.values(current.packages).reduce((sum, pkg) => sum + pkg.files, 0),
      configs: Object.keys(current.config.root).length + Object.values(current.config.packages).reduce((sum, cfg) => sum + Object.keys(cfg).length, 0),
      tsconfigs: Object.keys(current.config.tsconfig).length,
    }))
  } else {
    console.log('usage: node docs/evidence/review/shared/freshness.mjs --update [--force-dirty] | --check [--strict-lib] [--baseline <path>]')
    process.exitCode = 2
  }
}
