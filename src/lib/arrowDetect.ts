import type { BinaryImage } from './image'
import type { ArrowKind } from '../types'
import type { DetectedCell, DetectionResult } from './gridDetect'

/**
 * Reads the printed arrows, including the bent ones.
 *
 * The idea that makes this tractable: an arrowword's fillable squares are
 * *empty*. So any ink found inside one — once the grid's own rules are
 * discounted — is either an arrow glyph or a mystery-word index, and those two
 * are easy to tell apart because an arrow always starts at a border while an
 * index floats free in the middle.
 *
 * A glyph is drawn inside the square the answer starts in, entering from the
 * border it shares with its definition. That gives a clean 2×2 classification:
 *
 *   enters left, head right   →   `right`      answer runs across from here
 *   enters top,  head down    ↓   `down`       answer runs down from here
 *   enters top,  head right   └→  `downRight`  answer runs across from here
 *   enters left, head down    ┐↓  `rightDown`  answer runs down from here
 *
 * The entry edge names which definition square owns the arrow; the head names
 * the direction the answer reads. Both come from the image rather than from a
 * guess, which is what lets the bent forms be recognised at all — geometry alone
 * cannot distinguish `down` from `downRight`, since both start below the clue.
 */

export interface ArrowEvidence {
  /** The definition square this arrow belongs to. */
  clue: { r: number; c: number }
  /** The square the answer starts in — where the glyph is drawn. */
  start: { r: number; c: number }
  kind: ArrowKind
  /** 0–1: how cleanly the glyph matched. */
  confidence: number
}

/** A compact glyph floating clear of every border: a mystery-word index. */
export interface MarkEvidence {
  r: number
  c: number
  box: { x0: number; y0: number; x1: number; y1: number }
}

export interface ArrowDetection {
  arrows: ArrowEvidence[]
  marks: MarkEvidence[]
}

interface Blob {
  minX: number
  minY: number
  maxX: number
  maxY: number
  ink: number
  /** Pixel indices within the cell region, for shape measurements. */
  pixels: number[]
  /** Row length of that region, to decode the indices. */
  stride: number
}

/**
 * Connected components inside one cell's interior.
 *
 * Rows and columns that are almost solid ink are blanked first: a thick or
 * slightly misplaced grid rule can bleed past the inset, and if it touched the
 * glyph the two would merge into one unusable component.
 */
function blobsInCell(
  bin: BinaryImage,
  cell: DetectedCell,
  insetRatio: number,
): { blobs: Blob[]; width: number; height: number } {
  const insetX = (cell.x1 - cell.x0) * insetRatio
  const insetY = (cell.y1 - cell.y0) * insetRatio
  const ax = Math.max(0, Math.round(cell.x0 + insetX))
  const bx = Math.min(bin.width, Math.round(cell.x1 - insetX))
  const ay = Math.max(0, Math.round(cell.y0 + insetY))
  const by = Math.min(bin.height, Math.round(cell.y1 - insetY))
  const w = bx - ax
  const h = by - ay
  if (w < 8 || h < 8) return { blobs: [], width: w, height: h }

  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const src = (ay + y) * bin.width + ax
    for (let x = 0; x < w; x++) mask[y * w + x] = bin.data[src + x] ? 1 : 0
  }
  // Drop rule remnants: a near-solid line across the whole region.
  for (let y = 0; y < h; y++) {
    let ink = 0
    for (let x = 0; x < w; x++) ink += mask[y * w + x]!
    if (ink > w * 0.8) mask.fill(0, y * w, y * w + w)
  }
  for (let x = 0; x < w; x++) {
    let ink = 0
    for (let y = 0; y < h; y++) ink += mask[y * w + x]!
    if (ink > h * 0.8) {
      for (let y = 0; y < h; y++) mask[y * w + x] = 0
    }
  }

  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const blobs: Blob[] = []

  for (let start = 0; start < mask.length; start++) {
    if (seen[start] || !mask[start]) continue
    seen[start] = 1
    stack.push(start)
    const pixels: number[] = []
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1

    while (stack.length > 0) {
      const index = stack.pop()!
      const x = index % w
      const y = (index / w) | 0
      pixels.push(index)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      // 8-connected, so a diagonal or hairline stroke stays a single blob.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const next = ny * w + nx
          if (seen[next]) continue
          seen[next] = 1
          if (mask[next]) stack.push(next)
        }
      }
    }

    blobs.push({ minX, minY, maxX, maxY, ink: pixels.length, pixels, stride: w })
  }

  return { blobs, width: w, height: h }
}

export interface ArrowDetectOptions {
  /**
   * Bounding-box fill below which a glyph looks like an elbow rather than a
   * line. Measured on real magazine print: straight arrows fill 0.47–1.00 of
   * their box, bent ones only 0.34–0.42, because an L leaves a corner empty.
   */
  bendThreshold?: number
  /** How close to a border a stroke must start to count as entering there. */
  edgeTolerance?: number
}

/**
 * Reads every arrow glyph in the grid.
 *
 * @param bin binarised straightened image, same coordinates as `detection`
 */
export function detectArrows(
  bin: BinaryImage,
  detection: DetectionResult,
  options: ArrowDetectOptions = {},
): ArrowDetection {
  const bend = options.bendThreshold ?? 0.45
  const edge = options.edgeTolerance ?? 0.2
  const arrows: ArrowEvidence[] = []
  const marks: MarkEvidence[] = []

  const at = (r: number, c: number): DetectedCell | undefined =>
    r < 0 || c < 0 || r >= detection.rows || c >= detection.cols
      ? undefined
      : detection.cells[r * detection.cols + c]

  for (const cell of detection.cells) {
    if (cell.kind !== 'letter') continue
    const clueLeft = at(cell.r, cell.c - 1)?.kind === 'clue'
    const clueAbove = at(cell.r - 1, cell.c)?.kind === 'clue'
    if (!clueLeft && !clueAbove) continue

    const { blobs, width, height } = blobsInCell(bin, cell, 0.07)
    if (width < 8 || height < 8) continue

    // Plausible glyphs only: reject specks, and reject anything spanning the
    // cell, which is a grid rule that survived the inset rather than a glyph.
    const glyphs = blobs.filter((blob) => {
      const spanX = (blob.maxX - blob.minX + 1) / width
      const spanY = (blob.maxY - blob.minY + 1) / height
      if (blob.ink < 10) return false
      if (spanX >= 0.85 || spanY >= 0.85) return false
      return Math.max(spanX, spanY) >= 0.12
    })
    if (glyphs.length === 0) continue

    for (const blob of glyphs) {
      const boxW = blob.maxX - blob.minX + 1
      const boxH = blob.maxY - blob.minY + 1
      const spanX = boxW / width
      const spanY = boxH / height
      const touchesLeft = blob.minX <= width * edge
      const touchesTop = blob.minY <= height * edge

      if (!touchesLeft && !touchesTop) {
        // Floats clear of every border: a mystery-word index, not an arrow.
        if (spanX < 0.6 && spanY < 0.6) {
          marks.push({
            r: cell.r,
            c: cell.c,
            box: { x0: blob.minX, y0: blob.minY, x1: blob.maxX + 1, y1: blob.maxY + 1 },
          })
        }
        continue
      }

      // The glyph's long axis is the direction its answer reads: a bend's two
      // arms are unequal, and the arm carrying the head is always the longer.
      const readsAcross = spanX >= spanY

      // Which definition square owns it. Usually only one neighbour is a
      // definition at all, which settles it outright; that single geometric fact
      // is what makes bends recognisable without trusting the elbow.
      let fromLeft: boolean
      let ownerConfidence: number
      if (clueLeft && !clueAbove) {
        fromLeft = true
        ownerConfidence = 1
      } else if (clueAbove && !clueLeft) {
        fromLeft = false
        ownerConfidence = 1
      } else {
        // Both neighbours are definitions: fall back to the elbow's shape. A
        // straight glyph fills its box; an L leaves a diagonal corner empty.
        const fill = blob.ink / (boxW * boxH)
        const { bottomLeft, topRight } = diagonalCorners(blob)
        const total = bottomLeft + topRight
        const contrast = total > 0 ? Math.abs(bottomLeft - topRight) / total : 0
        const bentLooking = fill < bend && Math.min(spanX, spanY) >= 0.1
        if (bentLooking) {
          // Empty top-right means the arms run left and along the bottom (└→),
          // which is owned by the square above; the mirror case by the left one.
          fromLeft = bottomLeft < topRight
          ownerConfidence = 0.45 + 0.4 * Math.min(1, contrast / 0.6)
        } else {
          fromLeft = readsAcross
          ownerConfidence = 0.75
        }
      }

      const kind: ArrowKind = readsAcross
        ? fromLeft
          ? 'right'
          : 'downRight'
        : fromLeft
          ? 'rightDown'
          : 'down'

      // How emphatic the long axis is: a nearly square glyph could go either way.
      const axisRatio = Math.max(spanX, spanY) / Math.max(0.01, Math.min(spanX, spanY))
      const axisConfidence = Math.min(1, 0.4 + 0.3 * Math.min(2, axisRatio - 1))

      arrows.push({
        clue: fromLeft ? { r: cell.r, c: cell.c - 1 } : { r: cell.r - 1, c: cell.c },
        start: { r: cell.r, c: cell.c },
        kind,
        confidence: Math.max(0, Math.min(1, ownerConfidence * axisConfidence)),
      })
    }
  }

  return { arrows, marks }
}

/**
 * Ink in the bounding box's bottom-left and top-right corners, each measured
 * over a third of the box, which is where an elbow's arms do or do not reach.
 */
function diagonalCorners(blob: Blob): { bottomLeft: number; topRight: number } {
  const boxW = blob.maxX - blob.minX + 1
  const boxH = blob.maxY - blob.minY + 1
  const cw = Math.max(1, Math.round(boxW / 3))
  const chh = Math.max(1, Math.round(boxH / 3))
  let bottomLeft = 0
  let topRight = 0
  for (const index of blob.pixels) {
    const x = (index % blob.stride) - blob.minX
    const y = ((index / blob.stride) | 0) - blob.minY
    if (x < cw && y >= boxH - chh) bottomLeft++
    if (x >= boxW - cw && y < chh) topRight++
  }
  return { bottomLeft, topRight }
}

/**
 * Folds the glyph readings into per-clue arrow lists.
 *
 * Two definitions stacked in one square feed two answers, so a square can
 * legitimately own two arrows; duplicates of the same kind are collapsed, and
 * the better-scored reading wins.
 */
export function groupArrowsByClue(arrows: ArrowEvidence[]): Map<string, ArrowEvidence[]> {
  const byClue = new Map<string, ArrowEvidence[]>()
  for (const arrow of arrows) {
    const key = `${arrow.clue.r},${arrow.clue.c}`
    const list = byClue.get(key)
    if (!list) {
      byClue.set(key, [arrow])
      continue
    }
    const duplicate = list.find((existing) => existing.kind === arrow.kind)
    if (duplicate) {
      if (arrow.confidence > duplicate.confidence) duplicate.confidence = arrow.confidence
      continue
    }
    list.push(arrow)
  }
  // Strongest reading first, so a caller taking one arrow takes the best.
  for (const list of byClue.values()) list.sort((a, b) => b.confidence - a.confidence)
  return byClue
}

/* ------------------------------------------------------------- diagnostics */

export interface GlyphMeasurement {
  r: number
  c: number
  clueLeft: boolean
  clueAbove: boolean
  /** Bounding box size as a fraction of the cell. */
  spanX: number
  spanY: number
  ink: number
  fill: number
  touchesLeft: boolean
  touchesTop: boolean
  bottomLeft: number
  topRight: number
  decided: ArrowKind | 'mark' | 'dropped'
  confidence: number
}

/**
 * Raw per-component measurements, for calibrating thresholds against real
 * photos in `scripts/dev-arrows.mjs` rather than by guesswork.
 */
export function measureGlyphs(
  bin: BinaryImage,
  detection: DetectionResult,
  options: ArrowDetectOptions = {},
): GlyphMeasurement[] {
  const bend = options.bendThreshold ?? 0.28
  const edge = options.edgeTolerance ?? 0.18
  const out: GlyphMeasurement[] = []

  const at = (r: number, c: number): DetectedCell | undefined =>
    r < 0 || c < 0 || r >= detection.rows || c >= detection.cols
      ? undefined
      : detection.cells[r * detection.cols + c]

  for (const cell of detection.cells) {
    if (cell.kind !== 'letter') continue
    const clueLeft = at(cell.r, cell.c - 1)?.kind === 'clue'
    const clueAbove = at(cell.r - 1, cell.c)?.kind === 'clue'
    if (!clueLeft && !clueAbove) continue
    const { blobs, width, height } = blobsInCell(bin, cell, 0.07)
    if (width < 8 || height < 8) continue

    for (const blob of blobs) {
      const boxW = blob.maxX - blob.minX + 1
      const boxH = blob.maxY - blob.minY + 1
      if (blob.ink < 6) continue
      const corners = diagonalCorners(blob)
      const touchesLeft = blob.minX <= width * edge
      const touchesTop = blob.minY <= height * edge
      let decided: ArrowKind | 'mark' | 'dropped' = 'dropped'
      let confidence = 0
      const spanX = boxW / width
      const spanY = boxH / height
      if (blob.ink < 10 || spanX >= 0.85 || spanY >= 0.85 || Math.max(spanX, spanY) < 0.12) {
        decided = 'dropped'
      } else if (!touchesLeft && !touchesTop) {
        decided = 'mark'
      } else {
        const readsAcross = spanX >= spanY
        const fill = blob.ink / (boxW * boxH)
        let fromLeft: boolean
        if (clueLeft && !clueAbove) fromLeft = true
        else if (clueAbove && !clueLeft) fromLeft = false
        else if (fill < bend && Math.min(spanX, spanY) >= 0.1)
          fromLeft = corners.bottomLeft < corners.topRight
        else fromLeft = readsAcross
        decided = readsAcross
          ? fromLeft ? 'right' : 'downRight'
          : fromLeft ? 'rightDown' : 'down'
        confidence = 1
      }
      out.push({
        r: cell.r,
        c: cell.c,
        clueLeft,
        clueAbove,
        spanX: boxW / width,
        spanY: boxH / height,
        ink: blob.ink,
        fill: blob.ink / (boxW * boxH),
        touchesLeft,
        touchesTop,
        bottomLeft: corners.bottomLeft,
        topRight: corners.topRight,
        decided,
        confidence,
      })
    }
  }
  return out
}
