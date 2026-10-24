#!/usr/bin/env node
// r7t1: bridge-free MAIN invariant verifier. READ-ONLY, stdout only.
//
// Why this exists: t53-verify-main.mjs needs the HTTP bridge, and in this session
// it has failed four times with exit 2 BRIDGE_UNREACHABLE, so 21/8/13/55/55/2 has
// only ever been a member self-report. This program answers a narrower question
// honestly: what can be re-derived from a committed page export on disk, and what
// cannot.
//
// It writes NOTHING. It has no fs.write, no child_process, no bridge, no fetch.
// The report on stdout can be redirected by the caller.
//
// Exit codes:
//   0  report produced; every invariant that IS provable from the source matches
//   1  report produced; a provable invariant contradicts the pinned value
//   2  the source is missing, unreadable, or is not the MAIN page
//
// Usage:
//   node docs/evidence/review/r7t1-offline-main-verify.mjs [--json] [--source=<path>]
//        [--expect-components=21] [--expect-wires=55] [--expect-pairs=55]
//        [--expect-pages=2] [--expect-part=8] [--expect-netflag=13]
//
// Conventions reused deliberately (the two historical traps):
//   * wires are segmented 4 numbers at a time (sch_PrimitiveWire.Line is a flat
//     coordinate list); stride 2 produces 5 phantom diagonals and 69 segments
//     instead of 62. Both numbers are printed so the wrong one is visible, but
//     only stride 4 is used.
//   * netflag means componentType === 'netflag'. It is NOT "the id starts with
//     layout:flag" - +3V3 is a part that carries a layout:flag id. A name-based
//     counter is printed as a negative control, never as the answer.

import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}

const MAIN_UUID = 'b275cd23e45c4271bead56f66d4f98fe'
const MAIN_NAME = 'MAIN'
const sourcePath = resolve(repo, arg('source', 'docs/evidence/current/t31-dataset.json'))
const expect = {
  components: Number(arg('expect-components', '21')),
  part: Number(arg('expect-part', '8')),
  netflag: Number(arg('expect-netflag', '13')),
  wires: Number(arg('expect-wires', '55')),
  pairs: Number(arg('expect-pairs', '55')),
  pages: Number(arg('expect-pages', '2')),
}

const die = (reason, detail) => {
  const out = { ok: false, exit: 2, reason, detail, source: sourcePath }
  process.stdout.write((asJson ? JSON.stringify(out, null, 2) : `[r7t1] CANNOT VERIFY (${reason}): ${detail}`) + '\n')
  process.exit(2)
}

let raw, stat
try {
  stat = statSync(sourcePath)
  raw = readFileSync(sourcePath, 'utf8')
} catch (e) {
  die('SOURCE_UNREADABLE', `${sourcePath}: ${e.message}`)
}
let data
try {
  data = JSON.parse(raw)
} catch (e) {
  die('SOURCE_NOT_JSON', `${sourcePath}: ${e.message}`)
}

// ---- identity: do not assume, compare verbatim ------------------------------
const mainUuid = data?.main?.uuid ?? null
const mainName = data?.main?.name ?? null
const pageHit = Array.isArray(data.pages) ? data.pages.find((p) => p.uuid === MAIN_UUID) : null
if (mainUuid !== MAIN_UUID || mainName !== MAIN_NAME) {
  die(
    'NOT_THE_MAIN_PAGE',
    `source.main = ${JSON.stringify({ uuid: mainUuid, name: mainName })}, expected { uuid: ${MAIN_UUID}, name: ${MAIN_NAME} }`,
  )
}

const comps = Array.isArray(data.comps) ? data.comps : []
const wires = Array.isArray(data.wires) ? data.wires : []
const pages = Array.isArray(data.pages) ? data.pages : []

// ---- component type: is the field even present? -----------------------------
const hasComponentType = comps.some((c) => 'componentType' in c || 'ComponentType' in c)
const typeOf = (c) => String(c.componentType ?? c.ComponentType ?? '').trim().toLowerCase()
const byType = hasComponentType
  ? comps.reduce((acc, c) => {
      const t = typeOf(c) || '(empty)'
      acc[t] = (acc[t] ?? 0) + 1
      return acc
    }, {})
  : null

// Reconstruction proxies, used ONLY when componentType is absent. Each is a
// different rule, so if they agree the split is at least self-consistent; none of
// them is the measurement the invariant asks for.
const reconDesignator = comps.filter((c) => String(c.Designator ?? '').trim() !== '').length
const reconIdConvention = comps.filter((c) => {
  const id = String(c.PrimitiveId ?? '')
  return id.startsWith('layout:flag:') && !/:(?:_3V3|3V3):/.test(id)
}).length
const naiveNameCount = comps.filter((c) => {
  const s = `${c.PrimitiveId ?? ''} ${c.Name ?? ''} ${c.Designator ?? ''}`
  return /MCU|GND|3V3/i.test(s)
}).length

// ---- wires: stride 4, with stride 2 shown as the known-wrong control --------
let segmentsStride4 = 0
let segmentsStride2 = 0
for (const w of wires) {
  const n = Array.isArray(w.Line) ? w.Line.length : 0
  segmentsStride4 += Math.floor(n / 4)
  segmentsStride2 += Math.max(0, n / 2 - 1)
}
const pairs = new Set(wires.map((w) => `${w.PrimitiveId}|${w.Net ?? ''}`))

// ---- hex-id residue, scoped: components vs every id field -------------------
const HEX = /^[0-9a-f]{16,}$/i
const idCollections = {
  comps: comps.map((c) => c.PrimitiveId),
  wires: wires.map((w) => w.PrimitiveId),
  texts: (data.texts ?? []).map((t) => t.PrimitiveId),
  rects: (data.rects ?? []).map((r) => r.PrimitiveId),
  attrs: (data.attrs ?? []).map((a) => a.PrimitiveId),
}
const hexByCollection = Object.fromEntries(
  Object.entries(idCollections).map(([k, ids]) => [k, ids.filter((id) => HEX.test(String(id))).length]),
)

// ---- comparison: the honest part -------------------------------------------
// provable      = the source carries the field AND the value is a measurement
// reconstructed = the field is absent, a proxy rule reproduces the number
// unprovable    = this source cannot answer it at all
const rows = [
  {
    item: 'components',
    expected: expect.components,
    computed: comps.length,
    status: comps.length === expect.components ? 'PASS' : 'FAIL',
    provable: 'provable - comps.length is a direct count of the export',
  },
  {
    item: 'part',
    expected: expect.part,
    computed: hasComponentType ? (byType.part ?? 0) : null,
    status: hasComponentType
      ? (byType.part ?? 0) === expect.part ? 'PASS' : 'FAIL'
      : reconDesignator === expect.part ? 'RECONSTRUCTED-AGREES' : 'RECONSTRUCTED-DIFFERS',
    provable: hasComponentType
      ? 'provable - componentType present'
      : 'NOT PROVABLE - the export carries no componentType; the value shown is a reconstruction from Designator',
    reconstruction: hasComponentType ? null : { rule: 'Designator non-empty', value: reconDesignator, idConvention: reconIdConvention },
  },
  {
    item: 'netflag',
    expected: expect.netflag,
    computed: hasComponentType ? (byType.netflag ?? 0) : null,
    status: hasComponentType
      ? (byType.netflag ?? 0) === expect.netflag ? 'PASS' : 'FAIL'
      : comps.length - reconDesignator === expect.netflag ? 'RECONSTRUCTED-AGREES' : 'RECONSTRUCTED-DIFFERS',
    provable: hasComponentType
      ? 'provable - componentType present'
      : 'NOT PROVABLE - the export carries no componentType; the value shown is a reconstruction (comps minus Designator-bearing ones)',
    reconstruction: hasComponentType ? null : { rule: 'comps minus Designator-bearing ones', value: comps.length - reconDesignator, idConvention: reconIdConvention },
    negativeControl: {
      what: 'counting by name/id instead of componentType',
      value: naiveNameCount,
      why: '+3V3 is a PART that carries a layout:flag id and matches /MCU|GND|3V3/, so a name-based rule over-counts by 1',
    },
  },
  {
    item: 'wires',
    expected: expect.wires,
    computed: wires.length,
    status: wires.length === expect.wires ? 'PASS' : 'FAIL',
    provable: 'provable - wires.length is a direct count',
    segments: { stride4: segmentsStride4, stride2_wrong: segmentsStride2 },
  },
  {
    item: 'pairs',
    expected: expect.pairs,
    computed: pairs.size,
    status: pairs.size === expect.pairs ? 'PASS' : 'FAIL',
    provable: 'provable - unique id|net over the same wire records',
  },
  {
    item: 'pages',
    expected: expect.pages,
    computed: pages.length,
    status: pages.length === expect.pages ? 'PASS' : 'NOT-PROVABLE-DIFFERS',
    provable:
      'NOT PROVABLE - t53 pins pages via --pages=N (default 2) and never measures it; this export records ' +
      `${pages.length} page records instead. A mismatch here is not evidence of a broken canvas, and a match would not be evidence of a healthy one.`,
  },
  {
    item: 'hex-id residue (components)',
    expected: 0,
    computed: hexByCollection.comps,
    status: hexByCollection.comps === 0 ? 'PASS' : 'FAIL',
    provable: 'provable - component ids in this export are stable ids (u*, layout:*), never raw hex',
    note: `attrs legitimately carry hex ids (${hexByCollection.attrs} of ${idCollections.attrs.length}); that is the attribute primitive id format, not residue. Scope matters: the invariant is about components.`,
  },
]

const failures = rows.filter((r) => r.status === 'FAIL')
const provenance = {
  source: sourcePath.slice(repo.length + 1).split('\\').join('/'),
  bytes: stat.size,
  sha256: createHash('sha256').update(raw).digest('hex'),
  main: { uuid: mainUuid, name: mainName },
  mainPageFoundInPages: Boolean(pageHit),
  mainPageIndex: pages.findIndex((p) => p.uuid === MAIN_UUID),
  pageNamesFirstFive: pages.slice(0, 5).map((p) => p.name),
  lastCommit: 'e7644e8 2026-10-21 13:51:29 +0800',
  referenceCommit: '9c9ae06 2026-10-24 18:08:00 +0800',
  stale: 'YES - the source was last committed before 9c9ae06, so it cannot represent the canvas as of that commit',
}

const circularity =
  't31-dataset.json is ALSO the baseline that t53 compares the live document against. ' +
  'Reading it offline therefore re-states the pinned expectation; it cannot show that the live canvas still equals it. ' +
  'The only thing an offline read proves is that the baseline file itself still contains these numbers and that its bytes are these bytes.'

const doc = {
  task: 'r7t1 - bridge-free MAIN invariant verifier',
  advisory: 'offline, read-only, not a gate',
  generatedAt: new Date().toISOString(),
  mode: 'offline snapshot; no bridge, no fetch, no write',
  exit: failures.length ? 1 : 0,
  ok: failures.length === 0,
  provenance,
  expected: expect,
  computed: {
    components: comps.length,
    part: hasComponentType ? (byType.part ?? 0) : null,
    netflag: hasComponentType ? (byType.netflag ?? 0) : null,
    wires: wires.length,
    pairs: pairs.size,
    pages: pages.length,
    segmentsStride4,
    segmentsStride2_wrong: segmentsStride2,
    hexIds: hexByCollection,
  },
  hasComponentType,
  reconstruction: hasComponentType
    ? null
    : {
        designatorNonEmpty: reconDesignator,
        idConvention: reconIdConvention,
        naiveNameMatching: naiveNameCount,
        note: `three different proxy rules; Designator and id-convention both give 8/13, the name rule gives ${naiveNameCount} (it counts +3V3, a part, as a netflag)`,
      },
  rows,
  provability: {
    provableFromThisSource: ['components', 'wires', 'pairs', 'segments (stride 4)', 'component hex-id residue', 'MAIN uuid/name identity', 'page record count and names'],
    notProvableFromThisSource: [
      'part / netflag split - the export has no componentType field',
      'pages = 2 - t53 pins it as a parameter; the export records 18 page records',
      'anything about the live canvas: instance ids, current selection, current page order',
    ],
    whatWouldBeNeeded: [
      'for part/netflag: a component export that includes componentType (the live getAll does return it, the committed export never stored it)',
      'for pages: a live dmt_Schematic.getAllSchematicPagesInfo() read at the same moment as the component read',
    ],
    circularity,
  },
  comparison: {
    pinned: '21 / 8 / 13 / 55 / 55 / 2 (last reported by a successful t53)',
    matched: rows.filter((r) => r.status === 'PASS').map((r) => r.item),
    reconstructed: rows.filter((r) => r.status.startsWith('RECONSTRUCTED')).map((r) => r.item),
    notProvable: rows.filter((r) => r.status.startsWith('NOT-PROVABLE') || r.provable.startsWith('NOT PROVABLE')).map((r) => r.item),
    failed: failures.map((r) => ({ item: r.item, expected: r.expected, computed: r.computed })),
  },
}

if (asJson) {
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n')
} else {
  const line = (s) => process.stdout.write(s + '\n')
  line('[r7t1] MAIN invariants, bridge-free - read-only, stdout only')
  line(`  source: ${doc.provenance.source} (${doc.provenance.bytes} bytes, sha256 ${doc.provenance.sha256.slice(0, 16)}...)`)
  line(`  identity: main.uuid ${doc.provenance.main.uuid} name ${doc.provenance.main.name} (page list index ${doc.provenance.mainPageIndex})`)
  line(`  stale: ${doc.provenance.stale}`)
  for (const r of rows) {
    const shown = r.computed === null ? `recon ${r.reconstruction ? r.reconstruction.value : '?'}` : String(r.computed)
    line(`  ${r.status.padEnd(22)} ${r.item}: expected ${r.expected}, computed ${shown}`)
  }
  line(`  segments: ${segmentsStride4} at stride 4 (stride 2 would say ${segmentsStride2} - known wrong)`)
  line(`  hex ids: components ${hexByCollection.comps}, attrs ${hexByCollection.attrs} (attrs are hex by design)`)
  line(`[r7t1] ${failures.length ? 'FAIL' : 'OK'} exit ${doc.exit}`)
  line('[r7t1] advisory: this is not t53 and cannot replace it; the live canvas is unverified here')
}

process.exit(doc.exit)
