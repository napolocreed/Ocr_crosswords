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
  refineSplits,
  textOrientationScore,
  trimUnusedEdges,
  type DetectedCell,
  type DetectionResult,
} from './gridDetect'
import {
  detectArrows,
  groupArrowsByClue,
  type ArrowDetection,
  type ArrowEvidence,
} from './arrowDetect'
import { OcrEngine, looksLikeWords, scoreClueText } from './ocr'
import { toBlob, toDataUrl, nextFrame } from './canvas'
import {
  type ArrowKind,
  type Cell,
  arrowDirection,
  arrowStartOffset,
  type Clue,
  type Puzzle,
  type PuzzleAssets,
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
  /** The arrows read off the page, bends included. */
  arrowDetection: ArrowDetection
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

  const previewGray = toGray(preview)
  const bin = adaptiveThreshold(previewGray, 0.05, 0.12)
  await nextFrame()
  // Classification needs the greyscale as well as the binary: absolute darkness
  // is what separates print from the reverse page showing through.
  const detected = detectGrid(bin, previewGray)
  await nextFrame()
  const orientation = textOrientationScore(bin, detected.cells)

  // Arrows first, then peel the phantom border rows the boundary walk tends to
  // add past the print, then read the arrows again on the grid that remains.
  const firstPass = detectArrows(bin, detected)
  const detection = trimUnusedEdges(detected, reachableSquares(detected, firstPass.arrows))
  const arrowDetection =
    detection === detected ? firstPass : detectArrows(bin, detection)
  await nextFrame()

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
    /*
     * Only warn when the evidence is unambiguous. Measured in both orientations
     * on two photos: the flat page separates cleanly (+0.73 upright, -0.67
     * sideways), but the bowed one gives no signal at all (+0.06 upright, +0.23
     * sideways — the wrong way round). A threshold tight enough to catch that
     * page would fire on correctly-oriented photos, and a warning that tells you
     * to rotate an already-upright photo is worse than staying quiet. Silence is
     * the honest answer when there is no signal; the post-OCR plausibility check
     * catches a misread page afterwards either way.
     */
    looksSideways: orientation < -0.25,
    arrowDetection,
  }
}

/** Squares an arrow actually reaches, as "r,c" keys. */
function reachableSquares(
  detection: DetectionResult,
  arrows: readonly { clue: { r: number; c: number }; kind: ArrowKind }[],
): Set<string> {
  const at = (r: number, c: number) =>
    r < 0 || c < 0 || r >= detection.rows || c >= detection.cols
      ? undefined
      : detection.cells[r * detection.cols + c]
  const reachable = new Set<string>()
  for (const arrow of arrows) {
    const direction = arrowDirection(arrow.kind)
    const { dr, dc } = arrowStartOffset(arrow.kind)
    const step = direction === 'across' ? { dr: 0, dc: 1 } : { dr: 1, dc: 0 }
    let r = arrow.clue.r + dr
    let c = arrow.clue.c + dc
    while (at(r, c)?.kind === 'letter') {
      reachable.add(`${r},${c}`)
      r += step.dr
      c += step.dc
    }
  }
  return reachable
}

/**
 * Re-reads the internal hairlines from the high-resolution crop source.
 *
 * Kept out of {@link analyseStructure} on purpose: that runs on every nudge of a
 * crop corner and has to stay quick, whereas this only matters once, at the
 * moment the grid is committed.
 */
export function refineStructure(analysis: StructureAnalysis): DetectionResult {
  return refineSplits(toGray(analysis.cropSource), analysis.detection, analysis.cropScale)
}

/**
 * Picks each clue cell's arrows.
 *
 * The printed glyphs are the authority: `arrowDetect` reads them off the page,
 * which is the only way to tell a bend from a straight arrow — both start in the
 * same square, so geometry alone cannot separate `down` from `downRight`.
 *
 * Geometry remains the fallback for squares whose glyph was too faint or too
 * tangled with a rule to read, and it still resolves the common easy case: an
 * arrow can only point at a fillable square.
 */
function chooseArrows(
  cell: DetectedCell,
  kindAt: (r: number, c: number) => Cell['kind'] | undefined,
  clueCount: number,
  evidence: ArrowEvidence[] | undefined,
): { arrows: ArrowKind[]; confidence: number } {
  if (evidence && evidence.length > 0) {
    const kinds = evidence.map((item) => item.kind)
    const weakest = Math.min(...evidence.map((item) => item.confidence))
    if (kinds.length >= clueCount) {
      return { arrows: kinds.slice(0, clueCount), confidence: weakest }
    }
    // One glyph read but two definitions stacked. The list must still come back
    // at full length: a missing entry would drop a definition from the puzzle
    // altogether, so it would never be read, shown or correctable.
    return {
      arrows: padArrows(kinds, clueCount, cell, kindAt),
      confidence: Math.min(weakest, 0.4),
    }
  }

  const rightOpen = kindAt(cell.r, cell.c + 1) === 'letter'
  const downOpen = kindAt(cell.r + 1, cell.c) === 'letter'

  if (clueCount >= 2) {
    // Two definitions in one square must feed two different answers.
    if (rightOpen && downOpen) return { arrows: ['right', 'down'], confidence: 0.5 }
    if (rightOpen) return { arrows: ['right', 'rightDown'], confidence: 0.3 }
    if (downOpen) return { arrows: ['down', 'downRight'], confidence: 0.3 }
    return { arrows: ['right', 'down'], confidence: 0.15 }
  }
  if (rightOpen && !downOpen) return { arrows: ['right'], confidence: 0.7 }
  if (downOpen && !rightOpen) return { arrows: ['down'], confidence: 0.7 }
  // Nothing decisive: the arrow is most often the one going right.
  if (rightOpen && downOpen) return { arrows: ['right'], confidence: 0.35 }
  return { arrows: ['right'], confidence: 0.1 }
}

/**
 * Tops a kind list up to `count` entries, preferring arrows that point at a
 * fillable square and avoiding kinds already used by the same square.
 */
function padArrows(
  kinds: ArrowKind[],
  count: number,
  cell: DetectedCell,
  kindAt: (r: number, c: number) => Cell['kind'] | undefined,
): ArrowKind[] {
  const out = [...kinds]
  const used = new Set(kinds)
  const rightOpen = kindAt(cell.r, cell.c + 1) === 'letter'
  const downOpen = kindAt(cell.r + 1, cell.c) === 'letter'
  // Most plausible first: a straight arrow into an open square, then the bent
  // forms, then anything at all rather than returning a short list.
  const preference: ArrowKind[] = [
    ...(rightOpen ? (['right'] as ArrowKind[]) : []),
    ...(downOpen ? (['down'] as ArrowKind[]) : []),
    ...(rightOpen ? (['rightDown'] as ArrowKind[]) : []),
    ...(downOpen ? (['downRight'] as ArrowKind[]) : []),
    'right',
    'down',
  ]
  for (const candidate of preference) {
    if (out.length >= count) break
    if (used.has(candidate)) continue
    used.add(candidate)
    out.push(candidate)
  }
  // Still short only if every kind is taken, which cannot happen for count <= 4.
  while (out.length < count) out.push('right')
  return out
}

/** Builds a puzzle skeleton with empty definitions, ready for OCR or hand entry. */
export function buildPuzzleFromDetection(
  detection: DetectionResult,
  title: string,
  arrowDetection?: ArrowDetection,
): Puzzle {
  const { rows, cols } = detection
  const byClue = groupArrowsByClue(arrowDetection?.arrows ?? [])
  const kindAt = (r: number, c: number) =>
    r < 0 || c < 0 || r >= rows || c >= cols ? undefined : detection.cells[r * cols + c]?.kind

  const cells: Cell[] = detection.cells.map((detected) => {
    if (detected.kind !== 'clue') return { kind: detected.kind }
    const clueCount = detected.split !== undefined ? 2 : 1
    const { arrows, confidence } = chooseArrows(
      detected,
      kindAt,
      clueCount,
      byClue.get(`${detected.r},${detected.c}`),
    )
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

    // Whole-cell crop for the review screen, filed under every definition the
    // square carries so the pairing survives later structural edits.
    const whole = cropRgba(
      cropSource,
      detected.x0 * cropScale,
      detected.y0 * cropScale,
      detected.x1 * cropScale,
      detected.y1 * cropScale,
    )
    const wholeUrl = await toDataUrl(whole, 360)
    for (const clue of target.clues) crops[clue.id] = wholeUrl

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
