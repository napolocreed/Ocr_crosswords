#!/usr/bin/env node
/**
 * Structural scoring without OCR, so geometry can be iterated on in seconds
 * rather than minutes.
 *
 * The headline number is the mean frame score: how much of each cell's own
 * border sits on printed rules. It is the closest thing to a ground truth for
 * geometry that needs no transcription — when the ladder is on the print every
 * cell is framed, and when it drifts the score falls before anything else does.
 * Clue-cell and hairline counts are reported beside it because a geometry change
 * that improves alignment but loses definition squares is not an improvement.
 */
import { readFileSync, existsSync } from 'node:fs'
import jpeg from 'jpeg-js'
import { toGray, downscaleGray, grayToRgba, adaptiveThreshold, warpPerspectiveRgba, rotateRgba } from '../src/lib/image.ts'
import { detectGrid, refineSplits, trimUnusedEdges } from '../src/lib/gridDetect.ts'
import { detectArrows } from '../src/lib/arrowDetect.ts'
import { suggestQuad } from '../src/lib/importPipeline.ts'

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!files.length) files.push('fixtures/fleches-niveau2-p43.jpg')

for (const file of files) {
  const truthPathEarly = file.replace(/\.[^.]+$/, '.truth.json')
  const rotate = existsSync(truthPathEarly)
    ? (JSON.parse(readFileSync(truthPathEarly, 'utf8')).rotate ?? 0)
    : 0
  const decoded = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true })
  let photo = { data: decoded.data, width: decoded.width, height: decoded.height }
  // Some fixtures are photographed sideways; the app is told which way up by the
  // user, so the harness has to be told too or it measures a different problem.
  if (rotate) photo = rotateRgba(photo, rotate)
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

  if (process.argv.includes('--map')) {
    // Before trimming, with the frame score per line: this is what decides which
    // border rows are grid and which are margin, so it is what to look at when a
    // grid comes out smaller than the page.
    const line = (kind, i) => {
      const n = kind === 'row' ? detected.cols : detected.rows
      const cells = Array.from({ length: n }, (_, k) =>
        kind === 'row' ? detected.cells[i * detected.cols + k] : detected.cells[k * detected.cols + i],
      )
      const frame = cells.reduce((a, c) => a + c.frameScore, 0) / cells.length
      const map = cells.map((c) => (c.kind === 'clue' ? 'C' : c.kind === 'block' ? '#' : '.')).join('')
      return `${frame.toFixed(3)}  ${map}`
    }
    const all = detected.cells.map((c) => c.frameScore).sort((a, b) => a - b)
    console.log(`  raw ${detected.cols} x ${detected.rows}, median frame ${all[all.length >> 1].toFixed(3)}`)
    for (let r = 0; r < detected.rows; r++) console.log(`   row ${String(r).padStart(2)}  ${line('row', r)}`)
    for (let c = 0; c < detected.cols; c++) console.log(`   col ${String(c).padStart(2)}  ${line('col', c)}`)
  }

  const clue = grid.cells.filter((c) => c.kind === 'clue')
  const split = clue.filter((c) => c.split !== undefined)
  const letters = grid.cells.filter((c) => c.kind === 'letter')
  const frames = grid.cells.map((c) => c.frameScore)
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length
  const weak = frames.filter((f) => f < 0.75).length

  const truthPath = file.replace(/\.[^.]+$/, '.truth.json')
  const truth = existsSync(truthPath) ? JSON.parse(readFileSync(truthPath, 'utf8')) : null
  const vs = (got, want) => (want === undefined ? '' : `  (truth ${want}${got === want ? ' ✓' : ''})`)

  console.log(
    `${file.split('/').pop()}\n` +
      `  grid          ${grid.cols} x ${grid.rows}${truth ? vs(`${grid.cols} x ${grid.rows}`, `${truth.grid.cols} x ${truth.grid.rows}`) : ''}\n` +
      `  frame mean    ${mean.toFixed(4)}   ${weak} cells under 0.75\n` +
      `  clue cells    ${clue.length}\n` +
      `  hairlines     ${split.length}\n` +
      `  letter cells  ${letters.length}${truth ? vs(letters.length, truth.letterCells) : ''}\n` +
      `  definitions   ${clue.length + split.length}${truth ? vs(clue.length + split.length, truth.definitions.length) : ''}`,
  )
}
