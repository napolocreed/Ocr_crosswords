#!/usr/bin/env node
/**
 * Scores the whole import pipeline against a hand-transcribed page.
 *
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *     scripts/score.mjs fixtures/fleches-niveau2-p43.jpg
 *
 * This exists because every earlier number was a proxy. "Looks like a word" is
 * satisfied by "LEUVT EEE ÇA REMPL LE VERRI", so it reported ~80% where the real
 * figure was closer to 45%. Accuracy has to be measured against what the page
 * actually says, or every tuning decision is a guess.
 *
 * Reported metrics, all against ground truth:
 *   exact       definitions read character-for-character
 *   near        off by at most a couple of characters (a one-tap fix)
 *   missing     definitions the pipeline never produced a candidate for
 *   spurious    definitions produced that match nothing on the page
 *   structure   clue-cell and hairline counts versus the real ones
 */
import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import jpeg from 'jpeg-js'
import {
  toGray,
  downscaleGray,
  grayToRgba,
  adaptiveThreshold,
  rotateRgba,
  warpPerspectiveRgba,
  cropRgba,
  preprocessForOcr,
} from '../src/lib/image.ts'
import { detectGrid, refineSplits, trimUnusedEdges } from '../src/lib/gridDetect.ts'
import { detectArrows } from '../src/lib/arrowDetect.ts'
import { clueRegions, suggestQuad } from '../src/lib/importPipeline.ts'
import { OcrEngine } from '../src/lib/ocr.ts'
import { encodePng } from './png.mjs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--')) ?? 'fixtures/fleches-niveau2-p43.jpg'
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback
}
const truthPath = file.replace(/\.[^.]+$/, '.truth.json')
if (!existsSync(truthPath)) {
  console.error(`No ground truth beside the photo: expected ${truthPath}`)
  process.exit(2)
}
const truth = JSON.parse(readFileSync(truthPath, 'utf8'))

/** The app's own constants, mirrored so the harness measures the real pipeline. */
const MAX_PHOTO_DIM = flag('photo', 2400)
const DETECT_DIM = flag('detect', 1400)
const CROP_DIM = flag('crop', 2600)

/* ------------------------------------------------------------- the pipeline */

const decoded = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true })
let photo = { data: decoded.data, width: decoded.width, height: decoded.height }
if (truth.rotate) photo = rotateRgba(photo, truth.rotate)
if (Math.max(photo.width, photo.height) > MAX_PHOTO_DIM) {
  // Area-averaged, like the browser's own decode.
  photo = grayToRgba(downscaleGray(toGray(photo), MAX_PHOTO_DIM))
}

const quad = suggestQuad(photo)
const qw = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y)
const qh = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y)
const warpAt = (dim) => {
  const s = dim / Math.max(qw, qh)
  const w = Math.round(qw * s)
  const h = Math.round(qh * s)
  return { img: warpPerspectiveRgba(photo, quad, w, h), w, h }
}
const small = warpAt(DETECT_DIM)
const big = warpAt(Math.min(CROP_DIM, Math.max(qw, qh)))
const ratio = big.w / small.w

const smallGray = toGray(small.img)
const bin = adaptiveThreshold(smallGray, 0.05, 0.12)
const detected = detectGrid(bin, smallGray)
const grid = refineSplits(toGray(big.img), detected, ratio)
let grid2 = grid
let arrows = detectArrows(bin, grid2)
{
  const step = { right: [0, 1], down: [1, 0], rightDown: [1, 0], downRight: [0, 1] }
  const start = { right: [0, 1], rightDown: [0, 1], down: [1, 0], downRight: [1, 0] }
  const cellAt = (g, r, c) =>
    r < 0 || c < 0 || r >= g.rows || c >= g.cols ? undefined : g.cells[r * g.cols + c]
  const reach = new Set()
  for (const a of arrows.arrows) {
    const [sr, sc] = start[a.kind]
    const [dr, dc] = step[a.kind]
    let r = a.clue.r + sr
    let c = a.clue.c + sc
    while (cellAt(grid2, r, c)?.kind === 'letter') {
      reach.add(`${r},${c}`)
      r += dr
      c += dc
    }
  }
  grid2 = trimUnusedEdges(grid2, reach)
  arrows = detectArrows(bin, grid2)
}
const gridTrimmed = grid2

/* ---------------------------------------------------------------- structure */

const clueCells = gridTrimmed.cells.filter((c) => c.kind === 'clue')
const withHairline = clueCells.filter((c) => c.split !== undefined)
const letterCells = gridTrimmed.cells.filter((c) => c.kind === 'letter')
const producedCount = clueCells.length + withHairline.length

console.log(`photo      ${photo.width}x${photo.height} (capped at ${MAX_PHOTO_DIM})`)
console.log(`detect at  ${small.w}x${small.h}, crops from ${big.w}x${big.h}`)
console.log(`\n=== STRUCTURE ===`)
console.log(`grid            ${gridTrimmed.cols} x ${gridTrimmed.rows}   (truth ${truth.grid.cols} x ${truth.grid.rows})`)
console.log(`clue cells      ${clueCells.length}`)
console.log(`with hairline   ${withHairline.length}`)
console.log(`letter cells    ${letterCells.length}`)
console.log(`definitions     ${producedCount}   (truth ${truth.definitions.length})`)
const surplus = producedCount - truth.definitions.length
console.log(
  `                ${surplus === 0 ? 'exact' : surplus > 0 ? `${surplus} too many` : `${-surplus} too few`}`,
)

/* ---------------------------------------------------------------------- OCR */

const engine = new OcrEngine({
  langPath: new URL('../public/tesseract/lang', import.meta.url).pathname,
  uppercase: true,
  noLanguageCache: true,
})
await engine.init()

// Crop geometry comes from the app's own clueRegions, so what is scored here is
// what the app reads. An earlier version of this harness computed its own and
// spent a while reporting numbers for a pipeline that did not exist.
const bigGray = toGray(big.img)
const produced = []
for (const cell of clueCells) {
  const regions = clueRegions(bigGray, cell, cell.split === undefined ? 1 : 2, ratio)
  for (const region of regions) {
    const crop = cropRgba(big.img, region.x0, region.y0, region.x1, region.y1)
    const prepared = preprocessForOcr(crop)
    const { text } = await engine.recognize(
      encodePng(prepared.width, prepared.height, prepared.data),
    )
    produced.push({ r: cell.r, c: cell.c, text })
  }
}
await engine.terminate()

/* ------------------------------------------------------------------ scoring */

/** Comparison key: accents, punctuation and spacing are trivial to fix by hand. */
const norm = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')

/** Levenshtein, capped: only small distances matter here. */
function distance(a, b) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > 4) return 99
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }
  return prev[b.length]
}

const remaining = truth.definitions.map((text) => ({ text, key: norm(text) }))
const exact = []
const near = []
const spurious = []

// Exact matches first, so a near-match cannot steal a definition that some other
// reading matches perfectly.
for (const item of produced) {
  const key = norm(item.text)
  if (!key) continue
  const hit = remaining.findIndex((t) => t.key === key)
  if (hit >= 0) {
    exact.push({ ...item, truth: remaining[hit].text })
    remaining.splice(hit, 1)
    item.matched = true
  }
}
for (const item of produced) {
  if (item.matched) continue
  const key = norm(item.text)
  if (!key) continue
  let best = -1
  let bestD = 3 // at most two edits: a one-tap fix in review
  for (let i = 0; i < remaining.length; i++) {
    const d = distance(key, remaining[i].key)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  if (best >= 0) {
    near.push({ ...item, truth: remaining[best].text, edits: bestD })
    remaining.splice(best, 1)
    item.matched = true
  } else {
    spurious.push(item)
  }
}

const total = truth.definitions.length
const pct = (n) => `${((100 * n) / total).toFixed(1)}%`

console.log(`\n=== DEFINITIONS vs GROUND TRUTH (${total} on the page) ===`)
console.log(`exact           ${String(exact.length).padStart(3)}  ${pct(exact.length)}`)
console.log(`near (<=2 edits)${String(near.length).padStart(3)}  ${pct(near.length)}`)
console.log(
  `usable          ${String(exact.length + near.length).padStart(3)}  ${pct(exact.length + near.length)}`,
)
console.log(`missing         ${String(remaining.length).padStart(3)}  ${pct(remaining.length)}`)
console.log(`spurious        ${String(spurious.length).padStart(3)}  (readings matching nothing)`)

if (args.includes('--detail')) {
  console.log(`\n--- near misses ---`)
  for (const n of near) console.log(`  ${n.edits} edit(s)  "${n.text}"  <-  "${n.truth}"`)
  console.log(`\n--- missing from output ---`)
  for (const m of remaining) console.log(`  "${m.text}"`)
  console.log(`\n--- spurious readings ---`)
  for (const s of spurious.slice(0, 40)) console.log(`  ${s.r},${s.c}  "${s.text}"`)
}

console.log(`\n=== ARROWS ===`)
const kinds = {}
for (const a of arrows.arrows) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1
console.log(`read ${arrows.arrows.length}: ${JSON.stringify(kinds)}`)
const reachable = new Set()
const step = { right: [0, 1], down: [1, 0], rightDown: [1, 0], downRight: [0, 1] }
const start = { right: [0, 1], rightDown: [0, 1], down: [1, 0], downRight: [1, 0] }
const at = (r, c) =>
  r < 0 || c < 0 || r >= gridTrimmed.rows || c >= gridTrimmed.cols
    ? undefined
    : gridTrimmed.cells[r * gridTrimmed.cols + c]
for (const a of arrows.arrows) {
  const [sr, sc] = start[a.kind]
  const [dr, dc] = step[a.kind]
  let r = a.clue.r + sr
  let c = a.clue.c + sc
  while (at(r, c)?.kind === 'letter') {
    reachable.add(`${r},${c}`)
    r += dr
    c += dc
  }
}
console.log(
  `reachable squares ${reachable.size}/${letterCells.length} ` +
    `(${letterCells.length - reachable.size} orphans)`,
)

console.log(`\nscored ${basename(file)}`)
