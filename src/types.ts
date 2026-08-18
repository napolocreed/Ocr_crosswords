/** Reading direction of an answer in the grid. */
export type Direction = 'across' | 'down'

/**
 * How a clue's arrow leaves its cell. Arrowwords ("mots fléchés") use four
 * shapes in practice — two straight and two bent:
 *
 *   right       →  answer runs ACROSS, starting in the cell to the right
 *   down        ↓  answer runs DOWN,   starting in the cell below
 *   rightDown   ↴  bent: leaves to the right, then turns down;
 *                  answer runs DOWN, starting in the cell to the right
 *   downRight   ↳  bent: leaves downward, then turns right;
 *                  answer runs ACROSS, starting in the cell below
 *
 * Only these two bends exist, because an answer only ever reads left-to-right or
 * top-to-bottom: a bend that turned upwards or leftwards would point at an
 * answer nothing could read.
 */
export type ArrowKind = 'right' | 'down' | 'rightDown' | 'downRight'

export const ARROW_KINDS: readonly ArrowKind[] = ['right', 'down', 'rightDown', 'downRight']

/** Direction the answer of a clue with this arrow runs in. */
export function arrowDirection(arrow: ArrowKind): Direction {
  return arrow === 'right' || arrow === 'downRight' ? 'across' : 'down'
}

/** Offset from the clue cell to the answer's first letter. */
export function arrowStartOffset(arrow: ArrowKind): { dr: number; dc: number } {
  switch (arrow) {
    case 'right':
    case 'rightDown':
      return { dr: 0, dc: 1 }
    case 'down':
    case 'downRight':
      return { dr: 1, dc: 0 }
  }
}

/**
 * Glyphs matching what the magazines actually print: a stroke leaving the square,
 * turning a right angle where the arrow is bent, ending in a head.
 *
 * `rightDown` was wrong until a reader pointed it out. It showed `↱`, which is
 * Unicode's *upwards* arrow with tip rightwards — up-then-right, a direction that
 * cannot occur in an arrowword at all. The correct character is `↴`, rightwards
 * arrow with corner downwards. The straight pair are line arrows rather than
 * solid triangles for the same reason: the printed arrows have a shaft, and the
 * four then read as one family.
 */
export const ARROW_GLYPH: Record<ArrowKind, string> = {
  right: '→',
  down: '↓',
  rightDown: '↴',
  downRight: '↳',
}

export const ARROW_LABEL: Record<ArrowKind, string> = {
  right: 'vers la droite',
  down: 'vers le bas',
  rightDown: 'à droite puis vers le bas',
  downRight: 'en bas puis vers la droite',
}

/**
 * A single definition. A clue cell carries one or two of these (magazines
 * routinely stack two definitions in one cell, split by a hairline).
 */
export interface Clue {
  id: string
  text: string
  arrow: ArrowKind
  /**
   * 0–1 confidence in the *text*, from the import pipeline.
   *
   * Kept apart from {@link arrowConfidence} on purpose. These were one number
   * once, the smaller of the two, and that made the review flag nearly useless:
   * an arrow that had to be guessed from geometry — routine, and something the
   * reader settles at a glance — dragged a perfectly read definition below the
   * threshold. Measured against two hand-transcribed pages, 24 of 27 and 17 of 23
   * flagged rows were flagged over nothing.
   */
  confidence?: number
  /** 0–1 confidence in the arrow, which is a separate question from the text. */
  arrowConfidence?: number
  /** True once a human has looked at this clue in the review screen. */
  reviewed?: boolean
}

/**
 * letter — an empty square the player fills in
 * clue   — a shaded square holding one or two definitions
 * block  — dead square (solid black or outside the grid's shape)
 */
export type CellKind = 'letter' | 'clue' | 'block'

export interface Cell {
  kind: CellKind
  /** Present when kind === 'clue'. One or two definitions. */
  clues?: Clue[]
}

/**
 * The bonus answer many magazines add alongside the grid: a definition printed
 * in the margin, whose answer is spelled by the letters of a handful of numbered
 * squares, read in numbered order.
 *
 * Nothing is stored for the answer itself — it is read straight off the grid, so
 * it fills in on its own as the grid gets solved.
 */
export interface Mystery {
  /** The definition printed in the margin. */
  clue: string
  /**
   * Squares feeding the answer, in order: `slots[0]` is letter 1. A null slot is
   * a position whose square has not been pointed out yet.
   */
  slots: (string | null)[]
}

export interface Puzzle {
  id: string
  title: string
  /** Free-form origin note, e.g. "Télé 7 Jeux n°312". */
  source?: string
  rows: number
  cols: number
  /** rows × cols, row-major. */
  cells: Cell[]
  /** Small JPEG data URL of the straightened grid, for the library list. */
  thumbnail?: string
  createdAt: number
  updatedAt: number
  /** False until the user finishes the review step. */
  reviewed: boolean
  /** Present when the grid comes with a mystery word. */
  mystery?: Mystery
}

/** A player's state for one puzzle. Kept apart from the puzzle itself so a
 *  puzzle can be shared or re-imported without dragging answers along. */
export interface Progress {
  puzzleId: string
  /** "r,c" → single uppercase letter. */
  letters: Record<string, string>
  /** "r,c" → candidate letters shown small and grey (draft mode). */
  drafts: Record<string, string[]>
  updatedAt: number
  completedAt?: number
}

/** Per-puzzle heavy assets, stored separately to keep library loads light. */
export interface PuzzleAssets {
  puzzleId: string
  /**
   * Clue id → data URL crop of the square that definition came from.
   *
   * Keyed by clue id rather than by "r,c" on purpose. Trimming a stray row or
   * column off the top or left of the grid shifts every cell's coordinates,
   * which silently pointed each definition at a *neighbour's* crop — so the
   * review screen showed the wrong original beside the text, defeating the whole
   * point of showing it. A clue id travels with its cell through any edit.
   *
   * Both definitions of a stacked square share the same crop.
   */
  crops: Record<string, string>
  /** The straightened grid photo, kept as a reference while reviewing. */
  straightened?: Blob
}

/** A derived answer slot: one clue plus the squares it fills. */
export interface Word {
  id: string
  clueId: string
  clueText: string
  arrow: ArrowKind
  direction: Direction
  /** Cell of the clue that defines this word. */
  origin: { r: number; c: number }
  /** Letter cells in reading order. Empty if the arrow points nowhere. */
  cells: { r: number; c: number }[]
}

/**
 * Text score below which a definition is put in front of the reader.
 *
 * Chosen from the measured trade-off rather than picked round. Swept over three
 * hand-transcribed pages, on the one that actually contains mistakes the score
 * separates well only at the bottom of its range: at 0.30 it raises three alarms
 * and all three are real, at 0.40 five alarms for four real, and by 0.50 eleven
 * alarms for the same four. It was 0.75, which cost sixteen alarms to catch six.
 *
 * The number is low because a false alarm is not free — it is a row read,
 * compared and dismissed — and because the errors it misses are the recoverable
 * kind: a misread definition is still visible while solving and can be fixed
 * then. The errors that are *not* recoverable are structural, and those are
 * flagged on their own evidence rather than on this score.
 */
export const REVIEW_THRESHOLD = 0.45

export function cellKey(r: number, c: number): string {
  return `${r},${c}`
}

export function parseCellKey(key: string): { r: number; c: number } {
  const [r, c] = key.split(',')
  return { r: Number(r), c: Number(c) }
}

export const MAX_DRAFT_LETTERS = 4
