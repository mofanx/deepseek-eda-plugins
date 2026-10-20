// t46: one-shot codemod moving the 13 remaining mtime gates onto the shared
// content-hash gate. Read the notes at the bottom for the shapes it could not
// unify and why the reported gate state changes shape.
//
// Run: node docs/evidence/review/t46-codemod-mtime-gate.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../../..')
const dir = join(repoRoot, 'docs/evidence/review')

const TARGETS = [
  't26-wire-net-guard.mjs', 't27-flag-stagger.mjs', 't28-label-overlap.mjs', 't29-flag-stagger-readback.mjs',
  't30-cross-review-t2.mjs', 't31-overlap-classify.mjs', 't32-flag-glyph-size.mjs', 't33-flag-glyph-crosscheck.mjs',
  't33-verify-t31-classify.mjs', 't34-cross-review-t6b.mjs', 't35-count-definitions.mjs', 't36-cross-review-t10.mjs',
  't37-flag-component-type.mjs',
]

// Shapes, in application order. Every helper ends with a column-0 brace, so the
// non-greedy `[\s\S]*?^\}` stops at the right place; inner braces are indented.
const REMOVALS = [
  ['helper newest(dir, ext)', /^const newest = \(dir, ext\) => \{\n[\s\S]*?^\}\n/m],
  ['helper newest(dir)', /^const newest = \(dir\) => \{\n[\s\S]*?^\}\n/m],
  ['helper newestMtime', /^function newestMtime\(dir, ext\) \{\n[\s\S]*?^\}\n/m],
  ['gate via newest()', /^const gate = \{ src: newest\([^\n]*\n/m],
  ['gate via newestMtime()', /^const gate = \{ src: newestMtime\([^\n]*\n/m],
  ['gate.fresh assignment', /^gate\.fresh = gate\.lib >= gate\.src\n/m],
  ['inline if gate', /^if \(gate\.lib < gate\.src\) \{ console\.error\([^\n]*\n/m],
  ['block if gate', /^if \(gate\.lib < gate\.src\) \{\n[\s\S]*?^\}\n/m],
  ['block if !gate.fresh', /^if \(!gate\.fresh\) \{\n[\s\S]*?^\}\n/m],
  ['t26 src', /^const src = newest\(join\(repo,[^\n]*\n/m],
  ['t26 lib', /^const lib = join\(repo,[^\n]*\n/m],
  ['t26 libMtime', /^const libMtime = statSync\(lib\)\.mtimeMs\n/m],
  ['t26 if', /^if \(libMtime < src\.mtime\) \{\n[\s\S]*?^\}\n/m],
  ['t26 PASS line', /^console\.log\(`PASS preflight[^\n]*\n/m],
  ['gateSrc', /^const gateSrc = newestMtime\([^\n]*\n/m],
  ['gateLib', /^const gateLib = newestMtime\([^\n]*\n/m],
  ['schematicLib', /^const schematicLib = newestMtime\([^\n]*\n/m],
  ['schematicSrc', /^const schematicSrc = newestMtime\([^\n]*\n/m],
  ['gatePkg', /^const gatePkg = '[^']*'\n/m],
  ['repoNewestSrc', /^const repoNewestSrc = Math\.max\([\s\S]*?\.map\([^\n]*\n/m],
  ['multi-line freshness', /^const freshness = \{\n[\s\S]*?^\}\n/m],
  ['single-line freshness', /^const freshness = \{[^\n]*\n/m],
  ['block if !freshness.fresh', /^if \(!freshness\.fresh\) \{\n[\s\S]*?^\}\n/m],
  ['block if !freshness.edaCore.fresh', /^if \(!freshness\.edaCore\.fresh\) \{\n[\s\S]*?^\}\n/m],
  ['block if !freshness.gate.fresh', /^if \(!freshness\.gate\.fresh\) \{\n[\s\S]*?^\}\n/m],
  ['block if gateLib < gateSrc', /^if \(gateLib < gateSrc\) \{\n[\s\S]*?^\}\n/m],
  ['t30 empty freshness', /^const freshness = \{\}\n/m],
  ['t30 package loop', /^for \(const pkg of \['eda-core'[^\n]*\]\) \{\n[\s\S]*?^\}\n/m],
]

// Files whose success output quoted the gate state. mtime is gone, so the value
// becomes the pinned-content summary; the key stays so downstream consumers do
// not have to learn a new field name.
const SNAPSHOT_FILES = new Set([
  't27-flag-stagger.mjs', 't29-flag-stagger-readback.mjs', 't30-cross-review-t2.mjs', 't31-overlap-classify.mjs',
  't32-flag-glyph-size.mjs', 't33-flag-glyph-crosscheck.mjs', 't33-verify-t31-classify.mjs', 't34-cross-review-t6b.mjs',
])
const SUMMARY = "{ gate: 'content-sha256', packages: Object.keys(freshSnapshot.packages).length }"
const FIXUPS = {
  't27-flag-stagger.mjs': [
    ['\n  freshness,\n', `\n  freshness: ${SUMMARY},\n`],
    [
      '//   1. gate     : the compiled package this script actually runs must be newer\n//                 than its source (a stale bundle makes every number a\n//                 statement about old code).',
      '//   1. gate     : the source content must match the pinned build baseline\n//                 (a stale bundle makes every number a statement about old\n//                 code).',
    ],
  ],
  't29-flag-stagger-readback.mjs': [['freshness, fontSizeUnits', `freshness: ${SUMMARY}, fontSizeUnits`]],
  't30-cross-review-t2.mjs': [["{ status: 'OK', freshness }", `{ status: 'OK', freshness: ${SUMMARY} }`]],
  't31-overlap-classify.mjs': [['fresh: { src: new Date(gate.src).toISOString(), lib: new Date(gate.lib).toISOString() }', `fresh: ${SUMMARY}`]],
  't32-flag-glyph-size.mjs': [["{ status: 'OK', freshness }", `{ status: 'OK', freshness: ${SUMMARY} }`]],
  't33-flag-glyph-crosscheck.mjs': [['fresh: { src: new Date(gate.src).toISOString(), lib: new Date(gate.lib).toISOString() }', `fresh: ${SUMMARY}`]],
  't33-verify-t31-classify.mjs': [['\n  freshness,\n', `\n  freshness: ${SUMMARY},\n`]],
  't34-cross-review-t6b.mjs': [['fresh: { src: new Date(gate.src).toISOString(), lib: new Date(gate.lib).toISOString() }', `fresh: ${SUMMARY}`]],
  't26-wire-net-guard.mjs': [[' * Preflight (P0.5): the tsdown bundle must be newer than every source file.', ' * Preflight (P0.5): the source fingerprint must match the pinned build baseline.']],
}
const REPO_VAR = { 't26-wire-net-guard.mjs': 'repo' }

const check = process.argv.includes('--check')
const results = []
let failed = false

for (const name of TARGETS) {
  const path = join(dir, name)
  let text = readFileSync(path, 'utf8')
  const before = text
  const applied = []

  for (const [label, re] of REMOVALS) {
    const next = text.replace(re, '')
    if (next !== text) { text = next; applied.push(label) }
  }

  const repoVar = REPO_VAR[name] ?? 'repoRoot'
  const report = []
  for (const [find, repl] of FIXUPS[name] ?? []) {
    if (!text.includes(find)) { report.push(`MISSING FIXUP: ${find.slice(0, 50)}`); continue }
    text = text.replace(find, repl)
    report.push('fixup')
  }

  if (!applied.length) { report.push('NO REMOVAL MATCHED') }

  const importLine = "import { gateFreshness } from './shared/freshness.mjs'\n"
  if (!text.includes(importLine)) {
    const lines = text.split('\n')
    let last = -1
    for (let i = 0; i < Math.min(lines.length, 60); i++) if (/^import .* from 'node:/.test(lines[i])) last = i
    if (last < 0) { report.push('NO IMPORT ANCHOR') } else { lines.splice(last + 1, 0, importLine.trimEnd()); text = lines.join('\n') }
  }

  const call = SNAPSHOT_FILES.has(name) ? `const freshSnapshot = gateFreshness(${repoVar})` : `gateFreshness(${repoVar})`
  if (!text.includes('gateFreshness(')) {
    const anchor = new RegExp(`^const ${repoVar} = .*$`, 'm')
    if (!anchor.test(text)) report.push('NO REPO ANCHOR')
    else text = text.replace(anchor, (m) => `${m}\n${call}`)
  }

  // Drop fs/path specifiers that the removed helpers were the only user of.
  for (const mod of ['node:fs', 'node:path']) {
    const re = new RegExp(`^import \\{ ([^}]+) \\} from '${mod}'\\n`, 'm')
    const m = text.match(re)
    if (!m) continue
    const body = text.replace(re, '')
    const kept = m[1].split(',').map((s) => s.trim()).filter((s) => s && new RegExp(`\\b${s}\\b`).test(body))
    const replacement = kept.length ? `import { ${kept.join(', ')} } from '${mod}'\n` : ''
    text = text.replace(re, replacement)
  }

  text = text.replace(/\n{3,}/g, '\n\n')

  const changed = text !== before
  if (!check && changed) writeFileSync(path, text)
  results.push({ name, changed, removedChars: before.length - text.length, applied, report })
  if (!changed) failed = true
}

console.log(JSON.stringify({ mode: check ? 'check' : 'write', results, failed }, null, 1))
process.exitCode = failed ? 1 : 0
