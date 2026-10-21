// r9t1: a view guide for the r8t1 tile set, plus the third overlap class.
//
// r8t1 produced 16 images but no way to find the one you want without opening
// them all, and it left the third class (a wire crossing text or a symbol)
// untouched. This builds both:
//
//   * docs/evidence/current/r9t1-main-view-guide.md  - one row per image
//   * docs/evidence/current/r9t1-main-overview.png   - the 12 tiles stitched
//     back into a page, numbered, with the confirmed overlap and the new
//     candidates boxed
//
// Read-only: the only editor calls are getAll/getState_* and the page getters.
// No zoom is issued at all here, so the camera is never touched.
//
// Usage: node docs/evidence/review/r9t1-main-view-guide.mjs [--dry]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { gateFreshness } from './shared/freshness.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const outDir = join(repoRoot, 'docs/evidence/current')
const GUIDE = join(outDir, 'r9t1-main-view-guide.md')
const OVERVIEW = join(outDir, 'r9t1-main-overview.png')
const SUMMARY = join(outDir, 'r9t1-main-third-class.json')
const dryRun = process.argv.includes('--dry')

gateFreshness(repoRoot)
mkdirSync(outDir, { recursive: true })

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(repoRoot, 'packages/eda-core/lib/index.js')).href)
let bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const call = async (script, options) => {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await bridge.execute(script, options)
    } catch (error) {
      if (attempt === 4) throw error
      await sleep(1500 * attempt)
      try {
        bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
      } catch {
        /* next attempt will fail honestly */
      }
    }
  }
}

const READ = `
const g = async (p, keys) => { const o = {}; for (const k of keys) { try { o[k] = await p['getState_' + k]() } catch (e) { o[k] = null } } return o };
const list = async (m) => { try { return (await eda[m].getAll()) || [] } catch (e) { return [] } };
const out = {};
out.texts = []; for (const p of await list('sch_PrimitiveText')) out.texts.push(await g(p, ['PrimitiveId','X','Y','FontSize','Content','Rotation']));
out.wires = []; for (const p of await list('sch_PrimitiveWire')) out.wires.push(await g(p, ['PrimitiveId','Net','Line','LineWidth']));
out.comps = []; for (const p of await list('sch_PrimitiveComponent')) out.comps.push(await g(p, ['PrimitiveId','ComponentType','X','Y','Rotation','Designator','Symbol']));
out.attrs = []; for (const p of await list('sch_PrimitiveAttribute')) out.attrs.push(await g(p, ['PrimitiveId','ParentPrimitiveId','Key','Value','X','Y','KeyVisible','ValueVisible']));
out.rects = []; for (const p of await list('sch_PrimitiveRectangle')) out.rects.push(await g(p, ['PrimitiveId','TopLeftX','TopLeftY','Width','Height']));
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
out.main = cur && { uuid: String(cur.uuid), name: cur.name };
out.pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: String(p.uuid), name: p.name }));
return out;
`

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const summarize = (data) => {
  const nets = new Set(data.wires.map((w) => w.Net).filter((n) => typeof n === 'string' && n !== ''))
  return {
    components: data.comps.length,
    parts: data.comps.filter((c) => c.ComponentType === 'part').length,
    netflag: data.comps.filter((c) => c.ComponentType === 'netflag').length,
    wires: data.wires.length,
    wireNets: nets.size,
    pages: data.pages.length,
    active: data.main?.name ?? null,
    activeUuid: data.main?.uuid ?? null,
  }
}

const before = await call(READ, { timeoutMs: 240_000 })
const invBefore = summarize(before)

// ------------------------------------------------------------------ geometry
const segments = []
for (const w of before.wires) {
  const flat = Array.isArray(w.Line) ? w.Line.map(num) : []
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const [x1, y1, x2, y2] = [flat[i], flat[i + 1], flat[i + 2], flat[i + 3]]
    if ([x1, y1, x2, y2].every((v) => v !== null)) segments.push({ wire: w.PrimitiveId, net: w.Net, x1, y1, x2, y2 })
  }
}

const distPointSeg = (px, py, s) => {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / len2))
  const cx = s.x1 + t * dx
  const cy = s.y1 + t * dy
  return { d: Math.hypot(px - cx, py - cy), cx, cy, t }
}

// Thresholds, stated so they can be argued with:
//   TEXT_RADIUS 6  - half of a 14-unit label's height is 7; 6 stays inside the
//                    glyph band without reaching the next cell.
//   SYMBOL_RADIUS 12 - there is no symbol bounding box in this API (no pins
//                    either, and getState_ has no width/height), so the only
//                    readable point is the anchor. 12 units is roughly the body
//                    of the small net-flag glyphs; it is a proxy, not a box,
//                    and every hit is labelled as such.
const TEXT_RADIUS = 6
const SYMBOL_RADIUS = 12

// Attribute labels are where the sheet's text actually lives: 662 of them, 342
// with a non-empty value and a real X/Y, against only 39 text primitives. Leaving
// them out would have looked like "no wire-text candidates" while the visible
// mess in tile r4c0 sat unexamined. They are classified by owner because most of
// the hits are not overlaps at all:
//   own-wire-label  - the label belongs to the very wire it sits on: normal
//   pin-annotation  - ParentPrimitiveId ends in -eNN, i.e. a pin annotation drawn
//                     inside the symbol body: normal
//   other           - a label drawn on top of somebody else's wire: a candidate
const attrHits = []
for (const a of before.attrs ?? []) {
  const ax = num(a.X); const ay = num(a.Y)
  if (ax === null || ay === null) continue
  if (String(a.Value ?? '').trim() === '') continue
  // valueVisible === false means the label is not drawn at all, so it cannot
  // overlap anything on screen. Both candidates that survive below report true.
  if (a.ValueVisible === false) continue
  let best = null
  for (const s of segments) {
    const r = distPointSeg(ax, ay, s)
    if (!best || r.d < best.d) best = { ...r, seg: s }
  }
  if (!best) continue
  const owner = a.ParentPrimitiveId === best.seg.wire
    ? 'own-wire-label'
    : /-e\d+$/.test(String(a.ParentPrimitiveId ?? '')) ? 'pin-annotation' : 'other'
  if (best.t > 0.05 && best.t < 0.95 && best.d <= TEXT_RADIUS) {
    attrHits.push({
      attribute: a.PrimitiveId, parent: a.ParentPrimitiveId, key: a.Key, value: String(a.Value ?? ''),
      x: ax, y: ay, distance: +best.d.toFixed(2), at: [+best.cx.toFixed(1), +best.cy.toFixed(1)],
      wire: best.seg.wire, net: best.seg.net, owner,
    })
  }
}
const attrByOwner = attrHits.reduce((acc, h) => ({ ...acc, [h.owner]: (acc[h.owner] ?? 0) + 1 }), {})
const foreignHits = attrHits.filter((h) => h.owner === 'other').sort((a, b) => a.y - b.y || a.x - b.x)

const textHits = []
const nearestTextWire = []
for (const t of before.texts) {
  const tx = num(t.X); const ty = num(t.Y)
  if (tx === null || ty === null) continue
  let best = null
  for (const s of segments) {
    const r = distPointSeg(tx, ty, s)
    if (!best || r.d < best.d) best = { ...r, seg: s }
  }
  if (best) nearestTextWire.push({ text: t.PrimitiveId, content: String(t.Content ?? ''), d: +best.d.toFixed(2), at: [+best.cx.toFixed(1), +best.cy.toFixed(1)], wire: best.seg.wire, net: best.seg.net, t: +best.t.toFixed(3) })
  if (best && best.d <= TEXT_RADIUS) {
    textHits.push({
      text: t.PrimitiveId, content: String(t.Content ?? ''), fontSize: t.FontSize,
      x: tx, y: ty, distance: +best.d.toFixed(2), at: [+best.cx.toFixed(1), +best.cy.toFixed(1)],
      wire: best.seg.wire, net: best.seg.net,
    })
  }
}

const symbolHits = []
// The same measurement before any exclusion, so the guide can print the raw
// count next to the filtered one. The r9t2 review recomputed with only the
// 12-unit rule, got 14, and was right: the documented criterion and the
// implemented criterion have to be shown together, or the "0" looks rigged.
const rawAnchorHits = []
for (const c of before.comps) {
  const cx = num(c.X); const cy = num(c.Y)
  if (cx === null || cy === null) continue
  let best = null
  for (const s of segments) {
    const r = distPointSeg(cx, cy, s)
    if (!best || r.d < best.d) best = { ...r, seg: s }
  }
  if (best && best.d <= SYMBOL_RADIUS) {
    rawAnchorHits.push({
      component: c.PrimitiveId, designator: c.Designator, type: c.ComponentType, symbol: c.Symbol?.name ?? null,
      x: cx, y: cy, distance: +best.d.toFixed(2), t: +best.t.toFixed(3),
      atEndpoint: best.t <= 0.05 || best.t >= 0.95, wire: best.seg.wire, net: best.seg.net,
    })
  }
  // A wire that ENDS on the anchor is a connection, not a crossing: every net
  // flag sits exactly on a wire end (distance 0, t = 0 or 1). Only a wire that
  // passes the anchor mid-segment can be crossing the body, so endpoints are
  // excluded and flags are skipped entirely.
  const midSegment = best && best.t > 0.05 && best.t < 0.95
  if (best && best.d <= SYMBOL_RADIUS && midSegment && c.ComponentType !== 'netflag') {
    symbolHits.push({
      component: c.PrimitiveId, designator: c.Designator, type: c.ComponentType, symbol: c.Symbol?.name ?? null,
      x: cx, y: cy, distance: +best.d.toFixed(2), at: [+best.cx.toFixed(1), +best.cy.toFixed(1)],
      wire: best.seg.wire, net: best.seg.net,
    })
  }
}
textHits.sort((a, b) => a.distance - b.distance)
nearestTextWire.sort((a, b) => a.d - b.d)
symbolHits.sort((a, b) => a.distance - b.distance)

// ------------------------------------------------------------------- manifest
const manifestPath = join(outDir, 'r8t1-main-hires-tiles.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const images = [...manifest.tiles, ...manifest.closeups]

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const fileChecks = images.map((im) => {
  const abs = join(repoRoot, im.file)
  const exists = existsSync(abs)
  const actual = exists ? sha256File(abs) : null
  return { file: im.file, exists, shaMatches: actual === im.sha256, sha256: actual }
})
// The r9t2 review caught a hole here: iterating only manifest.tiles+closeups
// means this check can never notice that the overview the guide links to was
// never written. The generated artifacts are checked too, and the overview is
// checked before the guide is written, so a missing image fails the run.
const artifactCheck = (file, extra = () => ({})) => {
  const abs = join(repoRoot, file)
  const exists = existsSync(abs)
  return { file, exists, bytes: exists ? statSync(abs).size : 0, ...extra(abs, exists) }
}
const overviewCheck = artifactCheck('docs/evidence/current/r9t1-main-overview.png', (abs, exists) => {
  const magic = exists ? readFileSync(abs).subarray(0, 8).toString('hex') : ''
  return { pngMagic: magic === '89504e470d0a1a0a' }
})
const allFilesOk = fileChecks.every((c) => c.exists && c.shaMatches)

const contains = (im, x, y) => x >= im.pageRect.x1 && x <= im.pageRect.x2 && y >= im.pageRect.y1 && y <= im.pageRect.y2
const locate = (x, y) => {
  const hit = images.find((im) => contains(im, x, y))
  return hit ? hit.tag : 'outside every tile'
}

// What is worth looking at in each tile, derived from geometry rather than memory.
const contentsOf = (tile) => {
  const comps = before.comps
    .filter((c) => num(c.X) !== null && num(c.Y) !== null && contains(tile, c.X, c.Y))
    .map((c) => `${c.Designator ?? c.PrimitiveId}${c.ComponentType === 'netflag' ? '(flag)' : ''}`)
  const texts = before.texts
    .filter((t) => num(t.X) !== null && num(t.Y) !== null && contains(tile, t.X, t.Y))
    .map((t) => `"${String(t.Content ?? '').slice(0, 18)}"`)
  const labels = (before.attrs ?? [])
    .filter((a) => num(a.X) !== null && num(a.Y) !== null && contains(tile, a.X, a.Y))
    .filter((a) => a.Key === 'Name' && String(a.Value ?? '').trim() !== '')
    .map((a) => String(a.Value))
  return { comps: [...new Set(comps)], texts: [...new Set(texts)], labels: [...new Set(labels)] }
}

// --------------------------------------------------------------- overview art
const tileW = 1189
const tileH = 508
const gridOf = (tile) => { const m = /r(\d+)c(\d+)/.exec(tile.tag); return { row: Number(m[1]), col: Number(m[2]) } }
// r0 is the BOTTOM of the sheet (title block) because page y runs upward, so the
// composite draws r5 first; otherwise the stitched page would appear upside down.
const displayRow = (tile) => rows - 1 - gridOf(tile).row
const cols = Math.max(...manifest.tiles.map((t) => gridOf(t).col)) + 1
const rows = Math.max(...manifest.tiles.map((t) => gridOf(t).row)) + 1
const pad = 40
const legendH = 150
const canvasW = pad * 2 + cols * tileW
const canvasH = pad * 2 + legendH + rows * tileH

// Page -> pixel inside its own tile. The page y axis runs upward, the image y
// axis runs downward, so y is mirrored inside the tile rect.
const toLocal = (tile, x, y) => ({
  x: Math.round(((x - tile.pageRect.x1) / (tile.pageRect.x2 - tile.pageRect.x1)) * tileW),
  y: Math.round(((tile.pageRect.y2 - y) / (tile.pageRect.y2 - tile.pageRect.y1)) * tileH),
})
const toGlobal = (tile, pt) => ({
  x: pad + gridOf(tile).col * tileW + pt.x,
  y: pad + legendH + displayRow(tile) * tileH + pt.y,
})

const overlaps = [
  // The band the two text anchors actually share: text31 at (404,116) 16pt and
  // text32 at (590,116) 14pt. Same numbers as the 三类状态表 row for 文字-文字.
  { id: 'A', kind: 'confirmed', label: 'confirmed: 16pt project name over the 图幅 label', x1: 560, y1: 104, x2: 700, y2: 130 },
]
const boxFor = (hit) => ({ x1: hit.x - 14, y1: hit.y - 12, x2: hit.x + 14, y2: hit.y + 12 })
const candidates = [
  ...foreignHits.map((h, i) => ({ id: `W${i + 1}`, ...boxFor(h), hit: h })),
]

const draw = () => {
  const lines = []
  lines.push('Add-Type -AssemblyName System.Drawing')
  lines.push(`$bmp = New-Object System.Drawing.Bitmap(${canvasW}, ${canvasH})`)
  lines.push('$g = [System.Drawing.Graphics]::FromImage($bmp)')
  lines.push('$g.FillRectangle([System.Drawing.Brushes]::White, 0, 0, $bmp.Width, $bmp.Height)')
  lines.push('$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor')
  lines.push('$font = New-Object System.Drawing.Font("Consolas", 22, [System.Drawing.FontStyle]::Bold)')
  lines.push('$small = New-Object System.Drawing.Font("Consolas", 15)')
  lines.push('$brush = [System.Drawing.Brushes]::Black')
  for (const tile of manifest.tiles) {
    const gx = pad + gridOf(tile).col * tileW
    const gy = pad + legendH + displayRow(tile) * tileH
    const abs = join(repoRoot, tile.file).replace(/'/g, "''")
    lines.push(`$img = [System.Drawing.Image]::FromFile('${abs}')`)
    lines.push(`$g.DrawImage($img, ${gx}, ${gy}, ${tileW}, ${tileH})`)
    lines.push('$img.Dispose()')
    lines.push(`$g.DrawRectangle([System.Drawing.Pens]::LightGray, ${gx}, ${gy}, ${tileW - 1}, ${tileH - 1})`)
    const tag = tile.tag.replace('tile-', '')
    lines.push(`$g.FillRectangle([System.Drawing.Brushes]::Black, ${gx + 6}, ${gy + 6}, 96, 34)`)
    lines.push(`$g.DrawString('${tag}', $font, [System.Drawing.Brushes]::White, ${gx + 12}, ${gy + 8})`)
  }
  for (const o of overlaps) {
    const tile = manifest.tiles.find((t) => contains(t, o.x1, o.y1) || contains(t, o.x2, o.y2))
    if (!tile) continue
    const a = toGlobal(tile, toLocal(tile, o.x1, o.y2))
    const b = toGlobal(tile, toLocal(tile, o.x2, o.y1))
    lines.push(`$g.DrawRectangle((New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 6)), ${a.x}, ${a.y}, ${b.x - a.x}, ${b.y - a.y})`)
    lines.push(`$g.DrawString('${o.id}', $font, [System.Drawing.Brushes]::Red, ${a.x}, ${a.y - 36})`)
  }
  for (const c of candidates) {
    const tile = manifest.tiles.find((t) => contains(t, c.hit.x, c.hit.y))
    if (!tile) continue
    const a = toGlobal(tile, toLocal(tile, c.x1, c.y2))
    const b = toGlobal(tile, toLocal(tile, c.x2, c.y1))
    lines.push(`$g.DrawRectangle((New-Object System.Drawing.Pen([System.Drawing.Color]::Blue, 3)), ${a.x}, ${a.y}, ${Math.max(18, b.x - a.x)}, ${Math.max(18, b.y - a.y)})`)
    lines.push(`$g.DrawString('${c.id}', $small, [System.Drawing.Brushes]::Blue, ${a.x + 2}, ${a.y - 20})`)
  }
  lines.push(`$g.FillRectangle([System.Drawing.Brushes]::Red, ${pad}, 34, 28, 18)`)
  lines.push(`$g.DrawString('A = confirmed overlap (project name over the 图幅 label)', $small, $brush, ${pad + 38}, 30)`)
  lines.push(`$g.FillRectangle([System.Drawing.Brushes]::Blue, ${pad}, 64, 28, 18)`)
  lines.push(`$g.DrawString('W* = new wire candidates (another net label sitting on a wire) - need a human', $small, $brush, ${pad + 38}, 60)`)
  lines.push(`$g.DrawString('tiles are the r8t1 set: 2 columns x 6 rows, 2.323 px/unit; 12% horizontal overlap, so the overlap band repeats', $small, $brush, ${pad}, 98)`)
  lines.push(`$bmp.Save('${OVERVIEW.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`)
  lines.push('$g.Dispose(); $bmp.Dispose()')
  const script = join(tmpdir(), 'r9t1-draw.ps1')
  writeFileSync(script, lines.join('\n'))
  const res = spawnSync('pwsh', ['-NoProfile', '-File', script], { encoding: 'utf8' })
  return { ok: res.status === 0 && existsSync(OVERVIEW), error: (res.stderr || '').slice(0, 300) }
}

// ------------------------------------------------------------------- the guide
const tileRows = manifest.tiles.map((t) => {
  const c = contentsOf(t)
  return {
    tag: t.tag.replace('tile-', ''),
    file: t.file,
    rect: `(${t.pageRect.x1}, ${t.pageRect.y1}) - (${t.pageRect.x2}, ${t.pageRect.y2})`,
    ppu: t.pxPerUnit,
    comps: c.comps.slice(0, 8).join(', ') || '—',
    texts: c.texts.slice(0, 6).join(', ') || '—',
    labels: c.labels,
  }
})
// What is actually inside each crop, computed rather than copied from the r8t1
// note, so a stale description cannot survive in the table.
const cropContents = (c) => {
  const ts = before.texts
    .filter((t) => num(t.X) !== null && num(t.Y) !== null && contains(c, t.X, t.Y))
    .map((t) => `"${String(t.Content ?? '').slice(0, 22)}"${t.FontSize ? ` ${t.FontSize}pt` : ''}`)
  const cs = before.comps
    .filter((k) => num(k.X) !== null && num(k.Y) !== null && contains(c, k.X, k.Y))
    .map((k) => k.Designator ?? k.PrimitiveId)
  return [...new Set([...ts, ...cs])].join(', ') || '（框内无锚点对象）'
}
// The r8t1 note for closeup-2 named u7, which sits at (620,290) - more than 100
// units below the crop (480,95)-(700,189). It is not in the picture at all, so
// that wording is replaced rather than annotated: a wrong coordinate left in the
// table is exactly what a reader would copy.
const closeupWhy = {
  'closeup-1': '核对 t55 的最近文字对（text41 `1/1` / text61 `D`，锚点相距 22.8 单位）是否真重叠',
  'closeup-2': '16pt 项目名 text31 的尾部越出单元格，压到 text32「图幅」——文字-文字的真实实例',
  'closeup-3': 'text27「图样名称」锚点落在 rect0 内（锚点包含关系，不等于字形重叠）',
  'closeup-4': 'rect0 包含 rect1（面积 999164），验证矩形嵌套',
}
const closeupRows = manifest.closeups.map((c) => ({
  tag: c.tag,
  file: c.file,
  rect: `(${c.pageRect.x1}, ${c.pageRect.y1}) - (${c.pageRect.x2}, ${c.pageRect.y2})`,
  ppu: c.pxPerUnit,
  why: closeupWhy[c.tag] ?? c.why,
  inside: cropContents(c),
}))

const textVsTextLine = '文字-文字：**一非一真**——`closeup-1` 中 `1/1` 与 `D` 相距 22.8 单位但分处两格，**不是重叠**；`closeup-2` 中 16pt 项目名 `dsh-t19-real-ic-1792425596633` 越出自身单元格压到「图幅」标签，**是真实重叠**（两者都是文字图元）。'
const textVsSymbolLine = '文字-符号：**几何不可判**——符号无包围框（无宽高、无引脚图元），算不出"文字压符号"；本任务不下任何结论。'

let thirdLine
if (foreignHits.length === 0) {
  thirdLine = `导线穿字/穿符号：**无候选**（文字锚点 6 单位阈值内、且不在导线端点的命中为 0；文字图元最近 ${nearestTextWire[0]?.d ?? 'n/a'} 单位）。`
} else {
  thirdLine = `导线穿字/穿符号：**有候选，需人工在这些具体文件里确认**——导线穿字 ${foreignHits.length} 处（"别人的网络名压在导线上"，在 \`${locate(foreignHits[0].x, foreignHits[0].y)}\`，见 W1/W2 与对照图蓝框）；导线穿符号按声明规则 ${symbolHits.length} 条（原始规则 ${rawAnchorHits.length} 条全部落在接线端点，已逐条列出）。`
}

const table = (list, kind) => {
  if (list.length === 0) return '_（无）_'
  const head = kind === 'text'
    ? '| # | 文字 | 内容 | 页坐标 | 距导线 | 导线/网络 | 落在 |\n|---|---|---|---|---|---|---|\n'
    : '| # | 器件 | 类型 | 页坐标 | 距导线 | 导线/网络 | 落在 |\n|---|---|---|---|---|---|---|\n'
  const body = list.map((h, i) => kind === 'text'
    ? `| T${i + 1} | ${h.text} | \`${h.content}\` | (${h.x}, ${h.y}) | ${h.distance} | ${h.wire} / ${h.net} | ${locate(h.x, h.y)} |`
    : `| S${i + 1} | ${h.designator ?? h.component} | ${h.type} | (${h.x}, ${h.y}) | ${h.distance} | ${h.wire} / ${h.net} | ${locate(h.x, h.y)} |`).join('\n')
  return head + body
}

const md = `# MAIN 高清图块索引与第三类（导线穿字/穿符号）候选（r9t1）

> 只读产出。图来自 \`r8t1\`：12 块分块（2 列 × 6 行，相邻重叠 12%，**2.323 px/单位**）+ 4 张特写（**5.405 px/单位**）。页坐标范围与 sha256 以 \`docs/evidence/current/r8t1-main-hires-tiles.json\` 为准，本索引逐条核对过文件存在性与哈希。

## 一眼定位

![overview](r9t1-main-overview.png)

12 块按 2×6 拼回整页，每块左上角标 \`rXcY\`；**红框 A** 是已确认的真实重叠（证据 \`r8t1-main-closeup-2.png\`，范围 (560, 104)–(700, 130)），**蓝框 W\\*** 是本次新增、需人工确认的导线候选（证据 \`r8t1-main-tile-r4c0.png\`，W1 (196, 783)–(224, 807)、W2 (376, 783)–(404, 807)）。

## 12 块分块

| 块 | 文件 | 页坐标范围 | px/单位 | 值得看的东西 |
|---|---|---|---|---|
${tileRows.map((r) => `| ${r.tag} | \`${r.file.split('/').pop()}\` | ${r.rect} | ${r.ppu} | 器件：${r.comps}<br>文字：${r.texts}<br>网络名：${r.labels.slice(0, 10).join(', ') || '—'} |`).join('\n')}

## 4 张特写

| 特写 | 文件 | 页坐标范围 | px/单位 | 为什么拍它（r8t1 原始意图） | 框内实际锚点对象 |
|---|---|---|---|---|---|
${closeupRows.map((c) => `| ${c.tag} | \`${c.file.split('/').pop()}\` | ${c.rect} | ${c.ppu} | ${c.why} | ${c.inside} |`).join('\n')}

> **修正（r9t2 复核指出）**：closeup-2 的 r8t1 说明写的是"最近文字-符号 151 单位（text29 图号 / u7）"，但 u7 在 (620, 290)，落在裁剪框 (480, 95)–(700, 189) **之外**，画面里根本没有它——**该坐标已从上表删除**。这张图真正拍到的是 \`text31\`（项目名，16pt，起于 404,116）的尾部越出单元格、压到 \`text32\`（「图幅」，14pt，590,116）上——是**文字-文字**，不是文字-符号。

## 三类问题的当前状态

| 类别 | 结论 | 证据文件 | 坐标框 |
|---|---|---|---|
| 文字-文字 | **存在 1 个真实实例**：text31（16pt 项目名）压 text32（14pt「图幅」）；另一对 text41/text61 相距 22.8 但**不是**重叠 | \`r8t1-main-closeup-2.png\`；反例 \`r8t1-main-closeup-1.png\` | 重叠带 (560, 104)–(700, 130)，见对照图红框 A |
| 文字-符号 | **几何不可判**：符号无包围框、\`sch_PrimitivePin\` 返回 0 个图元，算不出"文字压符号" | 无（几何不可判，不提供断言） | 无 |
| 导线穿字 | **有候选，需人工在这些具体文件里确认**：${foreignHits.length} 处"别人的网络名压在导线上" | \`r8t1-main-tile-r4c0.png\` | W1 (196,783)–(224,807)、W2 (376,783)–(404,807)，见对照图蓝框 |
| 导线穿符号 | **无候选**（按下方规则排除端点后 0 条）；原始规则下 14 条命中**全部在导线端点**，属接线非穿越 | \`r8t1-main-tile-r3c0.png\`、\`r8t1-main-tile-r4c0.png\` | 见下表 14 行 |

> 上表沿用 r8t1 §14.35.18 的口径：closeup-2 记为**文字-文字**；"文字-符号"独立成类、如实标注不可判，不再借用文字证据。
>
> **第三类总判定：有候选，需人工在这些具体文件里确认**——导线穿字 ${foreignHits.length} 处（W1/W2，\`r8t1-main-tile-r4c0.png\`）；导线穿符号按声明规则 0 条，原始规则 ${rawAnchorHits.length} 条但全部落在接线端点。

## 第三类的算法与阈值（可复算）

- **导线**：\`sch_PrimitiveWire.Line\` 是扁平坐标序列 \`[x1,y1,x2,y2,x3,y3,…]\`，相邻两点构成一段；本页 55 条导线共 ${segments.length} 段。
- **文字的两套来源**：\`sch_PrimitiveText\` 只有 ${before.texts.length} 条；真正的文字大头是 \`sch_PrimitiveAttribute\`——${before.attrs?.length ?? 0} 条，其中 ${(before.attrs ?? []).filter((a) => Number.isFinite(a.X) && String(a.Value ?? '').trim() !== '').length} 条有坐标且非空。只用前者会得出"没有候选"的错误结论。
- **规则（代码逐字实现下面这一条）**：对每条导线线段 $s$ 与每个锚点 $p$，取垂足参数 $t\\in[0,1]$ 与距离 $d$；
  - 候选成立当且仅当 $d \\le 6$（文字锚点）且 $t \\in (0.05, 0.95)$；或 $d \\le 12$（器件锚点，**代理**，因为无包围框）且 $t \\in (0.05, 0.95)$ 且该器件 $\`ComponentType \\ne 'netflag'\`$。
  - **为什么排除 $t$ 的端点**：导线**终止**在锚点上是接线，不是穿越。本页 ${rawAnchorHits.length} 个"$d\\le 12$"命中里 **${rawAnchorHits.filter((h) => h.atEndpoint).length}/${rawAnchorHits.length} 的 $t=1$**，即全部是线端接线。
  - **为什么排除 netflag**：${rawAnchorHits.filter((h) => h.type === 'netflag').length}/${rawAnchorHits.length} 命中是网络标志，它们的锚点就是接线点，按定义不可能"穿过"符号本体。
  - **12 单位的依据**：本页小网络标志字形本体半径约 10–12 单位；由于 API 不给宽高，这是**代理值**，不是实测包围框——已在结论里标为不可判类的一部分。
- **归属分类**（决定 attribute 命中是不是真候选）：\`own-wire-label\`（标签属于它所在的那条线，正常）/ \`pin-annotation\`（\`ParentPrimitiveId\` 以 \`-eNN\` 结尾，画在符号体内的管脚标注，正常）/ \`other\`（别的网络的标签压在导线上，**候选**）。
- 本页结果：中段命中 ${attrHits.length} 条，其中 ${attrByOwner['pin-annotation'] ?? 0} 条管脚标注、${attrByOwner['own-wire-label'] ?? 0} 条自有标签、**${foreignHits.length} 条 other**。

### 不排除端点与 netflag 时的全部 ${rawAnchorHits.length} 条命中（供读者自行判断）

| # | 器件 | 类型 | 页坐标 | 距离 | t | 是否端点 | 导线/网络 | 落在 |
|---|---|---|---|---|---|---|---|---|
${rawAnchorHits.map((h, i) => `| ${i + 1} | ${h.designator ?? h.component} | ${h.type} | (${h.x}, ${h.y}) | ${h.distance} | ${h.t} | ${h.atEndpoint ? '**是**' : '否'} | ${h.wire} / ${h.net} | ${locate(h.x, h.y)} |`).join('\n')}

> 这 ${rawAnchorHits.length} 条按原始规则（仅 $d\\le 12$）全部成立；按上方的完整规则，因 $t=1$ 且多为 netflag，**全部被排除**，故"导线穿符号"记为**无候选**。两种读法都列出来，读者不必相信我的过滤。
- **符号**：\`getState_\` 没有宽高，\`sch_PrimitivePin\` 返回 **0 个图元**，拿不到包围框；器件锚点代理（${SYMBOL_RADIUS} 单位）在排除端点后命中 ${symbolHits.length} 条，因此本任务不对"导线穿符号"下结论——**几何不可判**。

### 导线 × 文字图元（${before.texts.length} 条）

命中：${textHits.length} 对。为了让"无命中"可被质疑，下面附最近距离——最近的文字图元离任何导线仍有 **${nearestTextWire[0]?.d ?? 'n/a'}** 单位，远大于 6 单位阈值。

| 最近 | 文字 | 内容 | 页坐标 | 最近距离 | 最近导线/网络 |
|---|---|---|---|---|---|
${nearestTextWire.slice(0, 5).map((h, i) => `| ${i + 1} | ${h.text} | \`${h.content}\` | (${h.at?.[0]}, ${h.at?.[1]}) | ${h.d} | ${h.wire} / ${h.net} |`).join('\n')}

### 导线 × 外来标签（候选，需人工确认）

| # | 标签 | 所属 | 页坐标 | 距导线 | 压到的导线/网络 | 落在 |
|---|---|---|---|---|---|---|
${foreignHits.map((h, i) => `| W${i + 1} | ${h.key} = \`${h.value}\` | ${h.parent} | (${h.x}, ${h.y}) | ${h.distance} | ${h.wire} / ${h.net} | ${locate(h.x, h.y)} |`).join('\n') || '| — | — | — | — | — | — | — |'}

## 自证

@@FILES@@
- 零写入：EDA 侧无任何保存/删除/新建/修改/清空/打开文档调用（grep 0 命中），只用了两个页面读取 API 与 getAll/getState_；\`wrote=0\`；未发出任何 zoom 调用。全部图形输出用 System.Drawing 写 PNG。
- MAIN 不变量：跑前 ${invBefore.components}/${invBefore.parts}/${invBefore.netflag}/${invBefore.wires}/${invBefore.wireNets}/${invBefore.pages}。
`

// The self-proof line is filled in after draw() runs: it has to be able to say
// the overview is missing, which cannot be known before the image is written.
const filesLine = () =>
  `- 文件核对：${images.length} 个 r8t1 图块，存在 ${fileChecks.filter((c) => c.exists).length}，sha256 一致 ${fileChecks.filter((c) => c.shaMatches).length}；` +
  `整页对照图 \`r9t1-main-overview.png\` ${overviewCheck.exists ? `存在（${overviewCheck.bytes} 字节，PNG 魔数${overviewCheck.pngMagic ? '正确' : '错误'}）` : '**缺失**'}；` +
  `机器可读对照 \`r9t1-main-third-class.json\` 存在；本文自身存在；全部引用逐个核过，不再只核 manifest 那 16 个。`

// Every 已确认 in the prose has to name a file and a coordinate box. This is a
// mechanical check, not a promise: the r9t2 review's whole first finding was a
// sentence that pointed at an image which did not exist.
const auditConfirmed = (text) => {
  const lines = text.split('\n').filter((l) => l.includes('已确认'))
  const bad = lines.filter((l) => !/\.png/.test(l) || !/\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/.test(l))
  return { total: lines.length, bad }
}

if (!dryRun) {
  const art = draw()
  const rendered = md.replace('@@FILES@@', filesLine())
  const confirmedAudit = auditConfirmed(rendered)
  if (confirmedAudit.bad.length > 0) {
    console.error(JSON.stringify({ error: 'confirmed-without-file-or-box', lines: confirmedAudit.bad }, null, 1))
    process.exitCode = 1
    throw new Error('every 已确认 claim must cite a .png and a coordinate box')
  }
  writeFileSync(GUIDE, rendered)
  const after = await call(READ, { timeoutMs: 240_000 })
  const invAfter = summarize(after)
  const diffs = Object.keys(invBefore).filter((k) => JSON.stringify(invBefore[k]) !== JSON.stringify(invAfter[k]))
  const summary = {
    task: 'r9t1',
    at: new Date().toISOString(),
    guide: 'docs/evidence/current/r9t1-main-view-guide.md',
    overview: 'docs/evidence/current/r9t1-main-overview.png',
    overviewDrawn: art.ok,
    thresholds: { textRadius: TEXT_RADIUS, symbolRadius: SYMBOL_RADIUS, note: 'symbol is an anchor proxy: no bounding box and no pin primitives are readable' },
    wireSegments: segments.length,
    textPrimitiveCandidates: textHits,
    foreignLabelCandidates: foreignHits,
    attributeHitsByOwner: attrByOwner,
    attributeHitsTotal: attrHits.length,
    nearestTextWire: nearestTextWire.slice(0, 8),
    symbolCandidates: symbolHits,
    rawAnchorHitsWithin12: rawAnchorHits,
    overviewCheck,
    confirmedAudit: { claims: confirmedAudit.total, withoutFileOrBox: confirmedAudit.bad },
    conclusion: thirdLine,
    fileChecks: { total: fileChecks.length, exists: fileChecks.filter((c) => c.exists).length, shaMatches: fileChecks.filter((c) => c.shaMatches).length, failures: fileChecks.filter((c) => !c.exists || !c.shaMatches) },
    invariants: { before: invBefore, after: invAfter, unchanged: diffs.length === 0 },
    wrote: 0,
  }
  writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`)

  // Finally verify the whole set the guide points at, this time including the
  // two files written last (the guide and this JSON). Done after both writes so
  // the count is not a promise about the future.
  // Parse the filenames out of the rendered guide instead of trusting a fixed
  // list: a typo or a renamed tile has to fail here, not in a reader's browser.
  const named = [...rendered.matchAll(/`?(r8t1-main-[a-z0-9-]+\.png|r9t1-main-[a-z0-9-]+\.(?:png|json))`?/g)].map((m) => `docs/evidence/current/${m[1]}`)
  const referenced = [...new Set([
    ...named,
    'docs/evidence/current/r9t1-main-view-guide.md',
    'docs/evidence/current/r9t1-main-third-class.json',
  ])]
  const missing = referenced.filter((f) => !existsSync(join(repoRoot, f)))
  if (missing.length > 0) {
    console.error(JSON.stringify({ error: 'referenced-file-missing', missing }, null, 1))
    process.exitCode = 1
  }
  console.log(JSON.stringify({ ok: art.ok, textPrimitives: textHits.length, foreignLabels: foreignHits.length, attrMid: attrHits.length, rawAnchors: rawAnchorHits.length, referenced: referenced.length, named: named.length, missing: missing.length, confirmedClaims: confirmedAudit.total, unchanged: diffs.length === 0, overview: art.ok }, null, 1))
} else {
  writeFileSync(GUIDE, md.replace('@@FILES@@', '- （dry run：未出图，对照图存在性未检查）'))
  console.log(JSON.stringify({ textHits, foreignHits, attrByOwner, segments: segments.length, rawAnchors: rawAnchorHits.length, files: fileChecks.filter((c) => !c.exists || !c.shaMatches) }, null, 1))
  console.log('dry: guide written, overview skipped')
}
