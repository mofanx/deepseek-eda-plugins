// t47: read-only audit of which evidence scripts can create schematic pages.
//
// Static only: it reads the scripts, never the bridge. The point is that the
// answer to "why does a verification run leave pages behind" must be checkable
// without running the scripts that leave them behind.
//
// Run: node docs/evidence/review/t47-page-audit.mjs
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = join(resolve(import.meta.dirname, '.'), '.')
const CREATE = ['createSchematicPage', 'addPage', 'createPage', 'newPage']
const DELETE = ['deleteSchematicPage']

const rows = []
for (const name of readdirSync(dir).filter((f) => /^t\d+.*\.mjs$/.test(f)).sort()) {
  if (name === 't47-page-audit.mjs') continue // this file names the APIs by design
  const text = readFileSync(join(dir, name), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  const count = (needle) => text.split(needle).length - 1
  const creates = Object.fromEntries(CREATE.map((k) => [k, count(k)]).filter(([, n]) => n > 0))
  const deletes = Object.fromEntries(DELETE.map((k) => [k, count(k)]).filter(([, n]) => n > 0))
  if (!Object.keys(creates).length) continue
  rows.push({
    script: name,
    creates,
    deletes,
    // A script that creates a page but has no deletion call can never clean up.
    createsWithoutDelete: !Object.keys(deletes).length,
    // Scripts that tolerate a leftover probe say so in their own status text.
    toleratesResidue: /OK_WITH_KNOWN_RESIDUE|RESIDUE_MISMATCH|known residue/i.test(text),
  })
}

const out = {
  status: 'OK',
  creators: rows,
  summary: {
    scriptsThatCreate: rows.length,
    pagesPerRun: rows.reduce((n, r) => n + Object.values(r.creates).reduce((a, b) => a + b, 0), 0),
    withoutDelete: rows.filter((r) => r.createsWithoutDelete).map((r) => r.script),
    toleratingResidue: rows.filter((r) => r.toleratesResidue).map((r) => r.script),
  },
}
console.log(JSON.stringify(out, null, 1))
