// Independent screenshot measurement for the t6 cross-review (v2).
//
// The reference-side evidence records fillRatio: null, and the current-side
// fill values are self-reported by the agent that produced the layout. This
// script measures the committed PNGs directly so neither number has to be
// trusted. The screenshots are whole EasyEDA IDE windows (1612x750) with dark
// UI chrome around a white drawing page, so the first job is to find the page.
//
// Method (documented so it can be reproduced or falsified):
//   1. decode the PNG with node:zlib only (no image libraries);
//   2. find the drawing frame as the largest rectangle whose sides are long
//      runs of dark pixels and whose aspect ratio is close to A3 (1.414). The
//      aspect constraint is what separates the page border from UI separators,
//      which are also long dark runs;
//   3. content region = page inset by a 4% border band (drops the double
//      border, the zone ticks and the 1-6 / A-D labels), with the title-block
//      rectangle masked out (bottom-right 45% x 22%);
//   4. content bbox = bounding box of ink inside the content region;
//   5. fillRatio = content bbox area / page area, the same convention as
//      packages/eda-core/tests/page-budget.spec.ts (content box / whole page).
// Ink is anything not near-white: luminance < 200 or a saturated colour. The
// strict reading (luminance < 120) and the raw ink density are reported too,
// because a bbox is sensitive to a single stray mark.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { basename } from 'node:path'

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  let palette = null
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error('interlaced PNG is not supported')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (channels === undefined) throw new Error(`unsupported colour type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = channels
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const rowStart = y * stride
    const prevStart = rowStart - stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[rowStart + x - bpp] : 0
      const b = y > 0 ? out[prevStart + x] : 0
      const c = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      } else if (filter !== 0) throw new Error(`unsupported filter ${filter}`)
      out[rowStart + x] = v
    }
  }
  return { width, height, channels, colorType, data: out, palette }
}

function pixels(img) {
  const { width, height, channels, colorType, data, palette } = img
  const lum = new Uint8Array(width * height)
  const sat = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    let r
    let g
    let b
    if (colorType === 3) {
      const idx = data[i * channels] * 3
      r = palette[idx]
      g = palette[idx + 1]
      b = palette[idx + 2]
    } else if (channels >= 3) {
      r = data[i * channels]
      g = data[i * channels + 1]
      b = data[i * channels + 2]
    } else r = g = b = data[i * channels]
    lum[i] = (r * 299 + g * 587 + b * 114) / 1000
    sat[i] = Math.max(r, g, b) - Math.min(r, g, b)
  }
  return { lum, sat }
}

const dark = (l) => l < 160
const anyInk = (l, s) => l < 200 || s > 40
const strongInk = (l) => l < 120

/** Longest run of dark pixels in a row (y) or column (x). */
function longestRun(lum, width, height, index, isRow) {
  let best = 0
  let run = 0
  const n = isRow ? width : height
  for (let i = 0; i < n; i++) {
    const l = isRow ? lum[index * width + i] : lum[i * width + index]
    if (dark(l)) {
      run++
      if (run > best) best = run
    } else run = 0
  }
  return best
}

function meanLum(lum, width, r) {
  let sum = 0
  let n = 0
  const stepX = Math.max(1, Math.floor((r.x1 - r.x0) / 40))
  const stepY = Math.max(1, Math.floor((r.y1 - r.y0) / 40))
  for (let y = r.y0 + 2; y <= r.y1 - 2; y += stepY) {
    for (let x = r.x0 + 2; x <= r.x1 - 2; x += stepX) {
      sum += lum[y * width + x]
      n++
    }
  }
  return n === 0 ? 0 : sum / n
}

/**
 * Refine the page rectangle by four 1-D line searches around a guess. Every
 * capture is the same IDE window at 41% zoom, so the page sits in the same
 * place in all of them and the search only has to snap onto the four border
 * lines. Counting pixels below the line threshold along the expected span is
 * robust to the thin anti-aliased border that a run-length test misses.
 */
function refinePageRect(lum, width, guess, lineThreshold = 215) {
  const spanDark = (fixed, lo, hi, isRow) => {
    let n = 0
    for (let i = lo; i <= hi; i++) {
      const l = isRow ? lum[fixed * width + i] : lum[i * width + fixed]
      if (l < lineThreshold) n++
    }
    return n
  }
  const bestIn = (candidates, lo, hi, isRow) => {
    let best = candidates[0]
    let bestScore = -1
    for (const c of candidates) {
      const score = spanDark(c, lo, hi, isRow)
      if (score > bestScore) {
        bestScore = score
        best = c
      }
    }
    return best
  }
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
  const top = bestIn(range(guess.y0 - 12, guess.y0 + 12), guess.x0, guess.x1, true)
  const bottom = bestIn(range(guess.y1 - 12, guess.y1 + 12), guess.x0, guess.x1, true)
  const left = bestIn(range(guess.x0 - 12, guess.x0 + 12), top, bottom, false)
  const right = bestIn(range(guess.x1 - 12, guess.x1 + 12), top, bottom, false)
  return { x0: left, y0: top, x1: right, y1: bottom, w: right - left, h: bottom - top }
}

function inkBbox(lum, sat, width, test, region, exclude) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let count = 0
  for (let y = region.y0; y <= region.y1; y++) {
    for (let x = region.x0; x <= region.x1; x++) {
      if (exclude && x >= exclude.x0 && x <= exclude.x1 && y >= exclude.y0 && y <= exclude.y1) continue
      const i = y * width + x
      if (!test(lum[i], sat[i])) continue
      count++
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return count === 0 ? null : { x0: minX, y0: minY, x1: maxX, y1: maxY, w: maxX - minX + 1, h: maxY - minY + 1, count }
}

// Page position guess, in image pixels: every capture is the same IDE window
// (1612x750) at 41% zoom with an A3 page, and the canvas viewport does not move
// between captures, so the page border sits at the same place in all of them.
const PAGE_GUESS = { x0: 480, y0: 86, x1: 1150, y1: 576 }

function analyse(file) {
  const img = decodePng(readFileSync(file))
  const { width, height } = img
  const { lum, sat } = pixels(img)
  const page = refinePageRect(lum, width, PAGE_GUESS)
  if (page.w < 100 || page.h < 100) return { file: basename(file), error: 'page rectangle not found' }
  const band = Math.round(page.w * 0.04)
  const region = { x0: page.x0 + band, y0: page.y0 + band, x1: page.x1 - band, y1: page.y1 - band }
  const exclude = {
    x0: page.x1 - Math.round(page.w * 0.45),
    y0: page.y1 - Math.round(page.h * 0.22),
    x1: page.x1,
    y1: page.y1,
  }
  const content = inkBbox(lum, sat, width, anyInk, region, exclude)
  const strict = inkBbox(lum, sat, width, strongInk, region, exclude)
  const noMask = inkBbox(lum, sat, width, anyInk, region, null)
  const pageArea = page.w * page.h
  const regionArea = (region.x1 - region.x0 + 1) * (region.y1 - region.y0 + 1) - (exclude.x1 - exclude.x0 + 1) * (exclude.y1 - exclude.y0 + 1)
  return {
    file: basename(file),
    image: `${width}x${height}`,
    pageRect: `${page.w}x${page.h} @ ${page.x0},${page.y0} (aspect ${(page.w / page.h).toFixed(3)})`,
    contentBox: content ? `${content.w}x${content.h} @ ${content.x0},${content.y0}` : null,
    fillRatio: content ? +((content.w * content.h) / pageArea).toFixed(4) : null,
    fillStrict: strict ? +((strict.w * strict.h) / pageArea).toFixed(4) : null,
    fillNoTitleBlockMask: noMask ? +((noMask.w * noMask.h) / pageArea).toFixed(4) : null,
    inkDensity: content ? +(content.count / regionArea).toFixed(4) : null,
    inkPixels: content ? content.count : 0,
    touchesRegionEdge: content
      ? { left: content.x0 <= region.x0, top: content.y0 <= region.y0, right: content.x1 >= region.x1, bottom: content.y1 >= region.y1 }
      : null,
  }
}

const files = process.argv.slice(2)
const out = files.map(analyse)
console.log(JSON.stringify(out, null, 1))
mkdirSync('docs/evidence/review', { recursive: true })
writeFileSync(
  'docs/evidence/review/fill-measure.json',
  JSON.stringify(
    {
      method: 'page = largest A3-aspect rectangle bounded by long dark runs; content region = page inset 4% with the bottom-right title block (45% x 22%) masked out; fillRatio = content ink bbox area / page area',
      caveats: [
        'bbox-based: one stray mark (or a UI overlay inside the page) inflates the box',
        'screenshots are IDE windows, so the page rectangle is detected, not given',
        'the reference title block is the native Sheet-Symbol block, whose exact extent is assumed to be the bottom-right 45% x 22%',
      ],
      samples: out,
    },
    null,
    1,
  ),
)
console.log('\nwrote docs/evidence/review/fill-measure.json')
