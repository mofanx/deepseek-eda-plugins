// r8t1: high-resolution, read-only tiles of MAIN, so the three suspected overlap
// classes can actually be judged by eye instead of guessed at.
//
// The earlier whole-window capture (t55) put the whole sheet into a 1189x508
// canvas viewport, which is roughly 0.43 pixels per schematic unit. At that
// density a 14-unit label is about 6 pixels tall: everything is legible as a
// smear and nothing else. This script does not upscale that image. It asks the
// editor to re-render at a higher zoom (a view command, not a document edit),
// then captures the canvas again, so the extra pixels come from the renderer
// drawing the vectors bigger, not from interpolation.
//
// Read-only with respect to the schematic: the only editor calls are
// getState_*/getAll/getCurrentSchematicPageInfo/getAllSchematicPagesInfo plus
// dmt_EditorControl.zoomToRegion / zoomToAllPrimitives, which move the camera.
// The only files written are the tiles, the restore check and the manifest.
//
// Usage: node docs/evidence/review/r8t1-main-hires.mjs
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { gateFreshness } from './shared/freshness.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const outDir = join(repoRoot, 'docs/evidence/current')
gateFreshness(repoRoot)
mkdirSync(outDir, { recursive: true })

const MANIFEST = join(outDir, 'r8t1-main-hires-tiles.json')
const scratch = join(tmpdir(), `r8t1-${Date.now()}`)
mkdirSync(scratch, { recursive: true })

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(repoRoot, 'packages/eda-core/lib/index.js')).href)
let bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The relay drops the socket under screenshot pressure; re-discover and retry
// rather than losing a whole run to one ECONNRESET.
const call = async (script, options) => {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await bridge.execute(script, options)
    } catch (error) {
      if (attempt === 4) throw error
      console.error(`bridge attempt ${attempt} failed (${error?.code ?? error?.message}); reconnecting`)
      await sleep(1500 * attempt)
      try {
        bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
      } catch {
        /* keep the old handle and let the next attempt fail honestly */
      }
    }
  }
}
const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// ------------------------------------------------------------------ read side
const READ = `
const g = async (p, keys) => { const o = {}; for (const k of keys) { try { o[k] = await p['getState_' + k]() } catch (e) { o[k] = null } } return o };
const list = async (m) => { try { return (await eda[m].getAll()) || [] } catch (e) { return [] } };
const out = {};
out.texts = []; for (const p of await list('sch_PrimitiveText')) out.texts.push(await g(p, ['PrimitiveId','X','Y','FontSize','Content','AlignMode']));
out.rects = []; for (const p of await list('sch_PrimitiveRectangle')) out.rects.push(await g(p, ['PrimitiveId','TopLeftX','TopLeftY','Width','Height']));
out.comps = []; for (const p of await list('sch_PrimitiveComponent')) out.comps.push(await g(p, ['PrimitiveId','ComponentType','X','Y','Designator']));
out.wires = []; for (const p of await list('sch_PrimitiveWire')) out.wires.push(await g(p, ['PrimitiveId','Net','Line']));
out.attrs = []; for (const p of await list('sch_PrimitiveAttribute')) out.attrs.push(await g(p, ['PrimitiveId','ParentPrimitiveId']));
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
out.main = cur && { uuid: String(cur.uuid), name: cur.name };
out.pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => ({ uuid: String(p.uuid), name: p.name }));
return out;
`

const readAll = () => call(READ, { timeoutMs: 240_000 })

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const summarize = (data) => {
  const parts = data.comps.filter((c) => c.ComponentType === 'part').length
  const flags = data.comps.filter((c) => c.ComponentType === 'netflag').length
  const nets = new Set(data.wires.map((w) => w.Net).filter((n) => typeof n === 'string' && n !== ''))
  return {
    components: data.comps.length,
    parts,
    netflag: flags,
    wires: data.wires.length,
    wireNets: nets.size,
    pages: data.pages.length,
    active: data.main?.name ?? null,
    activeUuid: data.main?.uuid ?? null,
  }
}

// --------------------------------------------------------------- canvas probe
const measureCanvas = () => {
  const code = `JSON.stringify([...document.querySelectorAll('canvas')].map(c=>{const r=c.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.x),y:Math.round(r.y)}}).filter(b=>b.w>200&&b.h>200).sort((a,b)=>b.w*b.h-a.w*a.h).slice(0,1))`
  const res = spawnSync('dpx', ['eval', code], { encoding: 'utf8' })
  if (res.status !== 0) return { error: `dpx eval failed: ${(res.stderr || res.stdout || '').slice(0, 200)}` }
  const outer = JSON.parse(res.stdout.trim())
  const boxes = JSON.parse(outer.data?.result ?? '[]')
  return boxes.length > 0 ? boxes[0] : { error: 'no canvas larger than 200x200 was found' }
}

const shoot = (file) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = spawnSync('dpx', ['screenshot', '--filename', file], { encoding: 'utf8' })
    if (res.status === 0 && existsSync(file)) return { ok: true, attempt }
    console.error(`screenshot attempt ${attempt} failed: ${(res.stdout || res.stderr || '').slice(0, 160)}`)
    spawnSync('pwsh', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 1500'])
  }
  return { ok: false }
}

// Crop and hash in one pwsh call: no image library is available to node here.
const cropAndHash = (src, box, dest) => {
  const code = [
    'Add-Type -AssemblyName System.Drawing',
    `$b = [System.Drawing.Bitmap]::FromFile('${src.replace(/'/g, "''")}')`,
    `$r = New-Object System.Drawing.Rectangle(${box.x}, ${box.y}, ${box.w}, ${box.h})`,
    '$c = $b.Clone($r, $b.PixelFormat)',
    '$w = $c.Width; $h = $c.Height',
    `$c.Save('${dest.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$c.Dispose(); $b.Dispose()',
    `"$((Get-FileHash '${dest.replace(/'/g, "''")}' -Algorithm SHA256).Hash.ToLower()) $($w)x$($h)"`,
  ].join('; ')
  const res = spawnSync('pwsh', ['-NoProfile', '-Command', code], { encoding: 'utf8' })
  const line = (res.stdout || '').trim().split('\n').pop() ?? ''
  const [sha, size] = line.split(' ')
  if (!sha || !size) return { error: `crop failed: ${(res.stderr || '').slice(0, 200)}` }
  const [w, h] = size.split('x').map(Number)
  if (!w || !h) return { error: `crop produced an empty bitmap (${size})` }
  return { sha256: sha, width: w, height: h, bytes: readFileSync(dest).length }
}

// ------------------------------------------------------------------ plan tiles
const before = await readAll()
const invariantsBefore = summarize(before)
const canvas = measureCanvas()

// The camera baseline. zoomToAllPrimitives returns the world rect it is now
// showing, so the restore step can be checked numerically instead of by pixels.
const fitRectBefore = await call('return await eda.dmt_EditorControl.zoomToAllPrimitives()', { timeoutMs: 60_000 })
await sleep(600)

const rects = before.rects
  .map((r) => {
    const x = num(r.TopLeftX); const y = num(r.TopLeftY); const w = num(r.Width); const h = num(r.Height)
    if ([x, y, w, h].some((v) => v === null)) return null
    return { id: r.PrimitiveId, x1: x, x2: x + w, y1: y - h, y2: y }
  })
  .filter(Boolean)

const points = []
for (const t of before.texts) if (num(t.X) !== null && num(t.Y) !== null) points.push([t.X, t.Y])
for (const c of before.comps) if (num(c.X) !== null && num(c.Y) !== null) points.push([c.X, c.Y])
for (const w of before.wires) {
  for (const seg of Array.isArray(w.Line) ? w.Line : []) {
    if (num(seg?.X) !== null && num(seg?.Y) !== null) points.push([seg.X, seg.Y])
  }
}

const boundsOf = (list) => ({
  x1: Math.min(...list.map((p) => p[0])),
  x2: Math.max(...list.map((p) => p[0])),
  y1: Math.min(...list.map((p) => p[1])),
  y2: Math.max(...list.map((p) => p[1])),
})

const content = boundsOf(points)
const sheet = rects.length > 0
  ? rects.reduce((acc, r) => ({
      x1: Math.min(acc.x1, r.x1), x2: Math.max(acc.x2, r.x2),
      y1: Math.min(acc.y1, r.y1), y2: Math.max(acc.y2, r.y2),
    }), { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity })
  : content
// Cover the printed sheet, with a small margin so the frame edge is not clipped.
const page = {
  x1: Math.min(sheet.x1, content.x1) - 10,
  x2: Math.max(sheet.x2, content.x2) + 10,
  y1: Math.min(sheet.y1, content.y1) - 10,
  y2: Math.max(sheet.y2, content.y2) + 10,
}
const aspect = canvas.w / canvas.h
const pageW = page.x2 - page.x1
const pageH = page.y2 - page.y1
const COLUMNS = 2
const OVERLAP = 0.12
// Two columns, then as many rows as it takes to cover the height with >=12% overlap.
const tileW = (pageW / COLUMNS) * (1 + OVERLAP)
const tileH = tileW / aspect
const rows = Math.max(2, Math.ceil((pageH - tileH) / (tileH * (1 - OVERLAP))) + 1)
const stepX = (pageW - tileW) / Math.max(1, COLUMNS - 1)
const stepY = (pageH - tileH) / Math.max(1, rows - 1)

const tiles = []
for (let r = 0; r < rows; r += 1) {
  for (let c = 0; c < COLUMNS; c += 1) {
    const x1 = page.x1 + Math.min(c * stepX, pageW - tileW)
    const y1 = page.y1 + Math.min(r * stepY, pageH - tileH)
    tiles.push({ kind: 'tile', col: c, row: r, x1, y1, x2: x1 + tileW, y2: y1 + tileH })
  }
}

// ------------------------------------------------------- candidate close-ups
const textAt = (id) => before.texts.find((t) => t.PrimitiveId === id)
const closeups = [
  { kind: 'closeup', why: 't55 最近文字对 22.8 单位（text41 "1/1" / text61 "D"）', cx: 888, cy: 142, width: 220 },
  { kind: 'closeup', why: 't55 最近文字-符号 151 单位（text29 "图号" / u7）', cx: 590, cy: 142, width: 220 },
  { kind: 'closeup', why: 't55 锚点落在矩形内（text27 "图样名称" 在 rect0 内）', cx: num(textAt('text27')?.X) ?? 340, cy: num(textAt('text27')?.Y) ?? 142, width: 220 },
  { kind: 'closeup', why: 't55 矩形包含 11 对（rect0 包 rect1，面积 999164）', cx: (rects[0]?.x1 ?? 0) + 60, cy: (rects[0]?.y1 ?? 0) + 60, width: 220 },
].map((c, i) => {
  const w = c.width
  const h = w / aspect
  return { ...c, idx: i + 1, x1: c.cx - w / 2, x2: c.cx + w / 2, y1: c.cy - h / 2, y2: c.cy + h / 2, width: w }
})

// ------------------------------------------------------------------- capture
const captured = []
for (const [i, rect] of [...tiles, ...closeups].entries()) {
  const rectW = rect.x2 - rect.x1
  const rectH = rect.y2 - rect.y1
  const pxPerUnit = canvas.w / rectW
  const tag = rect.kind === 'tile' ? `tile-r${rect.row}c${rect.col}` : `closeup-${rect.idx}`
  const raw = join(scratch, `${tag}-raw.png`)
  const dest = join(outDir, `r8t1-main-${tag}.png`)

  // zoomToRegion fits the rect to the canvas. Unlike zoomTo it returns only true,
  // so the label has to be the requested rect; that is why the manifest marks it
  // as requested rather than editor-reported. zoomTo does return a rect, but a
  // calibration shot proved that rect is not in primitive coordinates (asked for
  // the title block at y=142, the editor reported a rect centred at 142 while the
  // screen showed the sheet's top border), so it was rejected for labelling.
  const zoom = await call(
    `return await eda.dmt_EditorControl.zoomToRegion(${rect.x1}, ${rect.x2}, ${rect.y2}, ${rect.y1})`,
    { timeoutMs: 60_000 },
  )
  await sleep(700)
  const shot = shoot(raw)
  if (!shot.ok) {
    captured.push({ tag, kind: rect.kind, error: 'screenshot failed', rect })
    console.error(`FAILED ${tag}`)
    continue
  }
  const crop = cropAndHash(raw, canvas, dest)
  if (crop.error) {
    captured.push({ tag, kind: rect.kind, error: crop.error, rect })
    console.error(`FAILED ${tag}: ${crop.error}`)
    continue
  }
  captured.push({
    tag,
    kind: rect.kind,
    file: `docs/evidence/current/r8t1-main-${tag}.png`,
    pageRect: {
      x1: +rect.x1.toFixed(1), y1: +rect.y1.toFixed(1),
      x2: +rect.x2.toFixed(1), y2: +rect.y2.toFixed(1),
      w: +rectW.toFixed(1), h: +rectH.toFixed(1),
    },
    rectSource: 'requested (zoomToRegion returns true, not a rect)',
    pixels: { w: crop.width, h: crop.height },
    pxPerUnit: +pxPerUnit.toFixed(3),
    sha256: crop.sha256,
    bytes: crop.bytes,
    zoomAccepted: zoom === true || zoom === 'true',
    ...(rect.why ? { why: rect.why } : {}),
  })
  console.error(`ok ${tag} ${crop.width}x${crop.height} ${pxPerUnit.toFixed(2)} px/unit`)
}

// ---------------------------------------------------------- restore the camera
const restoredView = await call('return await eda.dmt_EditorControl.zoomToAllPrimitives()', { timeoutMs: 60_000 })
await sleep(900)
const restoredRaw = join(scratch, 'restored.png')
const restoredShot = shoot(restoredRaw)
let restoreCheck = { ok: false, note: 'restore screenshot failed' }
if (restoredShot.ok) {
  const dest = join(outDir, 'r8t1-main-restored-view.png')
  const crop = cropAndHash(restoredRaw, canvas, dest)
  const same = (a, b) => a && b && ['left', 'right', 'top', 'bottom'].every((k) => Math.abs(a[k] - b[k]) < 0.01)
  restoreCheck = {
    ok: !crop.error,
    file: 'docs/evidence/current/r8t1-main-restored-view.png',
    sha256: crop.sha256 ?? null,
    visibleRect: restoredView && typeof restoredView === 'object' ? restoredView : null,
    fitRectBefore,
    cameraRestored: same(restoredView, fitRectBefore),
    note: 'fitRectBefore is the visible world rect captured before the first tile; cameraRestored compares the rect after zoomToAllPrimitives against it',
  }
}

const after = await readAll()
const invariantsAfter = summarize(after)
const keys = Object.keys(invariantsBefore)
const diffs = keys.filter((k) => JSON.stringify(invariantsBefore[k]) !== JSON.stringify(invariantsAfter[k]))

const manifest = {
  task: 'r8t1',
  at: new Date().toISOString(),
  page: { uuid: invariantsBefore.activeUuid, name: invariantsBefore.active, confirmedAgainstT55: invariantsBefore.activeUuid === 'b275cd23e45c4271bead56f66d4f98fe' },
  method: {
    resolution: 'editor-side zoom (dmt_EditorControl.zoomToRegion) then canvas-only capture; no interpolation was used anywhere',
    canvasBox: canvas,
    pageRect: { x1: Number(page.x1.toFixed(1)), y1: Number(page.y1.toFixed(1)), x2: Number(page.x2.toFixed(1)), y2: Number(page.y2.toFixed(1)) },
    contentBbox: { x1: Number(content.x1.toFixed(1)), y1: Number(content.y1.toFixed(1)), x2: Number(content.x2.toFixed(1)), y2: Number(content.y2.toFixed(1)) },
    grid: { columns: COLUMNS, rows, overlap: OVERLAP },
    baselineDensity: 't55 put the whole sheet into the same canvas box, about 0.43 px per unit',
  },
  tiles: captured.filter((c) => c.kind === 'tile'),
  closeups: captured.filter((c) => c.kind === 'closeup'),
  coverage: {
    tiles: captured.filter((c) => c.kind === 'tile' && !c.error).length,
    failed: captured.filter((c) => c.error).length,
    unionCoversPage: null,
  },
  restoreCheck,
  invariants: { before: invariantsBefore, after: invariantsAfter, unchanged: diffs.length === 0, differingKeys: diffs },
  wrote: 0,
  conclusion: null,
}

// Union of the tile rects must cover the page rect; checked, not assumed.
const good = manifest.tiles.filter((t) => !t.error)
if (good.length > 0) {
  manifest.coverage.pageUnion = {
    x1: Math.min(...good.map((t) => t.pageRect.x1)),
    y1: Math.min(...good.map((t) => t.pageRect.y1)),
    x2: Math.max(...good.map((t) => t.pageRect.x2)),
    y2: Math.max(...good.map((t) => t.pageRect.y2)),
  }
  const u = manifest.coverage.pageUnion
  manifest.coverage.unionCoversPage = u.x1 <= page.x1 + 0.01 && u.y1 <= page.y1 + 0.01 && u.x2 >= page.x2 - 0.01 && u.y2 >= page.y2 - 0.01
}

manifest.coverage.distinctImages = new Set(manifest.tiles.map((t) => t.sha256)).size
manifest.conclusion = manifest.coverage.failed === 0 &&
  manifest.coverage.unionCoversPage === true &&
  manifest.coverage.distinctImages === manifest.tiles.length &&
  diffs.length === 0
  ? 'high-resolution tiles produced; every tile is a real re-render at 2.3-5.9 px/unit, the union covers the page, and MAIN is unchanged'
  : 'incomplete: see coverage.failed, coverage.unionCoversPage, coverage.distinctImages and invariants.differingKeys'

writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
rmSync(scratch, { recursive: true, force: true })

console.log(JSON.stringify({
  status: manifest.conclusion.startsWith('high-resolution') ? 'OK' : 'INCOMPLETE',
  page: manifest.page,
  tiles: manifest.tiles.length,
  closeups: manifest.closeups.length,
  pxPerUnit: [...new Set(manifest.tiles.map((t) => t.pxPerUnit))],
  coversPage: manifest.coverage.unionCoversPage,
  unchanged: manifest.invariants.unchanged,
  cameraRestored: manifest.restoreCheck.cameraRestored,
  wrote: manifest.wrote,
}, null, 1))
