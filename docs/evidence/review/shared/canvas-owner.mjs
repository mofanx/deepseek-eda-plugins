// r2t1: prove the canvas is painting OUR probe page before writing anything.
//
// Why a pixel test and not an API test: `createNetFlag` / `sch_PrimitiveComponent.delete`
// / `sch_PrimitiveAttribute.modify` all act on the document the canvas is painting,
// not on the page `getCurrentSchematicPageInfo()` reports. Measured 2026-10-20: two
// t27 runs wrote 96 netflags each into MAIN while the API said the active page was
// the run's own probe. Reading the active id therefore cannot decide ownership, and
// `getAll()` cannot either - it reads the same painted document, so a wrong write and
// a wrong read agree with each other.
//
// The only signal that distinguishes them is the frame: pin MAIN, shoot; pin the
// probe, shoot; compare the canvas rectangle. A page that is not painted produces
// the same pixels no matter which id the API calls active.
//
// Contract: assertOwnCanvas() never writes to a page. It only calls openDocument()
// and reads. When it returns ok:false the caller must place nothing, modify nothing,
// delete nothing, and exit 2.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PS = String.raw`
param([string]$ImgA,[string]$ImgB,[int]$X0,[int]$X1,[int]$Y0,[int]$Y1,[string]$Out)
Add-Type -AssemblyName System.Drawing
$bmpA = [System.Drawing.Bitmap]::FromFile($ImgA)
$bmpB = [System.Drawing.Bitmap]::FromFile($ImgB)
$w = [Math]::Min($bmpA.Width, $bmpB.Width)
$h = [Math]::Min($bmpA.Height, $bmpB.Height)
if ($X1 -le 0) { $X1 = $w }
if ($Y1 -le 0) { $Y1 = $h }
if ($X1 -gt $w) { $X1 = $w }
if ($Y1 -gt $h) { $Y1 = $h }
$rw = $X1 - $X0
$rh = $Y1 - $Y0
if ($rw -le 0 -or $rh -le 0) { @{ error = 'empty-rect'; w = $w; h = $h } | ConvertTo-Json | Set-Content -Path $Out -Encoding utf8; exit 0 }
$rect = New-Object System.Drawing.Rectangle($X0, $Y0, $rw, $rh)
$da = $bmpA.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$db = $bmpB.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$len = $da.Stride * $rh
$ba = New-Object byte[] $len
$bb = New-Object byte[] $len
[System.Runtime.InteropServices.Marshal]::Copy($da.Scan0, $ba, 0, $len)
[System.Runtime.InteropServices.Marshal]::Copy($db.Scan0, $bb, 0, $len)
$bmpA.UnlockBits($da)
$bmpB.UnlockBits($db)
$diff = 0
for ($i = 0; $i -lt $len; $i += 4) {
  if ($ba[$i] -ne $bb[$i] -or $ba[$i+1] -ne $bb[$i+1] -or $ba[$i+2] -ne $bb[$i+2]) { $diff++ }
}
$total = [int]($len / 4)
@{ diffPixels = $diff; totalPixels = $total; ratio = if ($total) { [Math]::Round($diff / $total, 6) } else { 0 }; w = $rw; h = $rh } |
  ConvertTo-Json | Set-Content -Path $Out -Encoding utf8
`

/** Shoot the current window into `file`; returns the path or null. */
export function shootWindow(file) {
  spawnSync('dpx', ['screenshot', '--filename', file], { shell: true, stdio: 'ignore' })
  return existsSync(file) ? file : null
}

/** Pixel-difference two images inside `rect`; returns { diffPixels, totalPixels, ratio }. */
export function frameDiff(a, b, rect = {}, workDir = tmpdir()) {
  const dir = workDir
  const ps1 = join(dir, 'frame-diff.ps1')
  const out = join(dir, `frame-diff-${Date.now()}.json`)
  writeFileSync(ps1, PS)
  const run = spawnSync('pwsh', ['-NoProfile', '-File', ps1, '-ImgA', a, '-ImgB', b, '-Out', out,
    '-X0', String(rect.x0 ?? 0), '-X1', String(rect.x1 ?? 0), '-Y0', String(rect.y0 ?? 0), '-Y1', String(rect.y1 ?? 0)],
  { stdio: 'ignore' })
  if (!existsSync(out)) return { error: `frame-diff failed (status ${run.status})` }
  try {
    return JSON.parse(readFileSync(out, 'utf8'))
  } catch (e) {
    return { error: `frame-diff output unreadable: ${String((e && e.message) || e)}` }
  }
}

/**
 * Decide, without writing, whether the canvas paints `probe`.
 *
 * @param probe          this run's throwaway page id (never MAIN)
 * @param main           the project's MAIN page id
 * @param readActive     () => active document id
 * @param openDocument   (id) => void
 * @param readTabs       optional () => [{ uuid, title }] for naming the occupier
 * @param evidenceDir    where the two frames are written
 * @param forceForeign   test hook: report FOREIGN without touching the client
 * @param minRatio       smallest frame difference that counts as "the canvas moved"
 */
export async function assertOwnCanvas({
  probe,
  main,
  readActive,
  openDocument,
  readTabs = null,
  evidenceDir = tmpdir(),
  canvas = { x0: 300, x1: 0, y0: 92, y1: 578 },
  settleMs = 1600,
  forceForeign = false,
  minRatio = 0.002,
}) {
  if (typeof probe !== 'string' || probe === '') return { ok: false, reason: 'NO_PROBE' }
  if (probe === main) return { ok: false, reason: 'PROBE_IS_MAIN', probe }

  const dir = existsSync(evidenceDir) ? evidenceDir : mkdtempSync(join(tmpdir(), 'canvas-'))
  const describe = async (uuid) => {
    let name = null
    if (typeof readTabs === 'function') {
      try {
        const tabs = (await readTabs()) ?? []
        const hit = tabs.find((t) => t && t.uuid === uuid)
        if (hit) name = hit.title ?? hit.name ?? null
      } catch (e) {
        // A tab listing failure only costs us the name, never the verdict.
      }
    }
    return { uuid: uuid ?? null, name, source: name ? 'split-screen-tree' : 'active-document-id' }
  }

  if (forceForeign) {
    let active = null
    try { active = await readActive() } catch (e) {}
    return {
      ok: false,
      reason: 'FORCED_FOREIGN_CANVAS',
      forced: true,
      occupier: await describe(active ?? main),
      frames: null,
      wrote: 0,
    }
  }

  // Frame 1: MAIN pinned. If it will not become active, we cannot run the test at
  // all - and an untested canvas must never be written to.
  try { await openDocument(main) } catch (e) {}
  await sleep(settleMs)
  let activeMain = null
  try { activeMain = await readActive() } catch (e) {}
  if (activeMain !== main) {
    return { ok: false, reason: 'MAIN_NOT_ACTIVE', active: activeMain, occupier: await describe(activeMain), frames: null, wrote: 0 }
  }
  const shotMain = shootWindow(join(dir, 'own-canvas-main.png'))
  if (!shotMain) return { ok: false, reason: 'SHOT_FAILED', which: 'main', frames: null, wrote: 0 }

  // Frame 2: our empty probe pinned.
  try { await openDocument(probe) } catch (e) {}
  await sleep(settleMs)
  let activeProbe = null
  try { activeProbe = await readActive() } catch (e) {}
  if (activeProbe !== probe) {
    return { ok: false, reason: 'PROBE_NOT_ACTIVE', active: activeProbe, occupier: await describe(activeProbe), frames: null, wrote: 0 }
  }
  const shotProbe = shootWindow(join(dir, 'own-canvas-probe.png'))
  if (!shotProbe) return { ok: false, reason: 'SHOT_FAILED', which: 'probe', frames: null, wrote: 0 }

  const diff = frameDiff(shotMain, shotProbe, canvas, dir)
  if (diff.error) return { ok: false, reason: 'FRAME_DIFF_FAILED', error: diff.error, frames: { main: shotMain, probe: shotProbe }, wrote: 0 }
  const ok = (diff.ratio ?? 0) >= minRatio
  return {
    ok,
    reason: ok ? 'CANVAS_ON_PROBE' : 'CANVAS_NOT_ON_PROBE',
    occupier: ok ? null : await describe(main),
    frames: { main: shotMain, probe: shotProbe, diff: { ratio: diff.ratio, diffPixels: diff.diffPixels, totalPixels: diff.totalPixels } },
    wrote: 0,
  }
}

/** Standard exit-2 line: occupier id, page name, reason, and the fact that nothing was written. */
export function reportForeignCanvas(tag, verdict) {
  const occ = verdict?.occupier ?? {}
  const ratio = verdict?.frames?.diff?.ratio
  console.error(
    `${tag} FOREIGN_CANVAS occupier=${occ.uuid ?? 'unknown'} name=${JSON.stringify(occ.name ?? null)} ` +
    `reason=${verdict?.reason ?? 'unknown'} wrote=0` + (ratio === undefined ? '' : ` frameRatio=${ratio}`),
  )
}
