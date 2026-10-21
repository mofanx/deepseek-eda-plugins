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
import { confirmPageGone, saveOwnDocument } from './shared/page-cleanup.mjs'

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

// ---------------------------------------------------- step 1: resolve MAIN
// The old constant b188905f belonged to a project that no longer exists, so the
// page step could only ever fail safely. Resolve the live MAIN instead: name,
// schematic, and the component/wire counts the run must leave untouched.
const mainStep = await callWithRetry(`
const pages = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [];
const main = pages.find(p => p.name === 'MAIN');
if (!main) return { status: 'NO_MAIN', pages: pages.map(p => ({ uuid: p.uuid, name: p.name })) };
try { await eda.dmt_EditorControl.openDocument(main.uuid) } catch (e) {}
await new Promise(r => setTimeout(r, 900));
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!cur || cur.uuid !== main.uuid) return { status: 'MAIN_NOT_OPEN', main: main.uuid, active: cur };
return {
  status: 'OK',
  main: main.uuid,
  name: main.name,
  schematic: main.parentSchematicUuid,
  components: ((await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []).length,
  wires: ((await eda.sch_PrimitiveWire.getAll()) || []).length,
};
`, { timeoutMs: 120_000 })

if (!mainStep || mainStep.status !== 'OK') {
  console.error(JSON.stringify({ status: mainStep?.status || 'NO_MAIN', detail: mainStep }, null, 1))
  process.exit(1)
}

// ------------------------------------------- step 2: calibration (moved)
// Calibration used to run here, on MAIN, and only then create the probe. That
// measured whatever tab the client happened to render, which is exactly the
// ambiguity this task removes. It now runs on this run's own probe page, after
// the page is created, activated and verified - see "canvas tracking" below.

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
// Measurement surface: a page we create from the live MAIN's schematic. MAIN
// itself is never written to - the A/B step deletes every component on the
// active page before placing its flags, and on MAIN that would wipe the real
// project. A fresh page keeps the same parent schematic, is empty by
// construction, and is the only page this run deletes.
const pageStep = await callWithRetry(`
const main = ${JSON.stringify(mainStep.main)};
const before = new Set(((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid));
let created = null;
try { created = await eda.dmt_Schematic.createSchematicPage(${JSON.stringify(mainStep.schematic)}) } catch (e) { created = 'ERR ' + String((e && e.message) || e) }
await new Promise(r => setTimeout(r, 1000));
const after = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []);
const fresh = after.find(p => !before.has(p.uuid));
const probe = typeof created === 'string' && !created.startsWith('ERR') ? created : (fresh && fresh.uuid);
if (typeof probe !== 'string') return { status: 'PROBE_PAGE_UNAVAILABLE', created };
if (probe === main) return { status: 'REFUSED_TARGET_IS_MAIN', probe };
const readTabs = async () => {
  try {
    const t = await eda.dmt_EditorControl.getSplitScreenTree();
    return ((t && t.tabs) || [])
      .filter((x) => x && x.data && x.data.doctype === 1)
      .map((x) => ({ uuid: x.data['data-model-sheet-uuid'], title: x.title, unsaved: x.isUnSaved === true }));
  } catch (e) { return [] }
};
let active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!active || active.uuid !== probe) {
  try { await eda.dmt_EditorControl.openDocument(probe) } catch (e) {}
  await new Promise(r => setTimeout(r, 1400));
  active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
}
const tabs = await readTabs();
const occupier = active && active.uuid !== probe
  ? { uuid: active.uuid, name: active.name ?? (tabs.find(t => t.uuid === active.uuid) || {}).title ?? null, source: 'api-active' }
  : null;
if (!active || active.uuid !== probe) return { status: 'WRONG_PAGE', probe, active: active && { uuid: active.uuid, name: active.name ?? null }, tabs, occupier };
let maxX = 0;
for (const c of (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []) {
  try { const b = c.getState_BoundingBox ? c.getState_BoundingBox() : null; if (b && b.maxX > maxX) maxX = b.maxX } catch (e) {}
}
return { status: 'OK', pageUuid: probe, backTo: main, tabs, occupier, occupiedMaxX: maxX, mainComponents: ${JSON.stringify(mainStep.components)} };
`, { timeoutMs: 120_000 })

if (!pageStep || pageStep.status !== 'OK') {
  // The page was created but never became the active document. This is the
  // environment case the two statuses were split for: report it as
  // CALIBRATION_UNAVAILABLE with the occupier's id and name, never as a
  // calibration failure. No save is attempted - we do not own the active
  // document, and sch_Document.save() would write it.
  const bad = pageStep || { status: 'NO_PAGE_STEP' }
  if (bad.status === 'WRONG_PAGE') {
    const probeId = bad.probe
    const occ = bad.occupier
    const cleanupUnavailable = probeId && probeId !== mainStep.main
      ? await callWithRetry(`
const probe = ${JSON.stringify(probeId)};
const main = ${JSON.stringify(mainStep.main)};
if (probe === main) return { refused: 'TARGET_IS_MAIN' };
let deleted = null;
try { deleted = JSON.stringify(await eda.dmt_Schematic.deleteSchematicPage(probe)) } catch (e) { deleted = 'ERR ' + String((e && e.message) || e) }
const pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
const mainNow = { components: ((await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []).length, wires: ((await eda.sch_PrimitiveWire.getAll()) || []).length };
return { deleted, probeGone: !pages.includes(probe), pages: pages.length, main: mainNow, mainIntact: mainNow.components === ${JSON.stringify(mainStep.components)} && mainNow.wires === ${JSON.stringify(mainStep.wires)} };
`, { timeoutMs: 120_000 })
      : null
    console.error(`CALIBRATION_UNAVAILABLE occupier=${occ?.uuid ?? 'unknown'} name=${JSON.stringify(occ?.name ?? null)} reason=active-document-is-not-this-run-probe probe=${probeId ?? 'none'}`)
    console.log(JSON.stringify({
      status: 'CALIBRATION_UNAVAILABLE',
      freshness: { gate: 'content-sha256', packages: Object.keys(freshSnapshot.packages).length },
      resolvedMain: { uuid: mainStep.main, name: mainStep.name, components: mainStep.components, wires: mainStep.wires },
      calibration: {
        status: 'UNAVAILABLE',
        reason: 'active-document-is-not-this-run-probe',
        occupier: occ ?? { uuid: null, name: null, source: 'unknown' },
        tabs: bad.tabs ?? [],
        note: 'no A/B verdict is claimed; probeGone and mainIntact remain hard assertions',
      },
      cleanup: cleanupUnavailable,
    }, null, 1))
    process.exit(2)
  }
  console.error(`FAIL page step: ${JSON.stringify(bad)}`)
  process.exit(1)
}

// The canvas is the instrument, and this client's zoom calls return ok without
// changing what is painted (measured 2026-10-20). It also does not necessarily
// paint the page the API calls active: two earlier runs wrote 96 netflags each
// into MAIN, because createNetFlag goes to the document on screen rather than
// to getCurrentSchematicPageInfo(). Ownership is therefore decided BEFORE any
// write, and without writing: take a frame with MAIN active, take a frame with
// the empty probe active, and compare. Identical frames mean the canvas is not
// following the active page, so this run places nothing, resizes nothing, and
// reports who owns the pixels instead of calibrating on them.
const probeTabs = pageStep.tabs ?? []
const sig = (px) => ((px?.columns ?? []).map((c) => `${c.xFrom}:${c.xTo}:${c.bands}:${c.medianHeight}`).join('|'))
const frameOf = (label) => {
  const file = shoot(`t27-owner-${label}.png`)
  return { file, pixel: file ? analyse(file, join(work, `owner-${label}.json`), CANVAS) : { error: 'no screenshot' } }
}
const pinMain = await callWithRetry(`
try { await eda.dmt_EditorControl.openDocument(${JSON.stringify(pageStep.backTo)}) } catch (e) {}
await new Promise(r => setTimeout(r, 1600));
const c = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
return { active: c && c.uuid };
`, { timeoutMs: 60_000 })
const ownerMain = frameOf('main')
const pinProbe = await callWithRetry(`
try { await eda.dmt_EditorControl.openDocument(${JSON.stringify(pageStep.pageUuid)}) } catch (e) {}
await new Promise(r => setTimeout(r, 1600));
const c = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
return { active: c && c.uuid };
`, { timeoutMs: 60_000 })
const ownerProbe = frameOf('probe')
const canvasFollows = sig(ownerMain.pixel) !== sig(ownerProbe.pixel)
const pixelBefore = ownerProbe.pixel

const madeStep = !canvasFollows
  ? { status: 'SKIPPED_CANVAS_NOT_ON_PROBE', created: 0, ids: [] }
  : await callWithRetry(`
// Safety: the wipe below is only legitimate on the throwaway page this run
// created. Refuse if the active page drifted back to MAIN or anywhere else.
const probe = ${JSON.stringify(pageStep.pageUuid)};
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!cur || cur.uuid !== probe) return { status: 'WRONG_PAGE', probe, active: cur };
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
if (!${JSON.stringify(canvasFollows)}) return { status: 'SKIPPED_CANVAS_NOT_ON_PROBE', sized: 0 };
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
if (!${JSON.stringify(canvasFollows)}) return { status: 'SKIPPED_CANVAS_NOT_ON_PROBE', boxes: [], total: 0 };
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
if (canvasFollows && setup.created < 96) console.error(`WARN only ${setup.created}/96 flags placed`)

const shots = {}
// The control strip is the calibration target: 48 flags one per 10 units.
await callWithRetry(`
try { await eda.dmt_EditorControl.zoomTo(800, 335, ${RATIO}) } catch (e) {}
await new Promise(r => setTimeout(r, 1800));
return true;
`, { timeoutMs: 60_000 })
{
  const file = shoot('t27-control.png')
  shots.control = { file, pixel: file ? analyse(file, join(work, 'control.json'), CANVAS) : { error: 'no screenshot' } }
}

// Canvas-tracking test. The API reports the probe as active either way; only the
// frame can tell whether the canvas paints it. A page that just gained 96
// primitives must look different. If it does not, the canvas is showing another
// document and every pixel verdict below would be about that document.
const frameChanged = sig(pixelBefore) !== sig(shots.control.pixel)
const reasonCode = canvasFollows
  ? 'canvas-did-not-change-after-96-primitives'
  : 'canvas-did-not-change-between-MAIN-and-empty-probe'
const otherTabs = probeTabs.filter((t) => t.uuid !== setup.pageUuid)
const canvasOccupier = otherTabs.length === 1
  ? {
      uuid: otherTabs[0].uuid,
      name: otherTabs[0].title,
      source: 'inferred',
      evidence: canvasFollows
        ? 'canvas frame did not change after 96 primitives were added to the active probe page'
        : 'canvas painted the same frame with MAIN active and with the empty probe active; this run wrote nothing',
    }
  : { uuid: null, name: null, source: 'unknown', candidates: otherTabs }

const calCols = shots.control.pixel?.columns ?? []
const calHeights = calCols.map((c) => c.medianHeight).sort((a, b) => a - b)
const calMedian = calHeights.length ? calHeights[Math.floor(calHeights.length / 2)] : null
// OK: the frame shows text bands of a plausible height. FAILED: we own the
// active document and the frame still has nothing measurable - a real failure.
// UNAVAILABLE: the frame provably belongs to another document (see above).
const calStatus = !canvasFollows || !frameChanged
  ? 'UNAVAILABLE'
  : (calCols.length === 0 || calMedian === null ? 'FAILED' : (calMedian >= 1 && calMedian <= 80 ? 'OK' : 'FAILED'))
const calibrationOk = calStatus === 'OK'
const calibration = { image: shots.control.file, known: { probes: setup.created, boxes: setup.boxCount } }

await callWithRetry(`
try { await eda.dmt_EditorControl.zoomTo(830, 850, ${RATIO}) } catch (e) {}
await new Promise(r => setTimeout(r, 1500));
return true;
`, { timeoutMs: 60_000 })
{
  const file = shoot('t27-staggered.png')
  shots.staggered = { file, pixel: file ? analyse(file, join(work, 'staggered.json'), CANVAS) : { error: 'no screenshot' } }
}

// ------------------------------------------------------------------ cleanup
// Only the probe page this run created is deleted. Other pages (the known P1
// orphans, or a concurrent member's probe) are neither ours to delete nor part
// of this script's assertion; we report them and leave them alone.
//
// Split in three so the save can be guarded in Node: `sch_Document.save()`
// takes no id and writes whatever document is active, so it must never be
// called unless the active document is provably this run's probe.
const cleanupA = await callWithRetry(`
const ids = ${JSON.stringify(setup.ids)};
if (!ids.length) return { status: 'NOTHING_WRITTEN' };
const probe = ${JSON.stringify(setup.pageUuid)};
const cur = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
if (!cur || cur.uuid !== probe) return { status: 'WRONG_PAGE', probe, active: cur && cur.uuid };
let del = null;
try { del = await eda.sch_PrimitiveComponent.delete(ids.length === 1 ? ids[0] : ids) } catch (e) { del = String((e && e.message) || e) }
await new Promise(r => setTimeout(r, 700));
return { status: 'OK', primitiveDelete: JSON.stringify(del) };
`, { timeoutMs: 240_000 })

// Test hook (t1): simulate a concurrent member grabbing the active document
// between the measurement and the cleanup save. The guard must notice, switch
// back to the probe, and only then save; it must never save the foreign page.
if (process.env.T27_FORCE_FOREIGN_AT_SAVE === '1') {
  await callWithRetry(`try { await eda.dmt_EditorControl.openDocument(${JSON.stringify(setup.backTo)}) } catch (e) {} await new Promise(r => setTimeout(r, 900)); return true;`, { timeoutMs: 60_000 })
}

const saveResult = await saveOwnDocument({
  probe: setup.pageUuid,
  main: setup.backTo,
  readActive: () => callWithRetry(`const c = await eda.dmt_Schematic.getCurrentSchematicPageInfo(); return c && c.uuid;`, { timeoutMs: 60_000 }),
  openDocument: () => callWithRetry(`try { await eda.dmt_EditorControl.openDocument(${JSON.stringify(setup.pageUuid)}) } catch (e) {} return true;`, { timeoutMs: 60_000 }),
  save: () => callWithRetry(`const r = await eda.sch_Document.save(); return r === undefined ? null : r;`, { timeoutMs: 90_000 }),
})

const cleanupB = await callWithRetry(`
const main = ${JSON.stringify(setup.backTo)};
const probe = ${JSON.stringify(setup.pageUuid)};
if (probe === main) return { refused: 'TARGET_IS_MAIN' };
try { await eda.dmt_EditorControl.openDocument(main) } catch (e) {}
await new Promise(r => setTimeout(r, 1500));
let closed = null, deleted = null;
try { closed = JSON.stringify(await eda.dmt_EditorControl.closeDocument(probe)) } catch (e) { closed = 'ERR ' + String((e && e.message) || e) }
await new Promise(r => setTimeout(r, 1000));
if (${JSON.stringify(process.env.T27_SKIP_DELETE === '1')}) deleted = 'SKIPPED_BY_TEST_HOOK';
else try { deleted = JSON.stringify(await eda.dmt_Schematic.deleteSchematicPage(probe)) } catch (e) { deleted = 'ERR ' + String((e && e.message) || e) }
let pages = [];
for (let i = 0; i < 6; i++) {
  pages = ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []).map(p => p.uuid);
  if (!pages.includes(probe)) break;
  await new Promise(r => setTimeout(r, 1000));
}
try { await eda.dmt_EditorControl.openDocument(main) } catch (e) {}
await new Promise(r => setTimeout(r, 1200));
const mainNow = { components: ((await eda.sch_PrimitiveComponent.getAll(undefined, false)) || []).length, wires: ((await eda.sch_PrimitiveWire.getAll()) || []).length };
return {
  closed, deleted,
  residuePages: pages.filter(u => u !== main),
  probeGone: !pages.includes(probe),
  main: mainNow,
  mainIntact: mainNow.components === ${JSON.stringify(mainStep.components)} && mainNow.wires === ${JSON.stringify(mainStep.wires)},
};
`, { timeoutMs: 240_000 })

const cleanup = {
  ...(cleanupA ?? {}),
  save: saveResult,
  ...(cleanupB ?? {}),
}

// -------------------------------------------------------------------- report
const rowsOf = (key) => (key === 'control' ? control.length : staggered.length / 2)
const columnVerdict = (key) => {
  const cols = (shots[key]?.pixel?.columns ?? []).filter((c) => c.bands >= 4)
  const textCol = cols.sort((a, b) => b.width - a.width)[0] ?? null
  if (!textCol) return { rows: rowsOf(key), measured: null, verdict: calStatus === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'NO_BANDS' }
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
  resolvedMain: { uuid: mainStep.main, name: mainStep.name, schematic: mainStep.schematic, components: mainStep.components, wires: mainStep.wires },
  calibration: {
    known: calibration.known,
    pixelColumns: calCols.map((c) => ({ width: c.width, bands: c.bands, medianHeight: c.medianHeight })),
    medianBandHeightPx: calMedian,
    status: calStatus,
    ok: calibrationOk,
    image: calibration.image,
    // Evidence, not a guess: the canvas must change when the active page gains
    // 96 primitives. If it does not, the frame belongs to another document.
    canvasTracking: {
      canvasFollows,
      reason: reasonCode,
      pinnedActive: { main: pinMain?.active ?? null, probe: pinProbe?.active ?? null },
      ownerFrames: { main: sig(ownerMain.pixel), probe: sig(ownerProbe.pixel) },
      frameChanged,
      occupier: calStatus === 'UNAVAILABLE' ? canvasOccupier : null,
      activeProbe: setup.pageUuid,
      openTabs: probeTabs,
      before: { columns: (pixelBefore.columns ?? []).length, signature: sig(pixelBefore) },
      after: { columns: (shots.control.pixel?.columns ?? []).length, signature: sig(shots.control.pixel) },
    },
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
// The delete return value is not evidence (measured: false+gone, true+gone and
// true+still-there all occur). Re-list with increasing waits and judge on that.
const confirm = await confirmPageGone(async () => {
  const pages = await callWithRetry(`return ((await eda.dmt_Schematic.getAllSchematicPagesInfo())||[]).map(p=>p.uuid);`, { timeoutMs: 60_000 })
  return Array.isArray(pages) ? pages : []
}, setup.pageUuid)
out.cleanupConfirm = confirm
const probeGone = cleanup?.probeGone === true && confirm.gone === true
const mainIntact = cleanup?.mainIntact === true

// Precedence matters: a leaked probe or a touched MAIN outranks every
// measurement outcome, so they cannot be hidden behind a calibration status.
if (!mainIntact) {
  out.status = 'MAIN_CHANGED'
  console.error(`MAIN_CHANGED main=${JSON.stringify(cleanup?.main)} expected components/wires from the start of this run`)
  console.log(JSON.stringify(out, null, 1))
  process.exit(1)
}
if (!probeGone) {
  out.status = 'PROBE_LEAK'
  out.leakedProbe = confirm.leakedId ?? setup.pageUuid
  console.error(`PROBE_LEAK probe=${out.leakedProbe} deleteSaid=${JSON.stringify(cleanup?.deleted)} recheck=${JSON.stringify(confirm.attempts)}`)
  console.log(JSON.stringify(out, null, 1))
  process.exit(1)
}
if (calStatus === 'UNAVAILABLE') {
  out.status = 'CALIBRATION_UNAVAILABLE'
  out.occupier = canvasOccupier
  const occ = canvasOccupier
  console.error(`CALIBRATION_UNAVAILABLE occupier=${occ?.uuid ?? 'unknown'} name=${JSON.stringify(occ?.name ?? null)} reason=${reasonCode} activeProbe=${setup.pageUuid} wrote=${setup.created} frames=${canvasOccupier?.evidence ?? 'n/a'}`)
  console.log(JSON.stringify(out, null, 1))
  process.exit(2)
}
if (calStatus === 'FAILED') {
  out.status = 'CALIBRATION_FAILED'
  console.log(JSON.stringify(out, null, 1))
  process.exit(1)
}
const cV = columnVerdict('control')
const sV = columnVerdict('staggered')
const good = madeStep?.status === 'OK' && cV.measuredBands > 0 && sV.measuredBands > 0 &&
  cV.verdict === 'NO_OVERLAP' && sV.verdict === 'NO_OVERLAP'
out.status = good ? 'OK' : 'OVERLAP_OR_MISSED'
console.log(JSON.stringify(out, null, 1))
process.exitCode = good ? 0 : 1
