#!/usr/bin/env node
/**
 * Montage of the squares that carry arrow glyphs, cropped from the high-res
 * straightened image, so the shapes can be studied before writing a classifier.
 *
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *     scripts/dev-arrows.mjs fixtures/photo.jpg --rotate 1
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import jpeg from 'jpeg-js'
import { encodePng } from './png.mjs'
import {
  toGray,
  adaptiveThreshold,
  rotateRgba,
  warpPerspectiveRgba,
} from '../src/lib/image.ts'
import { detectGrid } from '../src/lib/gridDetect.ts'
import { detectArrows, groupArrowsByClue, measureGlyphs } from '../src/lib/arrowDetect.ts'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--')) ?? 'fixtures/sport-cerebral-42.jpg'
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback
}
const rotate = flag('rotate', 1)
const detectDim = flag('detect', 1400)
const cropDim = flag('crop', 2600)

mkdirSync('.debug', { recursive: true })
const stem = basename(file).replace(/\.[^.]+$/, '')

const decoded = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true })
let rgba = { data: decoded.data, width: decoded.width, height: decoded.height }
if (rotate) rgba = rotateRgba(rgba, rotate)

const full = [
  { x: 0, y: 0 },
  { x: rgba.width, y: 0 },
  { x: rgba.width, y: rgba.height },
  { x: 0, y: rgba.height },
]
const warpAt = (dim) => {
  const s = dim / Math.max(rgba.width, rgba.height)
  const w = Math.round(rgba.width * s)
  const h = Math.round(rgba.height * s)
  return { img: warpPerspectiveRgba(rgba, full, w, h), w, h }
}
const small = warpAt(detectDim)
const big = warpAt(cropDim)
const ratio = big.w / small.w

const bin = adaptiveThreshold(toGray(small.img), 0.05, 0.12)
const result = detectGrid(bin)
console.log(`grid ${result.cols} x ${result.rows}, crop source ${big.w}x${big.h}`)

const at = (r, c) =>
  r < 0 || c < 0 || r >= result.rows || c >= result.cols
    ? undefined
    : result.cells[r * result.cols + c]

// Every fillable square that sits right after a definition square: those are
// exactly the squares an arrow glyph is drawn in.
const targets = []
for (const cell of result.cells) {
  if (cell.kind !== 'letter') continue
  const left = at(cell.r, cell.c - 1)
  const above = at(cell.r - 1, cell.c)
  if (left?.kind === 'clue' || above?.kind === 'clue') {
    targets.push({ cell, from: left?.kind === 'clue' ? 'left' : 'top' })
  }
}
console.log(`${targets.length} squares adjacent to a definition`)

const detected = detectArrows(bin, result)
const byStart = new Map()
for (const a of detected.arrows) byStart.set(`${a.start.r},${a.start.c}`, a)

const counts = {}
for (const a of detected.arrows) counts[a.kind] = (counts[a.kind] ?? 0) + 1
console.log(`\narrows read: ${detected.arrows.length}`)
console.log(
  Object.entries(counts)
    .sort()
    .map(([k, n]) => `  ${k}: ${n}`)
    .join('\n'),
)
const bent = (counts.downRight ?? 0) + (counts.rightDown ?? 0)
console.log(`bent: ${bent} of ${detected.arrows.length}`)
console.log(`mystery-word indices found: ${detected.marks.length}`)
if (detected.marks.length) {
  console.log('  ' + detected.marks.map((m) => `${m.r},${m.c}`).join('  '))
}
const low = detected.arrows.filter((a) => a.confidence < 0.6).length
console.log(`low-confidence readings (<0.60): ${low}`)

// Consistency: with correct arrows, every fillable square should be reachable
// from some definition. Orphans are the objective error signal.
const byClue = groupArrowsByClue(detected.arrows)
const reachable = new Set()
const dirOf = { right: [0, 1], down: [1, 0], rightDown: [1, 0], downRight: [0, 1] }
const startOf = { right: [0, 1], rightDown: [0, 1], down: [1, 0], downRight: [1, 0] }
for (const list of byClue.values()) {
  for (const a of list) {
    const [sr, sc] = startOf[a.kind]
    const [dr, dc] = dirOf[a.kind]
    let r = a.clue.r + sr
    let c = a.clue.c + sc
    while (at(r, c)?.kind === 'letter') {
      reachable.add(`${r},${c}`)
      r += dr
      c += dc
    }
  }
}
let letters = 0
for (const cell of result.cells) if (cell.kind === 'letter') letters++
const orphans = []
for (const cell of result.cells) {
  if (cell.kind !== 'letter') continue
  if (!reachable.has(`${cell.r},${cell.c}`)) orphans.push(`${cell.r},${cell.c}`)
}
console.log(
  `reachable squares: ${reachable.size}/${letters} (${orphans.length} orphan${orphans.length === 1 ? '' : 's'})`,
)

if (args.includes('--dump')) {
  const rows = measureGlyphs(bin, result)
  console.log('\nr,c   clue  spanX spanY  ink fill  edges  BL/TR      decided')
  for (const m of rows) {
    console.log(
      `${String(m.r).padStart(2)},${String(m.c).padStart(2)}  ` +
        `${m.clueLeft ? 'L' : '-'}${m.clueAbove ? 'T' : '-'}    ` +
        `${m.spanX.toFixed(2)}  ${m.spanY.toFixed(2)} ` +
        `${String(m.ink).padStart(4)} ${m.fill.toFixed(2)}  ` +
        `${m.touchesLeft ? 'l' : '-'}${m.touchesTop ? 't' : '-'}     ` +
        `${String(m.bottomLeft).padStart(3)}/${String(m.topRight).padEnd(3)}  ` +
        `${m.decided}${m.confidence ? ' ' + m.confidence.toFixed(2) : ''}`,
    )
  }
}

const CELL = flag('size', 160)
const perRow = flag('cols', 8)
const rows = Math.ceil(targets.length / perRow)
const mw = perRow * CELL
const mh = rows * CELL
const montage = new Uint8ClampedArray(mw * mh * 4).fill(40)

const paint = (x, y, [r, g, b]) => {
  if (x < 0 || y < 0 || x >= mw || y >= mh) return
  const i = (y * mw + x) * 4
  montage[i] = r
  montage[i + 1] = g
  montage[i + 2] = b
  montage[i + 3] = 255
}

targets.forEach((t, i) => {
  const gx = (i % perRow) * CELL
  const gy = Math.floor(i / perRow) * CELL
  const { cell } = t
  // A little context beyond the cell, so a glyph straddling the border shows.
  const pad = 0.16
  const x0 = (cell.x0 - (cell.x1 - cell.x0) * pad) * ratio
  const y0 = (cell.y0 - (cell.y1 - cell.y0) * pad) * ratio
  const x1 = (cell.x1 + (cell.x1 - cell.x0) * pad) * ratio
  const y1 = (cell.y1 + (cell.y1 - cell.y0) * pad) * ratio
  const cw = x1 - x0
  const ch = y1 - y0
  for (let y = 0; y < CELL - 2; y++) {
    for (let x = 0; x < CELL - 2; x++) {
      const sx = Math.round(x0 + (x / (CELL - 2)) * cw)
      const sy = Math.round(y0 + (y / (CELL - 2)) * ch)
      if (sx < 0 || sy < 0 || sx >= big.w || sy >= big.h) continue
      const src = (sy * big.w + sx) * 4
      const dst = ((gy + y) * mw + gx + x) * 4
      for (let k = 0; k < 3; k++) montage[dst + k] = big.img.data[src + k]
      montage[dst + 3] = 255
    }
  }
  // Trace where the detected cell actually is inside the padded crop, and mark
  // which edge the glyph is expected to enter from.
  const inset = Math.round(((CELL - 2) * pad) / (1 + 2 * pad))
  const lo = inset
  const hi = CELL - 2 - inset
  for (let k = lo; k <= hi; k++) {
    paint(gx + k, gy + lo, [70, 170, 255])
    paint(gx + k, gy + hi, [70, 170, 255])
    paint(gx + lo, gy + k, [70, 170, 255])
    paint(gx + hi, gy + k, [70, 170, 255])
  }
  const mark = t.from === 'left' ? [255, 90, 200] : [255, 190, 40]
  for (let k = 0; k < 8; k++) {
    if (t.from === 'left') paint(gx + lo, gy + (lo + hi) / 2 - 4 + k, mark)
    else paint(gx + (lo + hi) / 2 - 4 + k, gy + lo, mark)
  }

  // Overlay the reading: a bar per kind, in the corner. Bent kinds get an
  // L-shaped mark so a wrong bend is obvious at a glance.
  const read = byStart.get(`${cell.r},${cell.c}`)
  if (read) {
    const bentKind = read.kind === 'downRight' || read.kind === 'rightDown'
    const colour = bentKind ? [255, 60, 60] : [40, 220, 120]
    const bx = gx + CELL - 30
    const by = gy + CELL - 30
    const horizontal = read.kind === 'right' || read.kind === 'downRight'
    for (let k = 0; k < 20; k++) {
      if (horizontal) paint(bx + k, by + 18, colour)
      else paint(bx + 10, by + k, colour)
    }
    if (bentKind) {
      for (let k = 0; k < 10; k++) {
        if (read.kind === 'downRight') paint(bx, by + 18 - k, colour)
        else paint(bx + 10 + k, by, colour)
      }
    }
    if (read.confidence < 0.6) {
      for (let k = 0; k < 6; k++) paint(gx + CELL - 8 - k, gy + 6, [255, 200, 0])
    }
  }
})

writeFileSync(
  join('.debug', `${stem}-arrows.png`),
  encodePng(mw, mh, montage),
)
console.log(`montage: .debug/${stem}-arrows.png (${mw}x${mh}, ${perRow} per row)`)
console.log(`entry edges: left=${targets.filter((t) => t.from === 'left').length} top=${targets.filter((t) => t.from === 'top').length}`)
