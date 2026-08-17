import type { BinaryImage } from './image'
import type { CellKind } from '../types'
import { detectBoundaries, sampleCurve, BANDS } from './gridGeometry'

/**
 * Turns a straightened photo into a grid of classified cells.
 *
 * Geometry comes from {@link detectBoundaries}, which returns each rule as a
 * curve following the page's bow. This module then only has to decide, for each
 * cell, whether it is empty, holds definitions, or is a dead square — and where
 * its arrows point.
 */

export interface DetectedCell {
  r: number
  c: number
  /** Bounds in the straightened image, following the page's curvature. */
  x0: number
  y0: number
  x1: number
  y1: number
  kind: CellKind
  /** Fraction of dark pixels in the cell's interior. */
  inkRatio: number
  /** 0–1 evidence of an arrow leaving towards the right / downward neighbour. */
  arrowRight: number
  arrowDown: number
  /** Relative height (0–1) of an internal hairline: two definitions stacked. */
  split?: number
}

export interface DetectionResult {
  rows: number
  cols: number
  /** Boundary curves; `ys[i][b]` is horizontal boundary i at band b. */
  ys: number[][]
  xs: number[][]
  cells: DetectedCell[]
  pitchX: number
  pitchY: number
  /** Tilt actually measured, in degrees — surfaced so the UI can explain. */
  tiltRowsDeg: number
  tiltColsDeg: number
  warnings: string[]
}

export interface DetectOptions {
  /** Ink ratio above which a cell counts as holding a definition. */
  clueInkThreshold?: number
  /** Ink ratio above which a cell is a solid dead square. */
  blockInkThreshold?: number
}

export function detectGrid(bin: BinaryImage, opts: DetectOptions = {}): DetectionResult {
  const { width: w, height: h } = bin
  const warnings: string[] = []

  const horizontal = detectBoundaries(bin, 'rows')
  const vertical = detectBoundaries(bin, 'cols')

  const empty: DetectionResult = {
    rows: 0,
    cols: 0,
    ys: [],
    xs: [],
    cells: [],
    pitchX: vertical.pitch,
    pitchY: horizontal.pitch,
    tiltRowsDeg: (horizontal.tilt * 180) / Math.PI,
    tiltColsDeg: (vertical.tilt * 180) / Math.PI,
    warnings,
  }

  if (horizontal.curves.length < 3 || vertical.curves.length < 3) {
    warnings.push(
      'Grille non reconnue. Recadre au plus près du contour de la grille, et évite les ombres marquées.',
    )
    return empty
  }

  const ys = horizontal.curves
  const xs = vertical.curves
  const rows = ys.length - 1
  const cols = xs.length - 1

  const missingY = ys.length - horizontal.hits
  const missingX = xs.length - vertical.hits
  if (missingY > 0) warnings.push(`${missingY} ligne(s) horizontale(s) reconstituée(s)`)
  if (missingX > 0) warnings.push(`${missingX} ligne(s) verticale(s) reconstituée(s)`)

  const clueInk = opts.clueInkThreshold ?? 0.035
  const blockInk = opts.blockInkThreshold ?? 0.55

  const cells: DetectedCell[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Each boundary is sampled where this particular cell sits, so cells near
      // the edges of a bowed page stay aligned with the print.
      const yApprox = (sampleCurve(ys[r]!, w / 2, w) + sampleCurve(ys[r + 1]!, w / 2, w)) / 2
      const xApprox = (sampleCurve(xs[c]!, h / 2, h) + sampleCurve(xs[c + 1]!, h / 2, h)) / 2
      const x0 = sampleCurve(xs[c]!, yApprox, h)
      const x1 = sampleCurve(xs[c + 1]!, yApprox, h)
      const y0 = sampleCurve(ys[r]!, xApprox, w)
      const y1 = sampleCurve(ys[r + 1]!, xApprox, w)

      const inkRatio = interiorInkRatio(bin, x0, y0, x1, y1)
      let kind: CellKind = 'letter'
      if (inkRatio >= blockInk) kind = 'block'
      else if (inkRatio >= clueInk) kind = 'clue'

      const cell: DetectedCell = {
        r,
        c,
        x0,
        y0,
        x1,
        y1,
        kind,
        inkRatio,
        arrowRight: arrowScore(bin, x1, (y0 + y1) / 2, (x1 - x0) * 0.3, 'right'),
        arrowDown: arrowScore(bin, (x0 + x1) / 2, y1, (y1 - y0) * 0.3, 'down'),
      }
      if (kind === 'clue') {
        const split = findInternalSeparator(bin, x0, y0, x1, y1)
        if (split !== null) cell.split = split
      }
      cells.push(cell)
    }
  }

  return {
    rows,
    cols,
    ys,
    xs,
    cells,
    pitchX: vertical.pitch,
    pitchY: horizontal.pitch,
    tiltRowsDeg: (horizontal.tilt * 180) / Math.PI,
    tiltColsDeg: (vertical.tilt * 180) / Math.PI,
    warnings,
  }
}

/** Ink ratio over the cell's interior, inset to exclude the printed borders. */
function interiorInkRatio(
  bin: BinaryImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const insetX = Math.max(1, (x1 - x0) * 0.15)
  const insetY = Math.max(1, (y1 - y0) * 0.15)
  const ax = Math.max(0, Math.round(x0 + insetX))
  const bx = Math.min(bin.width, Math.round(x1 - insetX))
  const ay = Math.max(0, Math.round(y0 + insetY))
  const by = Math.min(bin.height, Math.round(y1 - insetY))
  if (bx <= ax || by <= ay) return 0
  let ink = 0
  let total = 0
  for (let y = ay; y < by; y++) {
    const row = y * bin.width
    for (let x = ax; x < bx; x++) {
      if (bin.data[row + x]) ink++
      total++
    }
  }
  return total === 0 ? 0 : ink / total
}

/**
 * Arrowheads sit against a cell border, biting into the square the answer
 * starts in. The probe is a short box straddling the border, offset towards the
 * neighbour; the rule itself is subtracted by comparing the box's ink against
 * the ink of the bare border away from the arrow position.
 */
function arrowScore(
  bin: BinaryImage,
  bx: number,
  by: number,
  reach: number,
  dir: 'right' | 'down',
): number {
  const measure = (centreAcross: number) => {
    const behind = Math.max(2, Math.round(reach * 0.35))
    const ahead = Math.max(3, Math.round(reach * 1.0))
    const across = Math.max(3, Math.round(reach * 0.55))
    const x0 = Math.round(dir === 'right' ? bx - behind : centreAcross - across)
    const x1 = Math.round(dir === 'right' ? bx + ahead : centreAcross + across)
    const y0 = Math.round(dir === 'right' ? centreAcross - across : by - behind)
    const y1 = Math.round(dir === 'right' ? centreAcross + across : by + ahead)
    let ink = 0
    let total = 0
    for (let y = Math.max(0, y0); y < Math.min(bin.height, y1); y++) {
      const row = y * bin.width
      for (let x = Math.max(0, x0); x < Math.min(bin.width, x1); x++) {
        if (bin.data[row + x]) ink++
        total++
      }
    }
    return total === 0 ? 0 : ink / total
  }

  const centre = dir === 'right' ? by : bx
  // The rule crosses both probes equally, so the difference isolates the head.
  const atArrow = measure(centre)
  const offArrow = Math.min(measure(centre - reach * 1.8), measure(centre + reach * 1.8))
  return Math.min(1, Math.max(0, (atArrow - offArrow) / 0.12))
}

/**
 * Finds the hairline splitting a clue cell that holds two definitions.
 *
 * Works on the raw binary rather than a line mask, because at the scale of a
 * single cell the page's tilt is only a pixel or two — so a simple row profile
 * across the cell's own width is both sufficient and tilt-proof.
 *
 * @returns the hairline's height as a 0–1 fraction of the cell, or null
 */
function findInternalSeparator(
  bin: BinaryImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number | null {
  const ax = Math.max(0, Math.round(x0 + (x1 - x0) * 0.18))
  const bx = Math.min(bin.width, Math.round(x1 - (x1 - x0) * 0.18))
  const width = bx - ax
  if (width <= 4) return null
  // Stay clear of the cell's own top and bottom rules.
  const margin = (y1 - y0) * 0.25
  const top = Math.max(0, Math.round(y0 + margin))
  const bottom = Math.min(bin.height, Math.round(y1 - margin))

  let best = -1
  let bestScore = 0
  for (let y = top; y < bottom; y++) {
    const row = y * bin.width
    let hits = 0
    for (let x = ax; x < bx; x++) if (bin.data[row + x]) hits++
    const score = hits / width
    if (score > bestScore) {
      bestScore = score
      best = y
    }
  }
  if (bestScore < 0.7 || best < 0) return null
  return (best - y0) / (y1 - y0)
}

export { BANDS, sampleCurve }

/**
 * Tells whether the definitions' text runs across the image or down it.
 *
 * This matters because nothing else in the pipeline notices a sideways photo:
 * the grid is square-ish so detection succeeds either way, and Tesseract happily
 * returns confident-looking nonsense for rotated type. Magazines are portrait
 * and phones are held landscape, so the sideways case is the common one.
 *
 * Lines of text alternate ink and gaps *across* the reading direction, so the
 * profile perpendicular to the text varies far more than the parallel one.
 * Comparing those two variances over every definition square is enough, and
 * costs nothing next to an OCR probe.
 *
 * @returns 1 when text reads normally, -1 when the photo needs a quarter turn;
 *   values near 0 mean there was not enough text to tell.
 */
export function textOrientationScore(bin: BinaryImage, cells: DetectedCell[]): number {
  let horizontal = 0
  let vertical = 0

  for (const cell of cells) {
    if (cell.kind !== 'clue') continue
    const ax = Math.max(0, Math.round(cell.x0 + (cell.x1 - cell.x0) * 0.16))
    const bx = Math.min(bin.width, Math.round(cell.x1 - (cell.x1 - cell.x0) * 0.16))
    const ay = Math.max(0, Math.round(cell.y0 + (cell.y1 - cell.y0) * 0.16))
    const by = Math.min(bin.height, Math.round(cell.y1 - (cell.y1 - cell.y0) * 0.16))
    const w = bx - ax
    const h = by - ay
    if (w < 6 || h < 6) continue

    const rows = new Float64Array(h)
    const cols = new Float64Array(w)
    for (let y = 0; y < h; y++) {
      const row = (ay + y) * bin.width
      for (let x = 0; x < w; x++) {
        if (bin.data[row + ax + x]) {
          rows[y]! += 1
          cols[x]! += 1
        }
      }
    }
    horizontal += normalisedVariance(rows, w)
    vertical += normalisedVariance(cols, h)
  }

  const total = horizontal + vertical
  if (total < 1e-6) return 0
  return (horizontal - vertical) / total
}

/** Variance of a profile, scaled by its length so cells compare fairly. */
function normalisedVariance(profile: Float64Array, extent: number): number {
  const n = profile.length
  if (n === 0 || extent === 0) return 0
  let mean = 0
  for (const v of profile) mean += v
  mean /= n
  if (mean < 0.5) return 0
  let variance = 0
  for (const v of profile) variance += (v - mean) * (v - mean)
  return variance / n / (mean * mean)
}
