import {
  adaptiveThreshold,
  cropRgba,
  downscaleGray,
  preprocessForOcr,
  rotateRgba,
  toGray,
  warpPerspectiveRgba,
  type Quad,
  type RgbaImage,
} from './image'
import {
  detectGrid,
  textOrientationScore,
  type DetectedCell,
  type DetectionResult,
} from './gridDetect'
import { OcrEngine, looksLikeWords, scoreClueText } from './ocr'
import { toBlob, toDataUrl, nextFrame } from './canvas'
import {
  type ArrowKind,
  type Cell,
  type Clue,
  type Puzzle,
  type PuzzleAssets,
  cellKey,
} from '../types'
import { makeId } from './puzzle'

/**
 * Orchestrates photo → puzzle, in the browser.
 *
 * The pipeline is deliberately split in two: {@link analyseStructure} is fast
 * and can be re-run every time the user nudges a crop corner, while
 * {@link readDefinitions} is the slow OCR pass, run once the structure is
 * settled. That split is what makes the crop step feel immediate.
 */

/** Working resolution for detection: enough detail, bounded cost. */
const DETECT_DIM = 1400
/** Resolution the OCR crops are taken from: the more pixels the better. */
const CROP_DIM = 2600

export interface StructureAnalysis {
  detection: DetectionResult
  /** The straightened image the crops come from. */
  cropSource: RgbaImage
  /** Scale from detection coordinates to `cropSource` coordinates. */
  cropScale: number
  /** Straightened image at detection resolution, for previews. */
  preview: RgbaImage
  /**
   * True when the definitions appear to read top-to-bottom: the photo was taken
   * sideways and needs a quarter turn before OCR can make sense of it.
   */
  looksSideways: boolean
}

/** Straightens the photo and detects the grid. Cheap enough to re-run live. */
export async function analyseStructure(
  photo: RgbaImage,
  quad: Quad,
  quarterTurns = 0,
): Promise<StructureAnalysis> {
  const oriented = quarterTurns ? rotateRgba(photo, quarterTurns) : photo
  const quadW = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y)
  const quadH = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y)

  const detectScale = DETECT_DIM / Math.max(quadW, quadH)
  const preview = warpPerspectiveRgba(
    oriented,
    quad,
    Math.max(16, Math.round(quadW * detectScale)),
    Math.max(16, Math.round(quadH * detectScale)),
  )
  await nextFrame()

  const bin = adaptiveThreshold(toGray(preview), 0.05, 0.12)
  await nextFrame()
  const detection = detectGrid(bin)
  await nextFrame()
  const orientation = textOrientationScore(bin, detection.cells)

  const cropScaleTarget = CROP_DIM / Math.max(quadW, quadH)
  // Never upsample beyond the source: that would only cost memory.
  const cropScale = Math.min(cropScaleTarget, 1) === cropScaleTarget ? cropScaleTarget : 1
  const cropSource = warpPerspectiveRgba(
    oriented,
    quad,
    Math.max(16, Math.round(quadW * cropScale)),
    Math.max(16, Math.round(quadH * cropScale)),
  )

  return {
    detection,
    cropSource,
    cropScale: cropScale / detectScale,
    preview,
    // A clear margin, so an ambiguous grid never nags the user.
    looksSideways: orientation < -0.08,
  }
}

/**
 * Picks each clue cell's arrows.
 *
 * Geometry does most of the work: an arrow can only point at a letter square, so
 * a clue cell with just one letter neighbour has no ambiguity at all. The image
 * evidence (a printed arrowhead biting into the border) is used to break ties,
 * and where it stays silent the conventional layout is assumed — which the
 * review step then lets the user correct in one tap.
 */
function chooseArrows(
  cell: DetectedCell,
  kindAt: (r: number, c: number) => Cell['kind'] | undefined,
  clueCount: number,
): { arrows: ArrowKind[]; confidence: number } {
  const rightOpen = kindAt(cell.r, cell.c + 1) === 'letter'
  const downOpen = kindAt(cell.r + 1, cell.c) === 'letter'
  const rightSeen = cell.arrowRight >= 0.45
  const downSeen = cell.arrowDown >= 0.45

  if (clueCount >= 2) {
    // Two definitions in one square must feed two different answers.
    if (rightOpen && downOpen) return { arrows: ['right', 'down'], confidence: 0.7 }
    if (rightOpen) return { arrows: ['right', 'rightDown'], confidence: 0.35 }
    if (downOpen) return { arrows: ['down', 'downRight'], confidence: 0.35 }
    return { arrows: ['right', 'down'], confidence: 0.15 }
  }

  if (rightOpen && !downOpen) return { arrows: ['right'], confidence: rightSeen ? 0.95 : 0.85 }
  if (downOpen && !rightOpen) return { arrows: ['down'], confidence: downSeen ? 0.95 : 0.85 }
  if (rightOpen && downOpen) {
    if (rightSeen && !downSeen) return { arrows: ['right'], confidence: 0.8 }
    if (downSeen && !rightSeen) return { arrows: ['down'], confidence: 0.8 }
    // Nothing decisive: the arrow is most often the one going right.
    return { arrows: ['right'], confidence: 0.4 }
  }
  return { arrows: ['right'], confidence: 0.1 }
}

/** Builds a puzzle skeleton with empty definitions, ready for OCR or hand entry. */
export function buildPuzzleFromDetection(
  detection: DetectionResult,
  title: string,
): Puzzle {
  const { rows, cols } = detection
  const kindAt = (r: number, c: number) =>
    r < 0 || c < 0 || r >= rows || c >= cols ? undefined : detection.cells[r * cols + c]?.kind

  const cells: Cell[] = detection.cells.map((detected) => {
    if (detected.kind !== 'clue') return { kind: detected.kind }
    const clueCount = detected.split !== undefined ? 2 : 1
    const { arrows, confidence } = chooseArrows(detected, kindAt, clueCount)
    const clues: Clue[] = arrows.slice(0, clueCount).map((arrow) => ({
      id: makeId('cl_'),
      text: '',
      arrow,
      confidence,
    }))
    return { kind: 'clue', clues }
  })

  const now = Date.now()
  return {
    id: makeId('pz_'),
    title,
    rows,
    cols,
    cells,
    createdAt: now,
    updatedAt: now,
    reviewed: false,
  }
}

/** The regions of one clue cell that hold a single definition each. */
function clueRegions(cell: DetectedCell, clueCount: number) {
  const padX = (cell.x1 - cell.x0) * 0.07
  const padY = (cell.y1 - cell.y0) * 0.07
  if (clueCount < 2 || cell.split === undefined) {
    return [{ x0: cell.x0 + padX, y0: cell.y0 + padY, x1: cell.x1 - padX, y1: cell.y1 - padY }]
  }
  const splitY = cell.y0 + cell.split * (cell.y1 - cell.y0)
  return [
    { x0: cell.x0 + padX, y0: cell.y0 + padY, x1: cell.x1 - padX, y1: splitY - padY * 0.5 },
    { x0: cell.x0 + padX, y0: splitY + padY * 0.5, x1: cell.x1 - padX, y1: cell.y1 - padY },
  ]
}

export interface OcrProgress {
  /** Cells finished so far. */
  done: number
  total: number
  /** Latest text read, for a live preview. */
  lastText?: string
}

/**
 * Reads every definition and stores a crop of each clue cell so the review
 * screen can show the original next to the text — which is what makes
 * correcting fast, and means the magazine is only needed once.
 */
export async function readDefinitions(
  puzzle: Puzzle,
  analysis: StructureAnalysis,
  engine: OcrEngine,
  onProgress?: (progress: OcrProgress) => void,
): Promise<{ puzzle: Puzzle; assets: PuzzleAssets; quality: ReadQuality }> {
  const { detection, cropSource, cropScale } = analysis
  const crops: Record<string, string> = {}
  const cells = puzzle.cells.slice()

  const clueCells = detection.cells.filter((cell) => {
    const target = cells[cell.r * puzzle.cols + cell.c]
    return target?.kind === 'clue'
  })

  let done = 0
  for (const detected of clueCells) {
    const index = detected.r * puzzle.cols + detected.c
    const target = cells[index]
    if (target?.kind !== 'clue' || !target.clues) continue

    // Whole-cell crop for the review screen.
    const whole = cropRgba(
      cropSource,
      detected.x0 * cropScale,
      detected.y0 * cropScale,
      detected.x1 * cropScale,
      detected.y1 * cropScale,
    )
    crops[cellKey(detected.r, detected.c)] = await toDataUrl(whole, 360)

    const regions = clueRegions(detected, target.clues.length)
    const clues: Clue[] = []
    for (let i = 0; i < target.clues.length; i++) {
      const existing = target.clues[i]!
      const region = regions[Math.min(i, regions.length - 1)]!
      const crop = cropRgba(
        cropSource,
        region.x0 * cropScale,
        region.y0 * cropScale,
        region.x1 * cropScale,
        region.y1 * cropScale,
      )
      const prepared = preprocessForOcr(crop)
      const blob = await toBlob(prepared, 0.95)
      let text = ''
      let confidence = 0
      try {
        const result = await engine.recognize(blob)
        text = result.text
        confidence = result.confidence
      } catch {
        // A single unreadable cell must not abort the whole import.
        text = ''
      }
      clues.push({
        ...existing,
        text,
        confidence: Math.min(existing.confidence ?? 1, scoreClueText(text, confidence)),
      })
      onProgress?.({ done, total: clueCells.length, lastText: text })
    }
    cells[index] = { kind: 'clue', clues }
    done++
    onProgress?.({ done, total: clueCells.length })
    await nextFrame()
  }

  const straightened = await toBlob(analysis.preview, 0.75)
  return {
    puzzle: { ...puzzle, cells, updatedAt: Date.now() },
    assets: { puzzleId: puzzle.id, crops, straightened },
    quality: assessRead(cells),
  }
}

export interface ReadQuality {
  /** Definitions that came back non-empty. */
  read: number
  /** Of those, how many look like real words. */
  plausible: number
  /**
   * True when almost nothing readable came out. The usual cause is a photo that
   * is upside down: Tesseract reports high confidence on inverted type, so this
   * group-level check is the only thing that catches it.
   */
  suspect: boolean
}

function assessRead(cells: Cell[]): ReadQuality {
  let read = 0
  let plausible = 0
  for (const cell of cells) {
    for (const clue of cell.clues ?? []) {
      if (!clue.text) continue
      read++
      if (looksLikeWords(clue.text)) plausible++
    }
  }
  return {
    read,
    plausible,
    suspect: read >= 8 && plausible / read < 0.3,
  }
}

/** Small preview for the library list. */
export async function makeThumbnail(preview: RgbaImage): Promise<string> {
  return toDataUrl(preview, 240, 0.6)
}

/** Suggests a starting crop: the page content, trimmed of its dark surroundings. */
export function suggestQuad(photo: RgbaImage): Quad {
  const gray = downscaleGray(toGray(photo), 700)
  const bin = adaptiveThreshold(gray, 0.06, 0.12)
  const scale = photo.width / gray.width

  // Column/row ink profiles, trimmed at both ends: the grid and its text are
  // dense, the background around the page is not.
  const cols = new Int32Array(bin.width)
  const rows = new Int32Array(bin.height)
  for (let y = 0; y < bin.height; y++) {
    for (let x = 0; x < bin.width; x++) {
      if (bin.data[y * bin.width + x]) {
        cols[x]!++
        rows[y]!++
      }
    }
  }
  const span = (profile: Int32Array, limit: number) => {
    let total = 0
    for (let i = 0; i < limit; i++) total += profile[i]!
    const cut = total * 0.02
    let acc = 0
    let lo = 0
    let hi = limit - 1
    for (let i = 0; i < limit; i++) {
      acc += profile[i]!
      if (acc >= cut) {
        lo = i
        break
      }
    }
    acc = 0
    for (let i = limit - 1; i >= 0; i--) {
      acc += profile[i]!
      if (acc >= cut) {
        hi = i
        break
      }
    }
    return [lo, hi] as const
  }
  const [x0, x1] = span(cols, bin.width)
  const [y0, y1] = span(rows, bin.height)
  return [
    { x: x0 * scale, y: y0 * scale },
    { x: x1 * scale, y: y0 * scale },
    { x: x1 * scale, y: y1 * scale },
    { x: x0 * scale, y: y1 * scale },
  ]
}
