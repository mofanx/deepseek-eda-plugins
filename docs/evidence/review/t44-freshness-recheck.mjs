// t44: independent recheck of the content-hash freshness gate (read-only review).
// Runs the four-state matrix the old mtime gate failed on, then probes the
// bypass surface. Every mutation is restored from git and the file hash is
// compared with the HEAD blob before the script exits.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../../..')
const rel = 'packages/eda-core/src/serialize.ts'
const abs = join(repoRoot, rel)
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const git = (args) => execFileSync('git', ['-c', `safe.directory=${repoRoot.replace(/\\/g, '/')}`, ...args], { cwd: repoRoot, encoding: 'utf8' })
const headSha = sha256(Buffer.from(git(['show', `HEAD:${rel}`]), 'utf8'))
const fileSha = () => sha256(readFileSync(abs))

// The old gate, reproduced verbatim from 3b98085^:docs/evidence/review/t41-cross-review-t5.mjs
const newest = (dir, ext) => {
  let m = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(f) }
      else if (e.name.endsWith(ext)) m = Math.max(m, statSync(f).mtimeMs)
    }
  }
  if (existsSync(dir)) walk(dir)
  return m
}
const oldVerdict = () => {
  const g = { src: newest(join(repoRoot, 'packages/eda-core/src'), '.ts'), lib: newest(join(repoRoot, 'packages/eda-core/lib'), '.js') }
  return { stale: g.lib < g.src, src: g.src, lib: g.lib }
}

const { snapshot, drift, readBaseline } = await import(new URL('./shared/freshness.mjs', import.meta.url).href)
const baseline = readBaseline()
const newVerdict = () => drift(baseline, snapshot(repoRoot))

const steps = []
const record = (label, extra = {}) => {
  const o = oldVerdict()
  const d = newVerdict()
  steps.push({ label, fileSha: fileSha().slice(0, 8), headSha: headSha.slice(0, 8), equalsHead: fileSha() === headSha, old: o.stale ? 'STALE' : 'FRESH', new: d.length === 0 ? 'FRESH' : `STALE(${d.map((x) => x.reason).join(',')})`, ...extra })
}

try {
  record('A current tree')

  const t = new Date(Date.now() + 5000)
  utimesSync(abs, t, t)
  record('B touch mtime only, bytes unchanged')

  writeFileSync(abs, `${readFileSync(abs, 'utf8')}\n// t44 probe: content differs\n`)
  record('C real content change (unbuilt)')

  git(['checkout', '--', rel])
  record('D git checkout restore, mtime rewritten')

  // Bypass probes. A new source file is detectable (content digest), a new
  // package is detectable (unbaselined), a tsconfig change is not in scope.
  const extra = join(repoRoot, 'packages/eda-core/src/__t44-probe.ts')
  writeFileSync(extra, 'export const t44 = 1\n')
  const withExtraFile = newVerdict()
  rmSync(extra)
  const pkgDir = join(repoRoot, 'packages/__t44-probe/src')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'index.ts'), 'export const t44 = 1\n')
  const withExtraPkg = newVerdict()
  rmSync(join(repoRoot, 'packages/__t44-probe'), { recursive: true, force: true })

  const restored = fileSha() === headSha
  console.log(JSON.stringify({
    status: restored ? 'OK' : 'RESTORE_FAILED',
    headBlobSha256: headSha,
    steps,
    bypass: {
      newSourceFile: withExtraFile.length > 0 ? withExtraFile.map((x) => x.reason) : [],
      newPackage: withExtraPkg.length > 0 ? withExtraPkg.map((x) => x.reason) : [],
    },
  }, null, 1))
  process.exitCode = restored ? 0 : 1
} finally {
  git(['checkout', '--', rel])
}
