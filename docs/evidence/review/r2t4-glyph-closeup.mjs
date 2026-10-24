// r2t4: independent close-up of the pressed band at row 795, x 214-252, y 787-797.
//
// Why this exists: r6t3 (my own review) refused to say which glyphs sit under the MCU-26 label,
// because the 8.25 px/unit frames could not separate a 2-digit pin number from a 6-char net name.
// This script takes a NEW capture at >=16 px/unit instead of reusing any existing crop.
//
// Capture path: the EDA editor is an Edge window, so the screenshot is a 1:1 screen capture
// (PowerShell CopyFromScreen) of the editor's drawing area - the same mechanism the committed
// 660x2030 frames came from, not dpx (dpx in this session is bound to a Chrome start page).
// The editor's camera is moved by the bridge, which is a view operation, and restored at the end.
//
// Scale is self-calibrated from the pin-row pitch (exactly 10 units), never taken from the
// requested rectangle. Read-only: no create/modify/save, only zoomTo* and a screen grab.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'

const OUT_DIR = 'docs/evidence/current'
const PNG = join(OUT_DIR, 'r2t4-glyph-closeup.png')
const scratch = join(tmpdir(), 'r2t4')
if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true })

// corridor under review, in schematic units
const RECT = { x1: 214, x2: 252, y1: 787, y2: 797 }

// screen region to grab: the editor drawing area, generously wide so no canvas edge is assumed
const GRAB = { x: 60, y: 70, w: 920, h: 1730 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
const call = async (code, ms = 60_000) => bridge.execute(code, { timeoutMs: ms })

let seq = 0
// Run a PowerShell script from a file and return what it wrote to the out file it was given.
const ps = (build, tag) => {
  seq += 1
  const scriptFile = join(scratch, `${tag}-${seq}.ps1`)
  const outFile = join(scratch, `${tag}-${seq}.out`)
  writeFileSync(scriptFile, build(outFile).join('\n'))
  const r = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { stdio: 'inherit' })
  const out = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
  return { status: r.status, out, outFile }
}

// invariant snapshot before / after, so "nothing was written" is not just a claim
const READ = `
const all = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const wires = (await eda.sch_PrimitiveWire.getAll()) || [];
const pages = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [];
return { comps: all.map(c => String(c.primitiveId || c.id) + '|' + String(c.componentType || '')),
  wires: wires.map(w => String(w.primitiveId || w.id) + '|' + String(w.net || '')),
  pages: pages.length };
`
const snap = async () => {
  const r = await call(READ)
  return { comps: r.comps.length, wires: r.wires.length, pages: r.pages, digest: r.comps.join(',') + '#' + r.wires.join(',') }
}
const before = await snap()

// ------------------------------------------------------------------ capture
const fitRectBefore = await call('return await eda.dmt_EditorControl.zoomToAllPrimitives()')
await sleep(800)
const zoom = await call(
  `return await eda.dmt_EditorControl.zoomToRegion(${RECT.x1}, ${RECT.x2}, ${RECT.y2}, ${RECT.y1})`,
)
await sleep(1200)

const grab = ps((out) => [
  'Add-Type -AssemblyName System.Drawing',
  `$bmp = New-Object System.Drawing.Bitmap(${GRAB.w}, ${GRAB.h})`,
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  `$g.CopyFromScreen(${GRAB.x}, ${GRAB.y}, 0, 0, $bmp.Size)`,
  `$bmp.Save('${PNG.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  '$g.Dispose(); $bmp.Dispose()',
  `"$((Get-FileHash '${PNG.replace(/'/g, "''")}' -Algorithm SHA256).Hash.ToLower()) ${GRAB.w}x${GRAB.h}" | Out-File -Encoding utf8 '${out.replace(/'/g, "''")}'`,
], 'grab')
const [sha, sizeTxt] = grab.out.trim().split(/\s+/)
if (!sha) {
  console.log(JSON.stringify({ status: 'GRAB_FAILED', detail: grab.out }))
  process.exit(3)
}

// ------------------------------------------------------------------ analyse
const psLines = (out) => [
  'Add-Type -AssemblyName System.Drawing',
  `$b = [System.Drawing.Bitmap]::FromFile('${PNG.replace(/'/g, "''")}')`,
  '$W = $b.Width; $H = $b.Height',
  '$rows = @(); $black = @(); $blue = @(); $green = @()',
  'for ($y = 0; $y -lt $H; $y++) {',
  '  $nb = 0; $ng = 0; $nu = 0',
  '  for ($x = 0; $x -lt $W; $x++) {',
  '    $c = $b.GetPixel($x, $y)',
  '    if ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) { $nb++ }',
  '    elseif ($c.G -gt $c.R + 20 -and $c.G -gt $c.B + 20) { $ng++ }',
  '    elseif ($c.B -gt $c.R + 40 -and $c.B -gt $c.G + 40) { $nu++ }',
  '  }',
  '  if ($nb -gt 0 -or $ng -gt 0 -or $nu -gt 0) { $rows += [pscustomobject]@{ y = $y; black = $nb; green = $ng; blue = $nu } }',
  '}',
  'for ($x = 0; $x -lt $W; $x++) {',
  '  $n = 0; $ymin = $H; $ymax = -1',
  '  for ($y = 0; $y -lt $H; $y++) { $c = $b.GetPixel($x, $y); if ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) { $n++; if ($y -lt $ymin) { $ymin = $y }; if ($y -gt $ymax) { $ymax = $y } } }',
  '  $black += [pscustomobject]@{ x = $x; n = $n; ymin = $ymin; ymax = $ymax }',
  '}',
  'for ($x = 0; $x -lt $W; $x++) {',
  '  $n = 0; $ymin = $H; $ymax = -1',
  '  for ($y = 0; $y -lt $H; $y++) { $c = $b.GetPixel($x, $y); if ($c.B -gt $c.R + 40 -and $c.B -gt $c.G + 40) { $n++; if ($y -lt $ymin) { $ymin = $y }; if ($y -gt $ymax) { $ymax = $y } } }',
  '  $blue += [pscustomobject]@{ x = $x; n = $n; ymin = $ymin; ymax = $ymax }',
  '}',
  '$sz = Get-Item ' + `'${PNG.replace(/'/g, "''")}'`,
  '$b.Dispose()',
  `@{ rows = $rows; black = $black; blue = $blue; dpi = @{ w = $W; h = $H } } | ConvertTo-Json -Depth 4 -Compress | Out-File -Encoding utf8 '${out.replace(/'/g, "''")}'`,
]
const aRes = ps(psLines, 'analyse')
if (!aRes.out.trim()) {
  console.log(JSON.stringify({ status: 'ANALYSE_FAILED', detail: aRes.status }))
  process.exit(4)
}
const prof = JSON.parse(aRes.out.trim())

// ------------------------------------------------------- restore the camera
const restored = await call('return await eda.dmt_EditorControl.zoomToAllPrimitives()')
await sleep(900)
const after = await snap()
const same = (a, b) => a && b && ['left', 'right', 'top', 'bottom'].every((k) => Math.abs(a[k] - b[k]) < 0.01)

// -------------------------------------------------------------- calibration
// Row bands: contiguous scanlines that carry ink. The pin numbers are the black-only bands.
const bands = []
{
  let cur = null
  for (const r of prof.rows) {
    if (!cur || r.y > cur.y1 + 2) { cur = { y0: r.y, y1: r.y, black: 0, blue: 0, green: 0 }; bands.push(cur) }
    else { cur.y1 = r.y }
    cur.black += r.black; cur.blue += r.blue; cur.green += r.green
  }
}
// a pin-number band is mostly black, spans several scanlines, and is narrow in black columns
const blackBands = bands.filter((b) => b.black > 20 && b.y1 - b.y0 >= 4)

writeFileSync(join(scratch, 'bands.json'), JSON.stringify({ bands, blackBands }, null, 2))
writeFileSync(join(scratch, 'measure.json'), JSON.stringify({
  status: 'OK', rect: RECT, grab: GRAB, png: PNG, sha256: sha, size: sizeTxt,
  zoomAccepted: zoom === true || zoom === 'true',
  dpi: prof.dpi, bands, blackBands,
  camera: { fitRectBefore, restored, same: same(restored, fitRectBefore), invariantSame: before.digest === after.digest },
  invariants: { before: { comps: before.comps, wires: before.wires, pages: before.pages }, after: { comps: after.comps, wires: after.wires, pages: after.pages } },
}, null, 2))

console.log(JSON.stringify({
  status: 'OK',
  sha256: sha,
  size: sizeTxt,
  blackBands: blackBands.map((b) => ({ y0: b.y0, y1: b.y1, black: b.black })),
  bandCount: bands.length,
  cameraSame: same(restored, fitRectBefore),
  invariantSame: before.digest === after.digest,
}, null, 2))
