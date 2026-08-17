import type { BinaryImage, GrayImage } from './image'
import type { CellKind } from '../types'
import { detectBoundaries, sampleCurve, BANDS } from './gridGeometry'

/**
 * How far below the square's own paper level a pixel counts as ink when asking
 * "is anything printed here". Absolute, referenced to the paper: the print is
 * pale, but so is the paper, and it is the gap between the two that matters.
 */
const HAIRLINE_INK = 0.12

/**
 * Where the ink level sits when measuring how far a candidate row runs
 * unbroken: this far from the paper towards the row's own darkness.
 *
 * Relative to the row rather than absolute, because how pale a rule prints
 * varies from page to page — on sport-cerebral-42 the rules are barely a sixth
 * darker than the paper, half of what they are on fleches-niveau2-p43 — while
 * the gaps between letters sit at paper level on every page. So this adapts to a
 * washed-out rule without making a line of type look continuous.
 */
const HAIRLINE_RUN_LEVEL = 0.4

/**
 * Fraction of the measured width a printed rule must cross without a break.
 *
 * This is the whole discriminator. Measured over both fixture photos, the
 * longest unbroken run is 0.74–1.00 for a genuine hairline and at most 0.63 for
 * the darkest line of type in a single-definition square: type is dark on
 * average but always broken by the gaps between letters, a rule never is.
 */
const HAIRLINE_RUN = 0.7

/** Row darkness, relative to paper, below which nothing is printed at all. */
const HAIRLINE_DEPTH = 0.1

/**
 * Ink either side of the rule, as a fraction of the half's area. A hairline
 * separates two definitions, so both halves must carry text: below the floor one
 * half is blank (the candidate is the square's own border, let in by a grid that
 * sits a little high), above the ceiling one half is a solid dark mass (a
 * shadow or a photograph, not print). Genuine halves measure 0.14–0.53, the
 * dark masses 0.64 and up.
 */
const HAIRLINE_SIDE_MIN = 0.05

const HAIRLINE_SIDE_MAX = 0.58

/**
 * Fraction of the width a rule must cross unbroken in the binarised image.
 *
 * Lower than {@link HAIRLINE_RUN} because binarising at detection resolution
 * punches holes in a rule that is already diluted to pale grey — the very reason
 * {@link refineSplits} exists. This pass only has to be right enough for the
 * live preview; the greyscale pass is what the puzzle is built from.
 */
const SEPARATOR_RUN = 0.6

/**
 * Turns a straightened photo into a grid of classified cells.
 *
 * Geometry comes from {@link detectBoundaries}, which returns each rule as a
 * curve following the page's bow. This module then only has to decide, for each
 * cell, whether it is empty, holds definitions, or is a dead square. Reading the
 * arrows is a separate job, in `arrowDetect.ts`.
 *
 * Classification deliberately does *not* use the adaptive binary the geometry is
 * found in. Local adaptive thresholding is what makes the rules findable under a
 * hand-held photo's shadow gradient, but it also rescales the faint print showing
 * through this thin paper from the reverse side up to full ink: measured on
 * fleches-niveau2-p43, an empty square with show-through reaches an ink ratio of
 * 0.039 against a 0.035 threshold. Real definition text is near-black next to the
 * paper beside it, so an *absolute* darkness test tells the two apart — with the
 * paper level taken locally, over a few cells, because the same page varies from
 * 194 in the lit corner to 126 at the shaded edge and a single global level
 * therefore promotes shadow to ink (measured: one empty square lands at 0.49
 * against a global reference, versus 0.028 against a local one).
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
  /** Fraction of the interior darker than 60% of the local paper level. */
  darkRatio: number
  /** How much of the cell's own frame sits on printed rules (0–1). */
  frameScore: number
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
  /** Dark-pixel fraction above which a cell counts as holding a definition. */
  clueDarkThreshold?: number
  /** Dark-pixel fraction above which a cell is a solid dead square. */
  blockDarkThreshold?: number
  /**
   * How much of a cell's border must be printed for it to count as part of the
   * grid. Swept on two photos: between 0.35 and 0.60 the flat page is completely
   * stable (41 definition squares, 77.5% exact, 3 spurious), while the bowed one
   * gains two squares below 0.50. Set at the forgiving end of that plateau
   * because a definition wrongly rejected is lost — the user cannot correct text
   * that was never extracted — whereas one wrongly admitted is a single deletion.
   */
  frameThreshold?: number
}

/**
 * @param bin adaptive binary, used for the geometry and the frame test
 * @param gray the same image in greyscale, used for every darkness decision
 */
export function detectGrid(
  bin: BinaryImage,
  gray: GrayImage,
  opts: DetectOptions = {},
): DetectionResult {
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

  // The chain is found in the binarised image, which is what makes it findable at
  // all under a hand-held photo's shadow gradient — but binarising costs
  // precision, and a boundary a fifth of a cell off its rule is enough to cut a
  // line of definition text away. The greyscale still holds the rule exactly, so
  // each boundary is now placed on it.
  snapToRules(gray, ys, xs, horizontal.pitch, 'rows')
  snapToRules(gray, xs, ys, vertical.pitch, 'cols')

  const missingY = ys.length - horizontal.hits
  const missingX = xs.length - vertical.hits
  if (missingY > 0) warnings.push(`${missingY} ligne(s) horizontale(s) reconstituée(s)`)
  if (missingX > 0) warnings.push(`${missingX} ligne(s) verticale(s) reconstituée(s)`)

  // Thresholds measured on fleches-niveau2-p43, where the 41 definition squares
  // and the 180 empty ones were read off the page by hand: definitions carry
  // 0.063–0.35 of their interior below 60% of the local paper level, empty
  // squares at most 0.028 even where the reverse side shows through. The harder
  // sport-cerebral-42 photo agrees, with 0.043 and 0.065 either side of the gap.
  const clueDark = opts.clueDarkThreshold ?? 0.05
  // No solid squares appear on either photo; the darkest definition reaches 0.35,
  // so this only has to sit above that and below a square that is all ink.
  const blockDark = opts.blockDarkThreshold ?? 0.65
  const frameMin = opts.frameThreshold ?? 0.5
  // The rules may sit a few pixels off the fitted curve on a bowed page, so the
  // frame test looks this far for one. Measured span at 13% of the pitch: real
  // definition squares score 0.75–1.0, cells outside the printed grid ≤ 0.38.
  const frameTolerance = Math.max(2, Math.round(Math.min(vertical.pitch, horizontal.pitch) * 0.13))

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

      const paper = localPaperLevel(gray, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) * 1.25)
      const darkRatio = interiorDarkRatio(gray, paper, x0, y0, x1, y1)
      const frameScore = framedByRules(bin, ys, xs, r, c, x0, y0, x1, y1, frameTolerance)

      // A square that carries definitions has to *be* a square of the printed
      // grid. The boundary chain runs on past the grid onto the page edge, the
      // magazine's header and the binding shadow, and those bands are dark enough
      // to pass any darkness test — 26 of the 68 squares this photo reported as
      // definitions were such phantoms. Only the print itself frames a cell.
      let kind: CellKind = 'letter'
      if (frameScore >= frameMin) {
        if (darkRatio >= blockDark) kind = 'block'
        else if (darkRatio >= clueDark) kind = 'clue'
      }

      const cell: DetectedCell = {
        r,
        c,
        x0,
        y0,
        x1,
        y1,
        kind,
        darkRatio,
        frameScore,
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

/** How far a boundary may move to land on its rule, as a fraction of the pitch. */
const SNAP_RADIUS = 0.28

/**
 * Fraction of a band a line of ink must cover to be a rule.
 *
 * Measured across cell 0,0 of fleches-niveau2-p43: the rule inks 90 pixels of 90,
 * the darkest row of the definition text below it 40. There is no overlap to
 * worry about.
 */
const SNAP_COVERAGE = 0.62

/**
 * Moves each boundary onto the rule the page actually prints, band by band.
 *
 * The boundary chain is found in the binarised image because that is what
 * survives a hand-held photo's shadow gradient, but thresholding thickens and
 * shifts a one-pixel rule, and the chain then inherits the error. It does not
 * take much to matter: on fleches-niveau2-p43 the grid's top boundary settled 22
 * pixels below its rule — a fifth of a cell — which put it inside the first line
 * of `ACCROIS-SEMENT DE LA VITESSE`, so the crop began at the leading below that
 * line and the definition was read as `SEMENT DE LA VITESSE`. Nothing downstream
 * can recover a line the crop never contained.
 *
 * In greyscale the rule is unmistakable, so each boundary simply looks for it
 * within a fraction of a cell and moves there. A rule is recognised by covering
 * the band rather than by being dark: a line of capitals is dark too, but it
 * inks under half of the band while a rule inks nearly all of it.
 *
 * @param curves boundaries to move, modified in place
 * @param across the other axis's boundaries, which give the grid's own extent
 */
function snapToRules(
  gray: GrayImage,
  curves: number[][],
  across: number[][],
  pitch: number,
  axis: 'rows' | 'cols',
): void {
  if (curves.length < 2 || across.length < 2) return
  const sweepExtent = axis === 'rows' ? gray.width : gray.height
  const bands = curves[0]!.length
  const radius = Math.max(2, Math.round(pitch * SNAP_RADIUS))

  // Stay inside the grid: past its last rule there is only page, and a shadow or
  // a fold there would happily pass for a rule.
  const first = across[0]!
  const last = across[across.length - 1]!
  const gridFrom = Math.min(...first)
  const gridTo = Math.max(...last)

  for (let b = 0; b < bands; b++) {
    const bandFrom = Math.max(gridFrom, (b * sweepExtent) / bands)
    const bandTo = Math.min(gridTo, ((b + 1) * sweepExtent) / bands)
    if (bandTo - bandFrom < 8) continue
    const from = Math.round(bandFrom)
    const to = Math.round(bandTo)

    /** Fraction of this band inked along one line. */
    const coverage = (at: number, cut: number): number => {
      const line = Math.round(at)
      let dark = 0
      for (let k = from; k < to; k++) {
        const value =
          axis === 'rows' ? gray.data[line * gray.width + k] : gray.data[k * gray.width + line]
        if (value !== undefined && value <= cut) dark++
      }
      return dark / (to - from)
    }

    for (const curve of curves) {
      const here = curve[b]!
      const centreAcross = (from + to) / 2
      const cut =
        localPaperLevel(
          gray,
          axis === 'rows' ? centreAcross : here,
          axis === 'rows' ? here : centreAcross,
          pitch * 1.5,
        ) * 0.6
      const limit = axis === 'rows' ? gray.height : gray.width
      let bestScore = SNAP_COVERAGE
      let bestAt: number | null = null
      for (let d = -radius; d <= radius; d++) {
        const at = here + d
        if (at < 0 || at >= limit) continue
        const score = coverage(at, cut)
        // Nearest wins a tie: the fitted position is the better prior.
        if (score > bestScore || (score === bestScore && bestAt !== null && Math.abs(d) < Math.abs(bestAt - here))) {
          bestScore = score
          bestAt = at
        }
      }
      if (bestAt !== null) curve[b] = bestAt
    }
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
 * Fraction of a cell's extent a line of ink must cover to be a rule rather than
 * type.
 *
 * Measured across a cell's central 70% — so the perpendicular rules and any
 * hairline are excluded — a printed rule covers essentially all of it, while the
 * darkest column through four stacked lines of capitals covers a little over
 * half.
 */
const RULE_FILL = 0.68

/**
 * Fraction of the grid's median frame agreement below which a border row or
 * column counts as unprinted, and so as margin rather than grid.
 *
 * Set midway across a wide gap: on the two test photos the phantom edges score
 * 0.29, 0.02 and 0.01 against medians near 0.92, and the weakest real edge
 * scores 0.78. Anything from about 0.4 to 0.8 of the median separates them.
 */
const UNPRINTED_EDGE = 0.7

/** Where an edge starts before it is fitted, as a fraction of the cell. */
const TEXT_INSET = 0.045

/**
 * How far past the nominal bound fitting may reach, as a fraction of the cell.
 *
 * Negative — i.e. outside the cell — because the bound is only ever approximately
 * where the rule is, and being a few pixels short of the true square cuts type
 * just as effectively as insetting too far did. Cell 0,2's box lands 12px below
 * its printed rule, which was enough to shave the caps off `CERCLE` and have it
 * read as `VENVLLE`. Reaching outward is safe here only because the fit stops at
 * a rule, and before that at the first clear line: this is a backstop, not the
 * usual stopping condition.
 */
const TEXT_LIMIT = -0.15

/**
 * Fits a crop box to the type inside a definition square, so that no glyph is cut
 * and no rule is included.
 *
 * A fixed inset cannot do both. The grid is fitted as a straight arithmetic
 * progression and the printed page bows, so a rule lands several pixels either
 * side of where the progression puts it — and cell 2,9's left rule falls outside
 * its nominal bound altogether. An inset generous enough to clear the worst case
 * slices a glyph in half in the common one, which on this page it did on 29 of 41
 * squares. The damage never shows in the output but is fatal to it: half a U
 * reads as L (`METS EN JEU` → `METS EN JEL`), an O missing its left arc reads as
 * D (`OBSCURITÉS` → `DBSCURITÉS`), and a shaved first letter simply disappears
 * (`DYNAMIQUES` → `YNAMIQUES`).
 *
 * Locating the rules absolutely was tried first and is worse, not better: where a
 * rule is faint or notched by an arrow it is missed and left in the crop, and
 * Tesseract dutifully reads the fragment as a letter (`VOITURE SUR RAILS` →
 * `I VOITURE SUR RAILS`, `PROBLÈME` → `PROBLÈME D D`). Spurious characters cost
 * as much as missing ones.
 *
 * So each edge is instead *fitted*, monotonically: it starts at a safe inset and
 * moves outward only while it is still cutting through ink, stopping at the first
 * clear line — the gutter the page prints between type and rule — or at a line
 * that is rule-like. The starting position is the old behaviour, so an edge that
 * was already clear is left exactly where it was; only edges that were demonstrably
 * cutting type move at all.
 *
 * Coordinates are in `gray`'s own space, and `limit` bounds how far out any edge
 * may travel — for a stacked square that keeps each half on its own side of the
 * hairline.
 */
export function fitTextBox(
  gray: GrayImage,
  region: { x0: number; y0: number; x1: number; y1: number },
  limit: { x0: number; y0: number; x1: number; y1: number },
): { x0: number; y0: number; x1: number; y1: number } {
  const w = region.x1 - region.x0
  const h = region.y1 - region.y0
  if (w < 8 || h < 8) return region
  // Same absolute criterion as classification: ink, not shadow.
  const cut =
    localPaperLevel(gray, (region.x0 + region.x1) / 2, (region.y0 + region.y1) / 2, Math.max(w, h) * 1.25) *
    0.6

  const ay = Math.max(0, Math.round(region.y0 + h * 0.08))
  const by = Math.min(gray.height, Math.round(region.y1 - h * 0.08))
  const ax = Math.max(0, Math.round(region.x0 + w * 0.08))
  const bx = Math.min(gray.width, Math.round(region.x1 - w * 0.08))

  /** Dark pixels down one column, within the region's own rows. */
  const colInk = (x: number): number => {
    const px = Math.round(x)
    if (px < 0 || px >= gray.width || by <= ay) return 0
    let dark = 0
    for (let y = ay; y < by; y++) if (gray.data[y * gray.width + px]! <= cut) dark++
    return dark
  }
  /** Dark pixels along one row, within the region's own columns. */
  const rowInk = (y: number): number => {
    const py = Math.round(y)
    if (py < 0 || py >= gray.height || bx <= ax) return 0
    const row = py * gray.width
    let dark = 0
    for (let x = ax; x < bx; x++) if (gray.data[row + x]! <= cut) dark++
    return dark
  }

  // A stroke's edge leaves a handful of dark pixels; JPEG noise leaves one or two.
  const colMin = Math.max(3, Math.round((by - ay) * 0.05))
  const rowMin = Math.max(3, Math.round((bx - ax) * 0.04))

  /**
   * Places one edge between the rule and the type. `sign` is the direction of
   * travel outward: -1 toward a low bound, +1 toward a high one.
   */
  const fit = (
    ink: (v: number) => number,
    span: number,
    start: number,
    stop: number,
    sign: number,
    min: number,
  ): number => {
    let v = start
    // First, come off the rule if the edge has landed on one — which happens
    // whenever the fitted bound overshoots its square. Left in, the rule reaches
    // the crop as a black bar and Tesseract reads it as a character.
    const clearance = Math.max(2, Math.round(span * 0.02))
    for (let guard = 0; ink(v) / span >= RULE_FILL && guard < span; guard++) v -= sign
    if (v !== start) return v - sign * clearance

    if (ink(v) < min) return v // already clear: no type is being cut
    // Otherwise the edge is cutting through type, so walk out to the gutter the
    // page prints between the type and the rule.
    for (;;) {
      const next = v + sign
      if (sign < 0 ? next < stop : next > stop) break
      if (ink(next) / span >= RULE_FILL) break // reached the rule; keep the paper
      v = next
      if (ink(v) < min) break
    }
    return v
  }

  const colSpan = Math.max(1, by - ay)
  const rowSpan = Math.max(1, bx - ax)
  return {
    x0: fit(colInk, colSpan, region.x0, limit.x0, -1, colMin),
    x1: fit(colInk, colSpan, region.x1, limit.x1, 1, colMin),
    y0: fit(rowInk, rowSpan, region.y0, limit.y0, -1, rowMin),
    y1: fit(rowInk, rowSpan, region.y1, limit.y1, 1, rowMin),
  }
}

/** Starting inset and outward limit for fitting a definition square's crop. */
export function textBoxBounds(cell: { x0: number; y0: number; x1: number; y1: number }) {
  const w = cell.x1 - cell.x0
  const h = cell.y1 - cell.y0
  const insetX = Math.max(2, w * TEXT_INSET)
  const insetY = Math.max(2, h * TEXT_INSET)
  const limitX = w * TEXT_LIMIT
  const limitY = h * TEXT_LIMIT
  return {
    start: {
      x0: cell.x0 + insetX,
      y0: cell.y0 + insetY,
      x1: cell.x1 - insetX,
      y1: cell.y1 - insetY,
    },
    limit: {
      x0: cell.x0 + limitX,
      y0: cell.y0 + limitY,
      x1: cell.x1 - limitX,
      y1: cell.y1 - limitY,
    },
  }
}

/**
 * Finds a definition square's internal hairline: the longest unbroken dark run.
 *

/**
 * Finds a definition square's internal hairline: the longest unbroken dark run.
 *
 * Looking for the darkest row instead — which is what this did first — finds the
 * boldest line of type at least as often as it finds the rule, because at photo
 * resolution a line of caps averages darker than a one-pixel rule. That both
 * invents hairlines in single-definition squares and, worse, puts the split in
 * the middle of a word in squares that really are divided.
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
  if (paper <= 0) return null
  const inkLevel = paper * (1 - HAIRLINE_INK)

  // Ink per row over the whole square, borders excluded, as a running total: the
  // "text on both sides" test then costs nothing per candidate.
  const pad = (y1 - y0) * 0.08
  const inkFrom = Math.max(0, Math.round(y0 + pad))
  const inkTo = Math.min(gray.height, Math.round(y1 - pad))
  const inkUpTo = new Int32Array(Math.max(0, inkTo - inkFrom) + 1)
  for (let y = inkFrom; y < inkTo; y++) {
    const row = y * gray.width
    let ink = 0
    for (let x = ax; x < bx; x++) if (gray.data[row + x]! <= inkLevel) ink++
    inkUpTo[y - inkFrom + 1] = inkUpTo[y - inkFrom]! + ink
  }
  /** Ink as a fraction of the area of the rows in [from, to). */
  const inkFraction = (from: number, to: number): number => {
    const a = Math.min(Math.max(from, inkFrom), inkTo)
    const b = Math.min(Math.max(to, inkFrom), inkTo)
    if (b - a < 2) return 0
    return (inkUpTo[b - inkFrom]! - inkUpTo[a - inkFrom]!) / ((b - a) * width)
  }

  // A rule is one or two pixels of a phone photo; a line of type is many. Kept
  // as a fraction of the square so the test does not shift with the crop's
  // resolution. The floor matters: a square the boundary detector left half its
  // proper height would otherwise admit no candidate at all.
  const thickest = Math.max(4, Math.round((y1 - y0) * 0.06))

  // Every test is applied while searching, and the most rule-like row that
  // passes them all wins. Judging only the single longest run instead lets a
  // bold line of type — which can match a pale rule's run — take the candidacy
  // and then fail the rest, losing a hairline that was plainly there.
  let bestIndex = -1
  let bestRun = 0
  for (let i = 0; i < rowMeans.length; i++) {
    const depth = (paper - rowMeans[i]!) / paper
    if (depth < HAIRLINE_DEPTH) continue
    // The rule's own core, not the half-lit row beside it: a shoulder inherits
    // most of the run and can pass the two-halves test on the strength of the
    // rule it sits next to.
    if (i > 0 && rowMeans[i]! > rowMeans[i - 1]!) continue
    if (i < rowMeans.length - 1 && rowMeans[i]! > rowMeans[i + 1]!) continue

    const half = paper - (paper - rowMeans[i]!) * 0.5
    let up = i
    while (up > 0 && rowMeans[up - 1]! <= half) up--
    let down = i
    while (down < rowMeans.length - 1 && rowMeans[down + 1]! <= half) down++
    if (down - up + 1 > thickest) continue

    const runLevel = paper - (paper - rowMeans[i]!) * HAIRLINE_RUN_LEVEL
    const row = (top + i) * gray.width
    let run = 0
    let longest = 0
    for (let x = ax; x < bx; x++) {
      if (gray.data[row + x]! <= runLevel) {
        run++
        if (run > longest) longest = run
      } else run = 0
    }
    if (longest <= bestRun || longest / width < HAIRLINE_RUN) continue

    // Skip the rule's own rows, blur included, when reading the two halves.
    const y = top + i
    const above = inkFraction(inkFrom, y - 3)
    const below = inkFraction(y + 4, inkTo)
    if (above < HAIRLINE_SIDE_MIN || below < HAIRLINE_SIDE_MIN) continue
    if (above > HAIRLINE_SIDE_MAX || below > HAIRLINE_SIDE_MAX) continue

    bestRun = longest
    bestIndex = i
  }
  if (bestIndex < 0) return null

  return (top + bestIndex - y0) / (y1 - y0)
}

/**
 * Paper level around a point: a high percentile of the grey values over a window
 * a few cells wide.
 *
 * The window has to be wide enough that paper dominates it — at two and a half
 * cells, print covers at most a third — and narrow enough to follow the
 * illumination across the page, which on a hand-held photo of a bound magazine
 * spans 194 in the lit corner to 126 in the gutter.
 */
function localPaperLevel(gray: GrayImage, cx: number, cy: number, radius: number): number {
  const ax = Math.max(0, Math.round(cx - radius))
  const bx = Math.min(gray.width, Math.round(cx + radius))
  const ay = Math.max(0, Math.round(cy - radius))
  const by = Math.min(gray.height, Math.round(cy + radius))
  const histogram = new Int32Array(256)
  let total = 0
  // Every other pixel: this runs per cell, and a percentile does not need them all.
  for (let y = ay; y < by; y += 2) {
    const row = y * gray.width
    for (let x = ax; x < bx; x += 2) {
      histogram[gray.data[row + x]!]!++
      total++
    }
  }
  if (total === 0) return 255
  let seen = 0
  for (let level = 0; level < 256; level++) {
    seen += histogram[level]!
    if (seen >= total * 0.8) return level
  }
  return 255
}

/**
 * Fraction of the cell's interior that is absolutely dark, inset to exclude the
 * printed borders.
 *
 * The cut is 60% of the paper level: printed type lands near 30% of it, the
 * reverse side showing through never gets below about 75%.
 */
function interiorDarkRatio(
  gray: GrayImage,
  paper: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const insetX = Math.max(1, (x1 - x0) * 0.15)
  const insetY = Math.max(1, (y1 - y0) * 0.15)
  const ax = Math.max(0, Math.round(x0 + insetX))
  const bx = Math.min(gray.width, Math.round(x1 - insetX))
  const ay = Math.max(0, Math.round(y0 + insetY))
  const by = Math.min(gray.height, Math.round(y1 - insetY))
  if (bx <= ax || by <= ay) return 0
  const cut = paper * 0.6
  let dark = 0
  let total = 0
  for (let y = ay; y < by; y++) {
    const row = y * gray.width
    for (let x = ax; x < bx; x++) {
      if (gray.data[row + x]! <= cut) dark++
      total++
    }
  }
  return total === 0 ? 0 : dark / total
}

/**
 * How much of a cell's own frame sits on printed rules, as a 0–1 fraction of the
 * weakest of its four sides.
 *
 * This is what separates a square of the grid from the bands the boundary chain
 * picks up beyond it: the page edge, the header strip and the binding shadow are
 * all dark, but nothing is *ruled* there. The weakest side is what counts,
 * because a phantom row still shares the grid's own rule on the side facing it.
 */
function framedByRules(
  bin: BinaryImage,
  ys: number[][],
  xs: number[][],
  r: number,
  c: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tolerance: number,
): number {
  const { width: w, height: h } = bin
  const inkAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : bin.data[y * w + x]!

  // Sample along the middle of each side, away from the corners where the
  // neighbouring rules would answer for it.
  const sampleAlong = (
    curve: number[],
    from: number,
    to: number,
    across: 'x' | 'y',
  ): number => {
    const extent = across === 'y' ? w : h
    const step = Math.max(1, Math.round((to - from) / 14))
    let hits = 0
    let taken = 0
    for (let p = Math.round(from); p <= to; p += step) {
      const q = Math.round(sampleCurve(curve, p, extent))
      let found = false
      for (let d = -tolerance; d <= tolerance && !found; d++) {
        found = across === 'y' ? !!inkAt(p, q + d) : !!inkAt(q + d, p)
      }
      if (found) hits++
      taken++
    }
    return taken === 0 ? 0 : hits / taken
  }

  const insetX = (x1 - x0) * 0.15
  const insetY = (y1 - y0) * 0.15
  return Math.min(
    sampleAlong(ys[r]!, x0 + insetX, x1 - insetX, 'y'),
    sampleAlong(ys[r + 1]!, x0 + insetX, x1 - insetX, 'y'),
    sampleAlong(xs[c]!, y0 + insetY, y1 - insetY, 'x'),
    sampleAlong(xs[c + 1]!, y0 + insetY, y1 - insetY, 'x'),
  )
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

  // The longest unbroken run, not the total ink: a line of capitals fills most
  // of a row too, but never without the gaps between the letters.
  let best = -1
  let bestRun = 0
  let bestInk = 0
  for (let y = top; y < bottom; y++) {
    const row = y * bin.width
    let run = 0
    let longest = 0
    let ink = 0
    for (let x = ax; x < bx; x++) {
      if (bin.data[row + x]) {
        ink++
        run++
        if (run > longest) longest = run
      } else run = 0
    }
    if (longest > bestRun || (longest === bestRun && ink > bestInk)) {
      bestRun = longest
      bestInk = ink
      best = y
    }
  }
  if (best < 0 || bestRun / width < SEPARATOR_RUN) return null

  // Both halves must carry text, for the reasons given at HAIRLINE_SIDE_MIN.
  const inkFraction = (from: number, to: number): number => {
    const a = Math.max(0, Math.round(from))
    const b = Math.min(bin.height, Math.round(to))
    if (b - a < 2) return 0
    let ink = 0
    let total = 0
    for (let y = a; y < b; y++) {
      const row = y * bin.width
      for (let x = ax; x < bx; x++) {
        if (bin.data[row + x]) ink++
        total++
      }
    }
    return total === 0 ? 0 : ink / total
  }
  const pad = (y1 - y0) * 0.08
  const above = inkFraction(y0 + pad, best - 2)
  const below = inkFraction(best + 3, y1 - pad)
  if (above < HAIRLINE_SIDE_MIN || below < HAIRLINE_SIDE_MIN) return null
  if (above > HAIRLINE_SIDE_MAX || below > HAIRLINE_SIDE_MAX) return null

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

/**
 * Drops border rows and columns that are not part of the printed grid.
 *
 * Boundary detection reliably finds the grid's rhythm but tends to extend it a
 * row or two past the print, over the page header or into the margin. Those
 * phantom cells used to be admitted as definitions, which produced dozens of
 * junk readings; now that the frame test rejects them they instead show up as
 * fillable squares no clue can ever reach — visible to the player as squares
 * that cannot be filled.
 *
 * A border row belongs to the grid if it holds a definition, or a square some
 * definition points into — *and* if it is printed at all. Anything else is
 * margin, so it is peeled away, one edge at a time, until every edge earns its
 * place.
 *
 * The second test is what catches a phantom row that lands on the page header,
 * where the words are read as definitions and the row therefore looks used. It
 * asks the only question that separates the grid from the page around it: is
 * this row drawn? Measured on both test photos the answer is not close — the
 * phantom edges agree with printed rules on 0.29, 0.02 and 0.01 of their
 * borders, while every real row and column of both grids scores at least 0.78.
 * The comparison is against the grid's own median rather than a fixed level, so
 * a faintly printed or poorly lit page is judged against itself.
 *
 * @param reachable keys "r,c" of squares an arrow actually reaches
 */
export function trimUnusedEdges(
  detection: DetectionResult,
  reachable: ReadonlySet<string>,
): DetectionResult {
  let { rows, cols } = detection
  let top = 0
  let left = 0

  const at = (r: number, c: number) => detection.cells[r * detection.cols + c]
  const lineCells = (kind: 'row' | 'col', index: number) => {
    const limit = kind === 'row' ? cols : rows
    const out: DetectedCell[] = []
    for (let k = 0; k < limit; k++) {
      const cell = at(kind === 'row' ? index : k, kind === 'row' ? k : index)
      if (cell) out.push(cell)
    }
    return out
  }

  const allFrames = detection.cells.map((cell) => cell.frameScore).sort((a, b) => a - b)
  const medianFrame = allFrames[Math.floor(allFrames.length / 2)] ?? 0
  const framedEnough = medianFrame * UNPRINTED_EDGE

  /** Does this line carry anything the grid needs, and is it printed? */
  const used = (kind: 'row' | 'col', index: number) => {
    const cells = lineCells(kind, index)
    if (cells.length === 0) return false
    const frame = cells.reduce((total, cell) => total + cell.frameScore, 0) / cells.length
    if (frame < framedEnough) return false
    for (const cell of cells) {
      if (cell.kind === 'clue') return true
      if (cell.kind === 'letter' && reachable.has(`${cell.r},${cell.c}`)) return true
    }
    return false
  }

  // Peel one edge at a time, re-testing after each: removing a row can leave the
  // next one just as unused.
  let peeled = true
  while (peeled && rows > 2 && cols > 2) {
    peeled = false
    if (!used('row', top)) {
      top++
      rows--
      peeled = true
    }
    if (rows > 2 && !used('row', top + rows - 1)) {
      rows--
      peeled = true
    }
    if (!used('col', left)) {
      left++
      cols--
      peeled = true
    }
    if (cols > 2 && !used('col', left + cols - 1)) {
      cols--
      peeled = true
    }
  }

  if (top === 0 && left === 0 && rows === detection.rows && cols === detection.cols) {
    return detection
  }

  const cells: DetectedCell[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const source = at(top + r, left + c)
      if (!source) continue
      // Keep the pixel bounds, renumber the grid position.
      cells.push({ ...source, r, c })
    }
  }
  return {
    ...detection,
    rows,
    cols,
    ys: detection.ys.slice(top, top + rows + 1),
    xs: detection.xs.slice(left, left + cols + 1),
    cells,
    warnings: [
      ...detection.warnings,
      `${detection.rows - rows} rangée(s) et ${detection.cols - cols} colonne(s) hors grille retirées`,
    ],
  }
}
