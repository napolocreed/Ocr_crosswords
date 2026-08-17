#!/usr/bin/env node --experimental-strip-types
/**
 * Offline harness to calibrate grid detection against real magazine photos,
 * without a browser in the loop.
 *
 *   node --experimental-strip-types scripts/dev-detect.mjs fixtures/photo.jpg --rotate 3
 *
 * Writes debug PNGs to .debug/ and prints a map of the detected grid so the
 * classification can be eyeballed against the original.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import jpeg from 'jpeg-js'
import { encodePng } from './png.mjs'
import {
  toGray,
  downscaleGray,
  adaptiveThreshold,
  binaryToRgba,
  rotateRgba,
  warpPerspectiveRgba,
} from '../src/lib/image.ts'
import { detectGrid, sampleCurve as sampleCurveLib } from '../src/lib/gridDetect.ts'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--')) ?? 'fixtures/sport-cerebral-42.jpg'
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback
}
const rotate = flag('rotate', 0)
const workDim = flag('work', 1500)

mkdirSync('.debug', { recursive: true })
const stem = basename(file).replace(/\.[^.]+$/, '')
const out = (name, img) =>
  writeFileSync(join('.debug', `${stem}-${name}.png`), encodePng(img.width, img.height, img.data))

const t0 = Date.now()
const decoded = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true })
let rgba = { data: decoded.data, width: decoded.width, height: decoded.height }
console.log(`decoded ${rgba.width}x${rgba.height} in ${Date.now() - t0}ms`)

if (rotate) {
  rgba = rotateRgba(rgba, rotate)
  console.log(`rotated ${rotate} quarter turn(s) -> ${rgba.width}x${rgba.height}`)
}

// --- Pass 1: find the grid on a small copy, to seed the crop quad ---------
const smallGray = downscaleGray(toGray(rgba), 900)
const smallBin = adaptiveThreshold(smallGray, 0.06, 0.12)
out('01-binary-small', binaryToRgba(smallBin))
// Deliberately loose crop: the whole (rotated) frame. Detection is expected to
// find the grid inside it on its own.
const quad = [
  { x: 0, y: 0 },
  { x: rgba.width, y: 0 },
  { x: rgba.width, y: rgba.height },
  { x: 0, y: rgba.height },
]
void smallBin

// --- Pass 2: straighten, then detect on the straightened image ------------
const quadW = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y)
const quadH = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y)
const scale = workDim / Math.max(quadW, quadH)
const outW = Math.round(quadW * scale)
const outH = Math.round(quadH * scale)
const warped = warpPerspectiveRgba(rgba, quad, outW, outH)
out('02-warped', warped)

const gray = toGray(warped)
const bin = adaptiveThreshold(gray, 0.05, 0.12)
out('03-binary', binaryToRgba(bin))

const t1 = Date.now()
const result = detectGrid(bin)
console.log(`\ndetected ${result.cols} cols x ${result.rows} rows in ${Date.now() - t1}ms`)
console.log('warnings:', result.warnings.length ? result.warnings : 'none')

console.log(`pitch: x=${result.pitchX.toFixed(1)}px y=${result.pitchY.toFixed(1)}px`)
console.log(`tilt: rows=${result.tiltRowsDeg.toFixed(2)}deg cols=${result.tiltColsDeg.toFixed(2)}deg`)
console.log(`warped size: ${outW}x${outH}`)

// Map: '.' letter, '#' block, letters/digits show clue cells and their arrows.
console.log('\ngrid map (. letter, D definition, B block; 2 = two definitions):')
for (let r = 0; r < result.rows; r++) {
  let line = ''
  for (let c = 0; c < result.cols; c++) {
    const cell = result.cells[r * result.cols + c]
    if (cell.kind === 'letter') line += ' .'
    else if (cell.kind === 'block') line += ' #'
    else line += cell.split !== undefined ? ' 2' : ' D'
  }
  console.log(String(r).padStart(2) + ' ' + line)
}

console.log('\narrow scores for definition cells (r,c right/down):')
const clues = result.cells.filter((cell) => cell.kind === 'clue')
for (const cell of clues.slice(0, 40)) {
  console.log(
    `  ${String(cell.r).padStart(2)},${String(cell.c).padStart(2)}  ` +
      `ink=${cell.inkRatio.toFixed(3)} right=${cell.arrowRight.toFixed(2)} down=${cell.arrowDown.toFixed(2)}` +
      (cell.split !== undefined ? '  [split]' : ''),
  )
}
console.log(`  ... ${clues.length} definition cells total`)

// Ink-ratio histogram: shows whether the letter/definition threshold is safe.
const buckets = new Array(20).fill(0)
for (const cell of result.cells) buckets[Math.min(19, Math.floor(cell.inkRatio * 100))]++
console.log('\nink ratio histogram (per 1%, 0-19%):')
console.log(buckets.map((n, i) => `${i}%:${n}`).join('  '))

// Overlay the detected boundaries and classification onto the warped photo.
const overlay = new Uint8ClampedArray(warped.data)
const paint = (x, y, [r, g, b]) => {
  if (x < 0 || y < 0 || x >= outW || y >= outH) return
  const i = (y * outW + x) * 4
  overlay[i] = r
  overlay[i + 1] = g
  overlay[i + 2] = b
}
const sampleCurve = sampleCurveLib
for (const curve of result.ys)
  for (let x = 0; x < outW; x++) paint(x, Math.round(sampleCurve(curve, x, outW)), [255, 0, 0])
for (const curve of result.xs)
  for (let y = 0; y < outH; y++) paint(Math.round(sampleCurve(curve, y, outH)), y, [255, 0, 0])
for (const cell of result.cells) {
  if (cell.kind === 'letter') continue
  const colour = cell.kind === 'block' ? [0, 0, 255] : [0, 190, 90]
  for (let y = Math.round(cell.y0) + 2; y < Math.round(cell.y1) - 2; y += 3) {
    for (let x = Math.round(cell.x0) + 2; x < Math.round(cell.x1) - 2; x += 3) paint(x, y, colour)
  }
  if (cell.split !== undefined) {
    const sy = Math.round(cell.y0 + cell.split * (cell.y1 - cell.y0))
    for (let x = Math.round(cell.x0); x < Math.round(cell.x1); x++) paint(x, sy, [255, 140, 0])
  }
  if (cell.arrowRight > 0.5) {
    const my = Math.round((cell.y0 + cell.y1) / 2)
    for (let d = -4; d <= 4; d++) paint(Math.round(cell.x1) + d, my, [255, 0, 255])
  }
  if (cell.arrowDown > 0.5) {
    const mx = Math.round((cell.x0 + cell.x1) / 2)
    for (let d = -4; d <= 4; d++) paint(mx, Math.round(cell.y1) + d, [255, 0, 255])
  }
}
out('06-overlay', { data: overlay, width: outW, height: outH })

// Zoomed crop of the overlay, to judge boundary alignment at pixel level.
const zoomArg = args.indexOf('--zoom')
if (zoomArg >= 0 && args[zoomArg + 1]) {
  const [zx, zy, zw, zh] = args[zoomArg + 1].split(',').map(Number)
  const factor = 3
  const zoomed = new Uint8ClampedArray(zw * factor * zh * factor * 4)
  for (let y = 0; y < zh * factor; y++) {
    for (let x = 0; x < zw * factor; x++) {
      const sx = zx + Math.floor(x / factor)
      const sy = zy + Math.floor(y / factor)
      const src = (sy * outW + sx) * 4
      const dst = (y * zw * factor + x) * 4
      for (let ch = 0; ch < 4; ch++) zoomed[dst + ch] = overlay[src + ch]
    }
  }
  out('07-zoom', { data: zoomed, width: zw * factor, height: zh * factor })
  console.log(`zoom written: ${zw * factor}x${zh * factor}`)
}

// Boundary alignment metric: does each detected curve actually sit on a rule?
const alignment = (curves, mask, axis) => {
  const scores = curves.map((curve) => {
    const extent = axis === 'rows' ? outW : outH
    let hits = 0
    for (let o = 0; o < extent; o++) {
      const pos = Math.round(sampleCurve(curve, o, extent))
      let found = false
      for (let d = -2; d <= 2 && !found; d++) {
        const i = pos + d
        if (i < 0 || i >= (axis === 'rows' ? outH : outW)) continue
        const idx = axis === 'rows' ? i * outW + o : o * outW + i
        if (mask.data[idx]) found = true
      }
      if (found) hits++
    }
    return hits / extent
  })
  return scores
}
const alignY = alignment(result.ys, bin, 'rows')
const alignX = alignment(result.xs, bin, 'cols')
const fmt = (a) => a.map((v) => v.toFixed(2)).join(' ')
console.log('\nhorizontal boundary alignment (fraction sitting on a printed rule):')
console.log('  ' + fmt(alignY))
console.log('vertical boundary alignment:')
console.log('  ' + fmt(alignX))
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length
console.log(`mean alignment: rows=${mean(alignY).toFixed(3)} cols=${mean(alignX).toFixed(3)}`)
console.log(`\ndebug images in .debug/${stem}-*.png`)
