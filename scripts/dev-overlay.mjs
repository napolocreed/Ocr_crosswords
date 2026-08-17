#!/usr/bin/env node
/**
 * Draws the detected cell boxes over the straightened photo, so a bad reading can
 * be blamed on the geometry that produced it rather than on the OCR.
 *
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *     scripts/dev-overlay.mjs fixtures/photo.jpg [--raw]
 *
 * Boxes are drawn after trimming, as the OCR pass sees them: red for a definition
 * square, blue for a fillable one, orange for the hairline inside a stacked
 * square. `--raw` skips trimming and shows what detection produced first.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import jpeg from 'jpeg-js'
import {
  toGray,
  downscaleGray,
  grayToRgba,
  adaptiveThreshold,
  warpPerspectiveRgba,
  cropRgba,
} from '../src/lib/image.ts'
import { detectGrid, refineSplits, trimUnusedEdges } from '../src/lib/gridDetect.ts'
import { detectArrows } from '../src/lib/arrowDetect.ts'
import { suggestQuad } from '../src/lib/importPipeline.ts'
import { encodePng } from './png.mjs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--')) ?? 'fixtures/fleches-niveau2-p43.jpg'
const raw = args.includes('--raw')
const out = process.env.OUT_DIR ?? 'scratch'
mkdirSync(out, { recursive: true })

const decoded = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true })
let photo = { data: decoded.data, width: decoded.width, height: decoded.height }
if (Math.max(photo.width, photo.height) > 2400) photo = grayToRgba(downscaleGray(toGray(photo), 2400))
const quad = suggestQuad(photo)
const qw = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y)
const qh = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y)
const warpAt = (dim) => {
  const s = dim / Math.max(qw, qh)
  return { img: warpPerspectiveRgba(photo, quad, Math.round(qw * s), Math.round(qh * s)), w: Math.round(qw * s) }
}
const small = warpAt(1400)
const big = warpAt(Math.min(2600, Math.max(qw, qh)))
const ratio = big.w / small.w
const sg = toGray(small.img)
const bin = adaptiveThreshold(sg, 0.05, 0.12)
const detected = detectGrid(bin, sg)
let grid = refineSplits(toGray(big.img), detected, ratio)
if (!raw) {
  const step = { right: [0, 1], down: [1, 0], rightDown: [1, 0], downRight: [0, 1] }
  const st = { right: [0, 1], rightDown: [0, 1], down: [1, 0], downRight: [1, 0] }
  const cellAt = (g, r, c) => (r < 0 || c < 0 || r >= g.rows || c >= g.cols ? undefined : g.cells[r * g.cols + c])
  const reach = new Set()
  for (const a of detectArrows(bin, grid).arrows) {
    const [sr, sc] = st[a.kind]
    const [dr, dc] = step[a.kind]
    let r = a.clue.r + sr
    let c = a.clue.c + sc
    while (cellAt(grid, r, c)?.kind === 'letter') {
      reach.add(`${r},${c}`)
      r += dr
      c += dc
    }
  }
  grid = trimUnusedEdges(grid, reach)
}

const img = { data: Uint8ClampedArray.from(big.img.data), width: big.img.width, height: big.img.height }
const put = (x, y, [r, g, b]) => {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return
  const p = (py * img.width + px) * 4
  img.data[p] = r
  img.data[p + 1] = g
  img.data[p + 2] = b
}
const hline = (x0, x1, y, c) => {
  for (let x = Math.round(x0); x <= x1; x++) put(x, y, c)
}
const vline = (y0, y1, x, c) => {
  for (let y = Math.round(y0); y <= y1; y++) put(x, y, c)
}

const RED = [230, 40, 40]
const BLUE = [40, 110, 230]
const ORANGE = [250, 150, 20]
for (const cell of grid.cells) {
  const x0 = cell.x0 * ratio
  const x1 = cell.x1 * ratio
  const y0 = cell.y0 * ratio
  const y1 = cell.y1 * ratio
  const colour = cell.kind === 'clue' ? RED : cell.kind === 'letter' ? BLUE : [120, 120, 120]
  hline(x0, x1, y0, colour)
  hline(x0, x1, y1, colour)
  vline(y0, y1, x0, colour)
  vline(y0, y1, x1, colour)
  if (cell.split !== undefined) hline(x0, x1, y0 + cell.split * (y1 - y0), ORANGE)
}

const name = `${out}/overlay${raw ? '-raw' : ''}.png`
writeFileSync(name, encodePng(img.width, img.height, img.data))
console.log(`${grid.cols} x ${grid.rows}, ${grid.cells.filter((c) => c.kind === 'clue').length} definition squares`)
console.log(`wrote ${name}`)

// Quadrant tiles too: the whole page at this size shows nothing useful.
const halves = [
  ['tl', 0, 0],
  ['tr', 0.5, 0],
  ['bl', 0, 0.5],
  ['br', 0.5, 0.5],
]
for (const [tag, fx, fy] of halves) {
  const c = cropRgba(img, fx * img.width, fy * img.height, (fx + 0.5) * img.width, (fy + 0.5) * img.height)
  writeFileSync(`${out}/overlay-${tag}.png`, encodePng(c.width, c.height, c.data))
}
