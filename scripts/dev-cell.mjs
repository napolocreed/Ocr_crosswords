#!/usr/bin/env node
/**
 * Dumps the exact crops the OCR pass reads for named clue cells, plus the cell as
 * a whole, so a bad reading can be traced to the image it came from.
 *
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *     scripts/dev-cell.mjs fixtures/fleches-niveau2-p43.jpg 0,0 4,8
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
  preprocessForOcr,
} from '../src/lib/image.ts'
import { detectGrid, refineSplits, trimUnusedEdges } from '../src/lib/gridDetect.ts'
import { detectArrows } from '../src/lib/arrowDetect.ts'
import { clueRegions, suggestQuad } from '../src/lib/importPipeline.ts'
import { encodePng } from './png.mjs'

const file = process.argv[2] ?? 'fixtures/fleches-niveau2-p43.jpg'
const want = process.argv.slice(3).filter((a) => a.includes(','))
const out = process.env.OUT_DIR ?? 'scratch/cells'
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
const smallGray = toGray(small.img)
const bin = adaptiveThreshold(smallGray, 0.05, 0.12)
const detected = detectGrid(bin, smallGray)
let grid = refineSplits(toGray(big.img), detected, ratio)
{
  const step = { right: [0, 1], down: [1, 0], rightDown: [1, 0], downRight: [0, 1] }
  const start = { right: [0, 1], rightDown: [0, 1], down: [1, 0], downRight: [1, 0] }
  const cellAt = (g, r, c) =>
    r < 0 || c < 0 || r >= g.rows || c >= g.cols ? undefined : g.cells[r * g.cols + c]
  const reach = new Set()
  for (const a of detectArrows(bin, grid).arrows) {
    const [sr, sc] = start[a.kind]
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
const bigGray = toGray(big.img)

const save = (name, img) => {
  writeFileSync(`${out}/${name}.png`, encodePng(img.width, img.height, img.data))
  return `${out}/${name}.png`
}

for (const cell of grid.cells) {
  if (cell.kind !== 'clue') continue
  const tag = `${cell.r},${cell.c}`
  if (want.length && !want.includes(tag)) continue
  const name = `${cell.r}-${cell.c}`
  const whole = cropRgba(big.img, cell.x0 * ratio, cell.y0 * ratio, cell.x1 * ratio, cell.y1 * ratio)
  save(`${name}-cell`, whole)
  const regions = clueRegions(bigGray, cell, cell.split === undefined ? 1 : 2, ratio)
  console.log(
    `${tag}  split=${cell.split === undefined ? 'none' : cell.split.toFixed(3)}  ` +
      `dark=${cell.darkRatio.toFixed(3)} frame=${cell.frameScore.toFixed(2)}  ` +
      `cell y ${(cell.y0 * ratio).toFixed(0)}..${(cell.y1 * ratio).toFixed(0)}`,
  )
  regions.forEach((region, i) => {
    console.log(
      `   region ${i}  x ${region.x0.toFixed(0)}..${region.x1.toFixed(0)}` +
        `  y ${region.y0.toFixed(0)}..${region.y1.toFixed(0)}`,
    )
    const crop = cropRgba(big.img, region.x0, region.y0, region.x1, region.y1)
    save(`${name}-r${i}`, crop)
    save(`${name}-r${i}-ocr`, preprocessForOcr(crop))
  })
}
console.log(`\nwrote to ${out}/`)
