import type { BinaryImage, GrayImage } from './image'
import type { CellKind } from '../types'
import { detectBoundaries, sampleCurve, BANDS } from './gridGeometry'

/**
 * Turns a straightened photo into a grid of classified cells.
 *
 * Geometry comes from {@link detectBoundaries}, which returns each rule as a
 * curve following the page's bow. This module then only has to decide, for each
 * cell, whether it is empty, holds definitions, or is a dead square. Reading the
 * arrows is a separate job, in `arrowDetect.ts`.
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

/**
 * Recomputes which definition squares hold two stacked definitions, reading the
 * hairline out of the greyscale image rather than the binarised one.
 *
 * The hairline is the finest thing printed on the page, and the browser's own
 * image decoding is what erases it: area-averaged downscaling of a phone photo
 * dilutes a one-pixel rule into pale grey, which the threshold then discards.
 * Measured on the same photo and crop, binarised detection found 29 hairlines in
 * Node — whose sampling happens to alias and keep them — but only 11 in Chromium.
 *
 * Missing one is not cosmetic: the square then yields a single definition, and
 * the other is never read, never shown, and never correctable. Looking for a
 * darkness ridge instead of for ink survives the dilution, because a diluted
 * line is still the darkest row in its neighbourhood.
 *
 * @param gray greyscale image, ideally higher resolution than the detection pass
 * @param scale multiply detection coordinates by this to reach `gray`
 */
export function refineSplits(
  gray: GrayImage,
  detection: DetectionResult,
  scale: number,
): DetectionResult {
  const cells = detection.cells.map((cell) => {
    if (cell.kind !== 'clue') return cell
    const split = findHairlineInGray(
      gray,
      cell.x0 * scale,
      cell.y0 * scale,
      cell.x1 * scale,
      cell.y1 * scale,
    )
    if (split === null) {
      if (cell.split === undefined) return cell
      const { split: _dropped, ...rest } = cell
      return rest
    }
    return { ...cell, split }
  })
  return { ...detection, cells }
}

/**
 * Finds a definition square's internal hairline as a darkness ridge.
 *
 * @returns the hairline's height as a 0–1 fraction of the cell, or null
 */
function findHairlineInGray(
  gray: GrayImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number | null {
  const ax = Math.max(0, Math.round(x0 + (x1 - x0) * 0.2))
  const bx = Math.min(gray.width, Math.round(x1 - (x1 - x0) * 0.2))
  const width = bx - ax
  if (width <= 6) return null
  // Stay clear of the square's own top and bottom rules.
  const margin = (y1 - y0) * 0.26
  const top = Math.max(0, Math.round(y0 + margin))
  const bottom = Math.min(gray.height, Math.round(y1 - margin))
  if (bottom - top < 5) return null

  const rowMeans: number[] = []
  for (let y = top; y < bottom; y++) {
    let sum = 0
    const row = y * gray.width
    for (let x = ax; x < bx; x++) sum += gray.data[row + x]!
    rowMeans.push(sum / width)
  }

  // Paper level from the brighter rows, so surrounding text cannot pass for it.
  const sorted = [...rowMeans].sort((a, b) => a - b)
  const paper = sorted[Math.floor(sorted.length * 0.75)]!
  let darkest = Infinity
  let darkestIndex = -1
  for (let i = 0; i < rowMeans.length; i++) {
    if (rowMeans[i]! < darkest) {
      darkest = rowMeans[i]!
      darkestIndex = i
    }
  }
  if (darkestIndex < 0 || paper <= 0) return null

  // A rule has to be appreciably darker than the paper around it...
  const contrast = (paper - darkest) / paper
  if (contrast < 0.1) return null

  // ...and has to run right across the square, which is what separates it from a
  // line of definition text that happens to be dark on average.
  const cut = paper - (paper - darkest) * 0.45
  const y = top + darkestIndex
  let covered = 0
  for (let x = ax; x < bx; x++) if (gray.data[y * gray.width + x]! <= cut) covered++
  if (covered / width < 0.72) return null

  return (y - y0) / (y1 - y0)
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
