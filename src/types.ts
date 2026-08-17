/** Reading direction of an answer in the grid. */
export type Direction = 'across' | 'down'

/**
 * How a clue's arrow leaves its cell. Arrowwords ("mots fléchés") use four
 * shapes in practice — two straight and two bent:
 *
 *   right       → answer runs ACROSS, starting in the cell to the right
 *   down        ↓ answer runs DOWN,   starting in the cell below
 *   rightDown   ↱ bent: leaves to the right, then turns down;
 *                 answer runs DOWN, starting in the cell to the right
 *   downRight   ↳ bent: leaves downward, then turns right;
 *                 answer runs ACROSS, starting in the cell below
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

export const ARROW_GLYPH: Record<ArrowKind, string> = {
  right: '▶',
  down: '▼',
  rightDown: '↱',
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
   * 0–1 confidence from the import pipeline: how sure we are about the arrow
   * and the text. Anything below REVIEW_THRESHOLD is surfaced first for review.
   */
  confidence?: number
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
  /** "r,c" → data URL crop of that cell from the original photo. */
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

export const REVIEW_THRESHOLD = 0.75

export function cellKey(r: number, c: number): string {
  return `${r},${c}`
}

export function parseCellKey(key: string): { r: number; c: number } {
  const [r, c] = key.split(',')
  return { r: Number(r), c: Number(c) }
}

export const MAX_DRAFT_LETTERS = 4
