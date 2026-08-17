#!/usr/bin/env node --experimental-strip-types
/**
 * Measures real OCR quality on the definition cells of a real photo, so the
 * preprocessing can be tuned without a browser or a phone in the loop.
 *
 *   node --experimental-strip-types scripts/dev-ocr.mjs fixtures/photo.jpg --rotate 1 --limit 20
 *
 * Also dumps each preprocessed crop to .debug/crops/ for inspection.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import jpeg from 'jpeg-js'
import { encodePng } from './png.mjs'
import {
  toGray,
  downscaleGray,
  adaptiveThreshold,
  rotateRgba,
  guessGridQuad,
  warpPerspectiveRgba,
  cropRgba,
  preprocessForOcr,
} from '../src/lib/image.ts'
import { detectGrid } from '../src/lib/gridDetect.ts'
import { OcrEngine, scoreClueText } from '../src/lib/ocr.ts'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--')) ?? 'fixtures/sport-cerebral-42.jpg'
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback
}
const rotate = flag('rotate', 1)
const detectDim = flag('detect', 1400)
const cropDim = flag('crop', 2400)
const limit = flag('limit', 24)
const minRow = flag('minrow', 0)
const minCol = flag('mincol', 0)

mkdirSync('.debug/crops', { recursive: true })
const stem = basename(file).replace(/\.[^.]+$/, '')

const decoded = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true })
let rgba = { data: decoded.data, width: decoded.width, height: decoded.height }
if (rotate) rgba = rotateRgba(rgba, rotate)

const smallBin = adaptiveThreshold(downscaleGray(toGray(rgba), 900), 0.06, 0.12)
const scaleToFull = rgba.width / smallBin.width
const quad = guessGridQuad(smallBin).map((p) => ({ x: p.x * scaleToFull, y: p.y * scaleToFull }))

const quadW = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y)
const quadH = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y)

// Two straightened copies: a small one to detect on, a big one to crop from.
const warpAt = (dim) => {
  const s = dim / Math.max(quadW, quadH)
  const w = Math.round(quadW * s)
  const h = Math.round(quadH * s)
  return { img: warpPerspectiveRgba(rgba, quad, w, h), w, h }
}

const small = warpAt(detectDim)
const big = warpAt(cropDim)
const ratio = big.w / small.w
console.log(`detect at ${small.w}x${small.h}, crop from ${big.w}x${big.h} (x${ratio.toFixed(2)})`)

const bin = adaptiveThreshold(toGray(small.img), 0.05, 0.12)
const result = detectGrid(bin)
console.log(`grid: ${result.cols} x ${result.rows}, pitch ${result.pitchX.toFixed(0)}px`)

const clues = result.cells.filter((c) => c.kind === 'clue' && c.r >= minRow && c.c >= minCol)
console.log(`${clues.length} definition cells; OCR on the first ${Math.min(limit, clues.length)}\n`)

const engine = new OcrEngine({
  langPath: new URL('../public/tesseract/lang', import.meta.url).pathname,
  uppercase: true,
})
const t0 = Date.now()
await engine.init()
console.log(`worker ready in ${Date.now() - t0}ms\n`)

let totalMs = 0
let done = 0
const results = []
for (const cell of clues.slice(0, limit)) {
  // Inset slightly so the printed frame and arrowheads stay out of the crop.
  const padX = (cell.x1 - cell.x0) * 0.06
  const padY = (cell.y1 - cell.y0) * 0.06
  const regions = []
  if (cell.split !== undefined) {
    const splitY = cell.y0 + cell.split * (cell.y1 - cell.y0)
    regions.push(['a', cell.y0 + padY, splitY - padY])
    regions.push(['b', splitY + padY, cell.y1 - padY])
  } else {
    regions.push(['', cell.y0 + padY, cell.y1 - padY])
  }

  for (const [suffix, y0, y1] of regions) {
    const crop = cropRgba(big.img, (cell.x0 + padX) * ratio, y0 * ratio, (cell.x1 - padX) * ratio, y1 * ratio)
    const prepped = preprocessForOcr(crop)
    const name = `${stem}-r${String(cell.r).padStart(2, '0')}c${String(cell.c).padStart(2, '0')}${suffix}`
    writeFileSync(join('.debug/crops', `${name}.png`), encodePng(prepped.width, prepped.height, prepped.data))

    const t = Date.now()
    const { text, confidence } = await engine.recognize(
      encodePng(prepped.width, prepped.height, prepped.data),
    )
    const ms = Date.now() - t
    totalMs += ms
    done++
    if (text) results.push(text)
    const score = scoreClueText(text, confidence)
    console.log(
      `${String(cell.r).padStart(2)},${String(cell.c).padStart(2)}${suffix.padEnd(1)} ` +
        `[${(confidence * 100).toFixed(0)}%/${(score * 100).toFixed(0)}%] ${ms}ms  "${text}"`,
    )
  }
}
await engine.terminate()
const wordy = results.filter(
  (t) => /^[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ' -]{4,}$/.test(t) && /[AEIOUY]/.test(t),
)
console.log(`\n${done} regions, avg ${(totalMs / Math.max(1, done)).toFixed(0)}ms each`)
console.log(`word-like: ${wordy.length}/${done} (${((100 * wordy.length) / Math.max(1, done)).toFixed(0)}%)`)
console.log(`crops in .debug/crops/`)
