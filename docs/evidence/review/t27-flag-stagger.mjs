// t27 v2: can "flag + y-stagger" replace wire lane routing?
//
// Measure-only. v1 used a blue-only threshold and found zero bands: the flag
// label is not the faint blue that wire net names are, so the metric was
// measuring a colour, not ink. v2 is colour-agnostic, calibrates on a known
// quantity first, and never reports a conclusion the pixels do not support.
//
//   1. gate     : the source content must match the pinned build baseline
//                 (a stale bundle makes every number a statement about old
//                 code).
//   2. calibrate: run the ink metric on the delivered MAIN page, whose 55
//                 client-drawn wire net names are the documented baseline
//                 (2 px text bands). If the metric cannot reproduce a 2 px
//                 band on known content, stop - no conclusion.
//   3. A/B      : on a throwaway page, 48 one-pin nets in two shapes, captured
//                 at the SAME scaleRatio and measured by the SAME algorithm:
//                   control   : 10-unit pitch, one column
//                   staggered : 20-unit pitch, two columns offset by 10
//                 The decisive invariant needs no calibration at all: one band
//                 per row means no two labels merged. bands < rows = overlap.
//   4. clean    : delete every probe primitive and the page; assert residue 0.
//
// Usage: node docs/evidence/review/t27-flag-stagger.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gateFreshness } from './shared/freshness.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const freshSnapshot = gateFreshness(repoRoot)
const pkgDir = join(repoRoot, 'packages')
const evidDir = join(repoRoot, 'docs/evidence/current')

// ---------------------------------------------------------------- preflight

// Gate scope: only the package whose compiled code this script runs (eda-core
// provides HttpEasyEdaBridge). A package under concurrent edit cannot change a
// measurement that never imports it, and building here would snapshot a
// half-finished edit into lib/ for everybody else.

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(pkgDir, 'eda-core/lib/index.js')).href)
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })

// The bridge closes idle keep-alive sockets, so the first call after a gap
// (e.g. behind a dpx screenshot) dies with undici's bare 'fetch failed'.
// Retry on a fresh socket; every step below is written to be re-runnable.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function callWithRetry(code, opts = {}) {
  let last
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await bridge.execute(code, opts)
    } catch (e) {
      last = e
      if (attempt < 3) await sleep(1500)
    }
  }
  throw last
}

// ----------------------------------------------------------- pixel analyser
// Colour-agnostic: background is the modal luminance of the analysed strip, and
// ink is any pixel that departs from it. Horizontal grid rules span the whole
// strip, so rows that are ~fully inked are discarded as chrome, not text.
const work = mkdtempSync(join(tmpdir(), 't27b-'))
const ps1 = join(work, 'ink.ps1')
writeFileSync(ps1, String.raw`
param([string]$Png, [string]$Out, [int]$X0, [int]$X1, [int]$Y0, [int]$Y1, [int]$Merge = 2, [int]$MinWidth = 2)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Png)
$w = $bmp.Width; $h = $bmp.Height
$rect = New-Object System.Drawing.Rectangle 0,0,$w,$h
$d = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$stride = $d.Stride; $bytes = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($d); $bmp.Dispose()
if ($X1 -le 0 -or $X1 -gt $w) { $X1 = $w }
if ($Y1 -le 0 -or $Y1 -gt $h) { $Y1 = $h }
$W = $X1 - $X0; $H = $Y1 - $Y0
# luminance histogram -> modal background
$hist = New-Object int[] 256
for ($y = $Y0; $y -lt $Y1; $y++) {
  $row = $y * $stride
  for ($x = $X0; $x -lt $X1; $x++) {
    $i = $row + $x*3
    $l = [int](0.114*$bytes[$i] + 0.587*$bytes[$i+1] + 0.299*$bytes[$i+2])
    $hist[$l]++
  }
}
$bg = 0; $best = -1
for ($l = 0; $l -lt 256; $l++) { if ($hist[$l] -gt $best) { $best = $hist[$l]; $bg = $l } }
$thr = 26
# per-column ink: separates a narrow flag glyph from the wider text run
$colInk = New-Object int[] $W
$rowInk = New-Object int[] $H
$rowFull = New-Object bool[] $H
for ($y = $Y0; $y -lt $Y1; $y++) {
  $row = $y * $stride; $c = 0
  for ($x = $X0; $x -lt $X1; $x++) {
    $i = $row + $x*3
    $l = [int](0.114*$bytes[$i] + 0.587*$bytes[$i+1] + 0.299*$bytes[$i+2])
    if ([Math]::Abs($l - $bg) -gt $thr) { $c++; $colInk[$x - $X0]++ }
  }
  $rowInk[$y - $Y0] = $c
  $rowFull[$y - $Y0] = ($c -gt 0.9 * $W)
}
$cols = New-Object System.Collections.ArrayList
$cs = $null; $cp = $null
for ($x = 0; $x -lt $W; $x++) {
  if ($colInk[$x] -le 0) { continue }
  if ($null -eq $cs) { $cs = $x }
  elseif ($x -gt $cp + $Merge) { [void]$cols.Add(@($cs + $X0, $cp + $X0)); $cs = $x }
  $cp = $x
}
if ($null -eq $cs) { [void]$cols.Add(@($cs + $X0, $cp + $X0)) }
$report = @()
foreach ($col in $cols) {
  if (($col[1] - $col[0]) -lt $MinWidth) { continue }
  $a = $col[0] - $X0; $b = $col[1] - $X0
  $ink = New-Object int[] $H
  for ($y = $Y0; $y -lt $Y1; $y++) {
    $row = $y * $stride; $c = 0
    for ($x = $a; $x -le $b; $x++) {
      $i = $row + ($x + $X0)*3
      $l = [int](0.114*$bytes[$i] + 0.587*$bytes[$i+1] + 0.299*$bytes[$i+2])
      if ([Math]::Abs($l - $bg) -gt $thr) { $c++ }
    }
    $ink[$y - $Y0] = $c
  }
  $bands = New-Object System.Collections.ArrayList
  $st = $null; $pv = $null
  for ($y = 0; $y -lt $H; $y++) {
    $isInk = ($ink[$y] -ge 2) -and -not $rowFull[$y]
    if (-not $isInk) { continue }
    if ($null -eq $st) { $st = $y }
    elseif ($y -gt $pv + 1) { [void]$bands.Add(@($st, $pv)); $st = $y }
    $pv = $y
  }
  if ($null -ne $st) { [void]$bands.Add(@($st, $pv)) }
  if ($bands.Count -lt 1) { continue }
  $gaps = @()
  for ($k = 1; $k -lt $bands.Count; $k++) { $gaps += ($bands[$k][0] - $bands[$k-1][1] - 1) }
  $hs = @($bands | ForEach-Object { $_[1] - $_[0] + 1 } | Sort-Object)
  $report += [pscustomobject]@{
    xFrom = $col[0]; xTo = $col[1]; width = ($col[1] - $col[0] + 1)
    bands = $bands.Count
    medianHeight = $hs[[int]($hs.Count/2)]
    minHeight = $hs[0]; maxHeight = $hs[$hs.Count-1]
    minGap = if ($gaps.Count) { ($gaps | Measure-Object -Minimum).Minimum } else { $null }
    medianGap = if ($gaps.Count) { ($gaps | Sort-Object)[[int]($gaps.Count/2)] } else { $null }
    yFrom = $bands[0][0] + $Y0; yTo = $bands[$bands.Count-1][1] + $Y0
  }
}
@{ image = @{ w = $w; h = $h }; strip = @{ x0 = $X0; x1 = $X1; y0 = $Y0; y1 = $Y1 }; background = $bg; threshold = $thr; columns = $report } |
  ConvertTo-Json -Depth 6 | Set-Content -Path $Out -Encoding utf8
`)

function analyse(png, out, rect = {}) {
  const args = ['-NoProfile', '-File', ps1, '-Png', png, '-Out', out,
    '-X0', String(rect.x0 ?? 0), '-X1', String(rect.x1 ?? 0), '-Y0', String(rect.y0 ?? 0), '-Y1', String(rect.y1 ?? 0)]
  const run = spawnSync('pwsh', args, { stdio: 'ignore' })
  if (!existsSync(out)) return { error: `analyser failed (status ${run.status})` }
  return JSON.parse(readFileSync(out, 'utf8'))
}

function shoot(name) {
  const file = join(evidDir, name)
  spawnSync('dpx', ['screenshot', '--filename', file], { shell: true, stdio: 'ignore' })
  return existsSync(file) ? file : null
}

// canvas window: skip the project tree (left) and the panel rows (top/bottom)
const CANVAS = { x0: 300, x1: 0, y0: 92, y1: 578 }

// ------------------------------------------------------- step 2: calibration
const calib = await callWithRetry(`
try { await eda.dmt_EditorControl.openDocument('b188905fffe14e3bb0e7ccd16d5faa0a') } catch (e) {}
await new Promise(r => setTimeout(r, 1200));
try { await eda.dmt_EditorControl.zoomToAllPrimitives() } catch (e) {}
await new Promise(r => setTimeout(r, 1500));
const wires = (await eda.sch_PrimitiveWire.getAll()) || [];
const nets = new Set();
for (const w of wires) { try { const n = w.getState_Net(); if (typeof n === 'string' && n !== '') nets.add(n) } catch (e) {} }
return { wires: wires.length, nets: nets.size };
`, { timeoutMs: 90_000 })

const calShot = shoot('t27-calibration-main.png')
const calibration = calShot
  ? { known: calib, pixel: analyse(calShot, join(work, 'cal.json'), CANVAS), image: calShot }
  : { error: 'no screenshot' }

// Calibration gate: the documented baseline is a 2 px text band on this page.
// Media band height across columns must land near 2 px, else stop.
const calCols = calibration.pixel?.columns ?? []
const calHeights = calCols.map((c) => c.medianHeight).sort((a, b) => a - b)
const calMedian = calHeights.length ? calHeights[Math.floor(calHeights.length / 2)] : null
const calibrationOk = calCols.length > 0 && calMedian !== null && calMedian <= 4

// --------------------------------------------------------- step 3: probe A/B
const NETS = Array.from({ length: 48 }, (_, i) => `MCU-${i + 1}`)
const control = NETS.map((net, i) => ({ net, x: 800, y: 100 + i * 10 }))
const staggered = NETS.map((net, i) => ({
  net,
  x: i % 2 === 0 ? 800 : 860,
  y: 620 + (i % 2 === 0 ? 0 : 10) + Math.floor(i / 2) * 20,
}))

const RATIO = 0.85

// Reuse a leftover probe page as the measurement surface instead of creating a
// new one: `createSchematicPage` always throws (measured: TypeError reading
// 'sheet') and `openDocument` on the half-built page hangs the bridge, while
// an existing page opens fine. This also cleans up the pages v1 leaked.
// Probe on MAIN's empty right band (measured: occupied maxX = 700, page is
// 910 wide) instead of a second page: openDocument does not switch the active
// page in this client (measured: active stayed MAIN), so a cross-page A/B is
// not reachable. One page also means calibration and A/B share a single image.
const pageStep = await callWithRetry(`
const main = 'b188905fffe14e3bb0e7ccd16d5faa0a';
await eda.dmt_EditorControl.openDocument(main);
await new Promise(r => setTimeout(r, 800));
const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!active || active.uuid !== main) return { status: 'WRONG_PAGE', active };
let maxX = 0;
for (const c of (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []) {
  try { const b = c.getState_BoundingBox ? c.getState_BoundingBox() : null; if (b && b.maxX > maxX) maxX = b.maxX } catch (e) {}
}
return { status: 'OK', pageUuid: main, backTo: main, occupiedMaxX: maxX };
`, { timeoutMs: 120_000 })

if (!pageStep || pageStep.status !== 'OK') {
  console.error(`FAIL page step: ${JSON.stringify(pageStep)}`)
  process.exit(1)
}

const madeStep = await callWithRetry(`
// Re-runnable: a retry must not stack a second copy of the probe on the page.
for (const c of (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []) {
  try { await eda.sch_PrimitiveComponent.delete(c) } catch (e) {}
}
await new Promise(r => setTimeout(r, 600));
const rows = ${JSON.stringify([...control, ...staggered])};
const made = [];
for (const row of rows) {
  try {
    const placed = await eda.sch_PrimitiveComponent.createNetFlag('Power', row.net, row.x, row.y, 0, false);
    const id = placed && typeof placed.getState_PrimitiveId === 'function' ? placed.getState_PrimitiveId() : (placed && (placed.id || placed.primitiveId));
    if (typeof id === 'string') made.push(id);
  } catch (e) {}
}
await new Promise(r => setTimeout(r, 600));
return { status: 'OK', created: made.length, ids: made };
`, { timeoutMs: 240_000 })

const sizedStep = await callWithRetry(`
let sized = 0;
for (const a of (await eda.sch_PrimitiveAttribute.getAll()) || []) {
  try {
    const key = typeof a.getState_Key === 'function' ? a.getState_Key() : a.key;
    if (key !== 'Name') continue;
    await eda.sch_PrimitiveAttribute.modify(a, { fontSize: 0.06 });
    sized += 1;
  } catch (e) {}
}
return { status: 'OK', sized };
`, { timeoutMs: 180_000 })

// Geometry read-back places the pixel strip on the text, not on the flag glyph.
const boxStep = await callWithRetry(`
const boxes = [];
for (const a of (await eda.sch_PrimitiveAttribute.getAll()) || []) {
  try {
    const key = typeof a.getState_Key === 'function' ? a.getState_Key() : a.key;
    if (key !== 'Name') continue;
    if (boxes.length >= 6) break;
    const bb = await eda.sch_PrimitiveAttribute.getBoundingBox(a);
    if (bb) boxes.push({ x: bb.x, y: bb.y, w: bb.width, h: bb.height });
  } catch (e) {}
}
return { status: 'OK', boxes, total: ((await eda.sch_PrimitiveAttribute.getAll()) || []).length };
`, { timeoutMs: 120_000 })

const setup = {
  status: 'OK',
  pageUuid: pageStep.pageUuid,
  backTo: pageStep.backTo,
  ids: madeStep?.ids ?? [],
  created: madeStep?.created ?? 0,
  sized: sizedStep?.sized ?? 0,
  boxes: boxStep?.boxes ?? [],
  boxCount: boxStep?.total ?? 0,
}
if (setup.created < 96) console.error(`WARN only ${setup.created}/96 flags placed`)

const shots = {}
for (const [key, x, y] of [['control', 800, 335], ['staggered', 830, 850]]) {
  await callWithRetry(`
try { await eda.dmt_EditorControl.zoomTo(${x}, ${y}, ${RATIO}) } catch (e) {}
await new Promise(r => setTimeout(r, 1500));
return true;
`, { timeoutMs: 60_000 })
  const file = shoot(`t27-${key}.png`)
  shots[key] = { file, pixel: file ? analyse(file, join(work, `${key}.json`), CANVAS) : { error: 'no screenshot' } }
}

// ------------------------------------------------------------------ cleanup
// Measured rule: a page that was opened in a tab cannot be deleted until its
// tab is closed (`closeDocument`), and a page never opened deletes directly.
// So: close first, then delete, then prove the page list came back to MAIN.
const cleanup = await callWithRetry(`
const ids = ${JSON.stringify(setup.ids)};
const main = ${JSON.stringify(setup.backTo)};
const probe = ${JSON.stringify(setup.pageUuid)};
let del = null;
try { del = await eda.sch_PrimitiveComponent.delete(ids.length === 1 ? ids[0] : ids) } catch (e) { del = String((e && e.message) || e) }
await new Promise(r => setTimeout(r, 900));
try { await eda.dmt_EditorControl.openDocument(main) } catch (e) {}
await new Promise(r => setTimeout(r, 1500));
const log = [];
const strays = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid).filter(u => u !== main);
for (const page of strays) {
  const entry = { page, closed: null, deleted: null };
  try { entry.closed = JSON.stringify(await eda.dmt_EditorControl.closeDocument(page)) } catch (e) { entry.closed = 'ERR ' + String((e && e.message) || e) }
  await new Promise(r => setTimeout(r, 1200));
  try { entry.deleted = JSON.stringify(await eda.dmt_Schematic.deleteSchematicPage(page)) } catch (e) { entry.deleted = 'ERR ' + String((e && e.message) || e) }
  await new Promise(r => setTimeout(r, 1200));
  log.push(entry);
}
let pages = [];
for (let i = 0; i < 6; i++) {
  pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
  if (pages.every(u => u === main)) break;
  await new Promise(r => setTimeout(r, 1000));
}
try { await eda.dmt_EditorControl.openDocument(main) } catch (e) {}
await new Promise(r => setTimeout(r, 1200));
return {
  primitiveDelete: JSON.stringify(del), log,
  residuePages: pages.filter(u => u !== main),
  probeGone: !pages.includes(probe),
  main: { components: ((await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []).length, wires: ((await eda.sch_PrimitiveWire.getAll()) || []).length },
};
`, { timeoutMs: 240_000 })

// -------------------------------------------------------------------- report
const rowsOf = (key) => (key === 'control' ? control.length : staggered.length / 2)
const columnVerdict = (key) => {
  const cols = (shots[key]?.pixel?.columns ?? []).filter((c) => c.bands >= 4)
  const textCol = cols.sort((a, b) => b.width - a.width)[0] ?? null
  if (!textCol) return { rows: rowsOf(key), measured: null, verdict: 'NO_BANDS' }
  const expected = rowsOf(key)
  const gaps = textCol.minGap
  return {
    rows: expected,
    measuredBands: textCol.bands,
    bandHeightPx: { median: textCol.medianHeight, min: textCol.minHeight, max: textCol.maxHeight },
    minGapPx: gaps,
    medianGapPx: textCol.medianGap,
    merged: Math.max(0, expected - textCol.bands),
    verdict: textCol.bands >= expected ? 'NO_OVERLAP' : 'OVERLAP_OR_MISSED',
  }
}

const out = {
  status: calibrationOk ? 'OK' : 'CALIBRATION_FAILED',
  freshness: { gate: 'content-sha256', packages: Object.keys(freshSnapshot.packages).length },
  calibration: {
    known: calibration.known,
    pixelColumns: calCols.map((c) => ({ width: c.width, bands: c.bands, medianHeight: c.medianHeight })),
    medianBandHeightPx: calMedian,
    baseline: '2 px text band (documented)',
    ok: calibrationOk,
    image: calibration.image,
  },
  ab: {
    scaleRatio: RATIO,
    control: columnVerdict('control'),
    staggered: columnVerdict('staggered'),
    images: { control: shots.control?.file, staggered: shots.staggered?.file },
    probe: { created: setup.created, sized: setup.sized, boxCount: setup.boxCount, boxes: setup.boxes },
  },
  cleanup,
}
console.log(JSON.stringify(out, null, 1))
const good = calibrationOk &&
  columnVerdict('control').measuredBands > 0 &&
  columnVerdict('staggered').measuredBands > 0 &&
  cleanup?.probeGone && (cleanup?.residuePages || []).length === 0
process.exitCode = good ? 0 : 1
