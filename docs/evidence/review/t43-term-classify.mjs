// t43: classify every 口径 occurrence in the hardening doc (read-only).
//   A 拥挤度口径   = 锚点模型 × 统计定义 (§14.32/§14.33 scope)
//   B 计数判据     = flag counting criterion (should be renamed to 判据/计数)
//   C 换算约定     = unit conversion (§14.34, should be renamed)
//   D 度量定义     = 交付口径/像素口径/覆盖率口径 etc. elsewhere in the doc
// A line is reported as needing a reword when it carries B or C while the term
// block still calls it 口径, or when it mixes a counting criterion into the
// crowding scope. Exit 1 if any such line remains.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const docPath = join(resolve(import.meta.dirname, '../..'), '2026-10-17-schematic-pagination-hardening.md')
const text = readFileSync(docPath, 'utf8')
const lines = text.split(/\r?\n/)

const findHeading = (re) => lines.findIndex((l) => re.test(l))
const h1432 = findHeading(/^## 14\.32/)
const h1433 = findHeading(/^## 14\.33/)
const h1434 = findHeading(/^### 14\.34/)
if (h1432 < 0 || h1433 < 0 || h1434 < 0) {
  console.error(JSON.stringify({ status: 'HEADINGS_NOT_FOUND', h1432, h1433, h1434 }))
  process.exit(2)
}

const rows = []
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  if (!line.includes('口径')) continue
  const n = i + 1
  const inCrowding = i >= h1432 && i < h1434
  let sense
  if (/计数口径|ComponentType/.test(line) && /口径/.test(line)) sense = 'B'
  else if (i >= h1434 && /5 单位|50 mil/.test(line)) sense = 'C'
  else if (inCrowding) sense = 'A'
  else sense = 'D'
  rows.push({ line: n, sense, text: line.trim().slice(0, 110) })
}

const counts = { A: 0, B: 0, C: 0, D: 0 }
for (const r of rows) counts[r.sense]++
const needsReword = rows.filter((r) => r.sense === 'B' || r.sense === 'C')

console.log(JSON.stringify({
  status: needsReword.length === 0 ? 'OK' : 'CONFLICT',
  total: rows.length,
  counts,
  scope: { h1432: h1432 + 1, h1433: h1433 + 1, h1434: h1434 + 1 },
  needsReword,
  A: rows.filter((r) => r.sense === 'A').map((r) => r.line),
  D_lines: rows.filter((r) => r.sense === 'D').map((r) => r.line),
  rows,
}, null, 1))
process.exit(needsReword.length === 0 ? 0 : 1)
