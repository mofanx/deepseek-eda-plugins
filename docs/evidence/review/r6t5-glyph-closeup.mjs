// r6t5: decisive high-magnification, read-only close-up of the black glyph under
// the MCU-34 label in MAIN, row y=795, requested corridor x=214..252, y=787..797.
//
// The editor ignores the declared zoom rectangle in the sense that it keeps its own
// canvas framing; therefore the screenshot is a full primary-screen grab and the
// scale is self-calibrated from the 10-unit pin-row pitch, never from the requested
// rectangle. The only editor calls are read-only getAll / page-info plus zoomTo*
// (camera moves). No save, modify, create, delete or clear call is made.
//
// Usage: node docs/evidence/review/r6t5-glyph-closeup.mjs
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { gateFreshness } from './shared/freshness.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const outDir = join(repoRoot, 'docs/evidence/current')
const reviewDir = join(repoRoot, 'docs/evidence/review')
const scratch = join(tmpdir(), 'r6t5')
mkdirSync(scratch, { recursive: true })
mkdirSync(outDir, { recursive: true })
gateFreshness(repoRoot)

const RECT = { x1: 214, x2: 252, y1: 787, y2: 797 }
// The editor clipped the exact 38-unit frame at the left edge, losing the white
// box's left border. Widen only the capture frame so the target box is complete;
// the final crop is still the target corridor, and the scale is self-calibrated.
const FRAME = { x1: 195, x2: 255, y1: 787, y2: 797 }
const CONTEXT = join(outDir, 'r6t5-mcu34-context.png')
const CLOSEUP = join(outDir, 'r6t5-mcu34-glyph-closeup.png')
const RUN = join(scratch, 'run.json')
const SCREEN = { x: 0, y: 0, w: 1280, h: 2568 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

const { HttpEasyEdaBridge } = await import(pathToFileURL(join(repoRoot, 'packages/eda-core/lib/index.js')).href)
let bridge = await discoverBridge()
async function discoverBridge() {
  let last
  for (let i = 0; i < 4; i += 1) {
    try {
      return await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })
    } catch (e) {
      last = e
      await sleep(1200 * (i + 1))
    }
  }
  throw last
}
const call = async (code, options = { timeoutMs: 90_000 }) => bridge.execute(code, options)

const READ = `
const all = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) || [];
const wires = (await eda.sch_PrimitiveWire.getAll()) || [];
const pages = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [];
const active = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
const comps = all.map(c => ({ id: String(c.primitiveId || c.id || ''), type: String(c.componentType || c.ComponentType || '') }));
const ws = wires.map(w => ({ id: String(w.primitiveId || w.id || ''), net: String(w.net || '') }));
return {
  comps,
  parts: comps.filter(c => c.type === 'part').length,
  netflags: comps.filter(c => c.type === 'netflag').length,
  wires: ws.length,
  pairs: new Set(ws.map(w => w.id + '|' + w.net)).size,
  pages: pages.length,
  active: active && String(active.uuid),
  digest: comps.map(c => c.id + '|' + c.type).join(',') + '#' + ws.map(w => w.id + '|' + w.net).join(','),
};
`
const snap = async () => call(READ)
const before = await snap()
const fitBefore = await call('return await eda.dmt_EditorControl.zoomToAllPrimitives()')
await sleep(900)
const zoom = await call(`return await eda.dmt_EditorControl.zoomToRegion(${FRAME.x1}, ${FRAME.x2}, ${FRAME.y2}, ${FRAME.y1})`)
await sleep(1600)

const psFile = join(scratch, 'grab-fullscreen.ps1')
const outFile = join(scratch, 'grab-fullscreen.out')
writeFileSync(psFile, [
  'Add-Type -AssemblyName System.Drawing',
  `$bmp = New-Object System.Drawing.Bitmap(${SCREEN.w}, ${SCREEN.h})`,
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  `$g.CopyFromScreen(${SCREEN.x}, ${SCREEN.y}, 0, 0, $bmp.Size)`,
  `$bmp.Save('${CONTEXT.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  '$g.Dispose(); $bmp.Dispose()',
  `$s = (Get-Item '${CONTEXT.replace(/'/g, "''")}').Length`,
  `"$((Get-FileHash '${CONTEXT.replace(/'/g, "''")}' -Algorithm SHA256).Hash.ToLower()) ${SCREEN.w}x${SCREEN.h} $s" | Out-File -Encoding utf8 '${outFile.replace(/'/g, "''")}'`,
].join('\n'))
const grab = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { stdio: 'inherit' })
const grabLine = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim().split(/\r?\n/).pop() || '' : ''
const [contextSha, contextSize] = grabLine.split(/\s+/)
if (!contextSha || !existsSync(CONTEXT)) {
  console.log(JSON.stringify({ status: 'GRAB_FAILED', exit: grab.status, detail: grabLine, stderr: String(grab.stderr || '').slice(0, 300) }))
  process.exit(3)
}

const fitAfter = await call('return await eda.dmt_EditorControl.zoomToAllPrimitives()')
await sleep(900)
const after = await snap()
const sameRect = (a, b) => a && b && ['left', 'right', 'top', 'bottom'].every((k) => Math.abs(Number(a[k]) - Number(b[k])) < 0.01)

const run = {
  status: 'CAPTURED',
  at: new Date().toISOString(),
  requested: RECT,
  framingRequested: FRAME,
  screen: SCREEN,
  context: { file: 'docs/evidence/current/r6t5-mcu34-context.png', sha256: contextSha, size: contextSize, bytes: readFileSync(CONTEXT).length },
  zoomAccepted: zoom === true || zoom === 'true',
  fitRectBefore: fitBefore,
  fitRectAfter: fitAfter,
  cameraRestored: sameRect(fitBefore, fitAfter),
  before: { components: before.comps.length, parts: before.parts, netflags: before.netflags, wires: before.wires, pairs: before.pairs, pages: before.pages, active: before.active },
  after: { components: after.comps.length, parts: after.parts, netflags: after.netflags, wires: after.wires, pairs: after.pairs, pages: after.pages, active: after.active },
  mainDigestSame: before.digest === after.digest,
  writes: { document: 0, canvas: 0, save: 0, modify: 0, create: 0, delete: 0, clear: 0 },
}
writeFileSync(RUN, JSON.stringify(run, null, 2))
console.log(JSON.stringify(run, null, 2))
