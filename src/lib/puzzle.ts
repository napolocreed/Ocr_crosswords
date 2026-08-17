import {
  type Cell,
  type Clue,
  type Mystery,
  type Progress,
  type Puzzle,
  type Word,
  arrowDirection,
  arrowStartOffset,
  cellKey,
} from '../types'

export type { Word }

export function makeId(prefix = ''): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}${Date.now().toString(36)}${rand}`
}

export function emptyCells(rows: number, cols: number): Cell[] {
  return Array.from({ length: rows * cols }, () => ({ kind: 'letter' }) as Cell)
}

export function cellAt(puzzle: Puzzle, r: number, c: number): Cell | undefined {
  if (r < 0 || c < 0 || r >= puzzle.rows || c >= puzzle.cols) return undefined
  return puzzle.cells[r * puzzle.cols + c]
}

/**
 * Resizes a grid, keeping whatever cells still fit. Used when the detected
 * dimensions turn out to be off by a row or a column.
 */
export function resizeGrid(puzzle: Puzzle, rows: number, cols: number): Puzzle {
  const cells: Cell[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push(cellAt(puzzle, r, c) ?? { kind: 'letter' })
    }
  }
  return { ...puzzle, rows, cols, cells }
}

/**
 * Expands every clue into the squares its answer covers. An answer runs from
 * the arrow's start offset until it hits a non-letter cell or the grid edge.
 */
export function buildWords(puzzle: Puzzle): Word[] {
  const words: Word[] = []
  for (let r = 0; r < puzzle.rows; r++) {
    for (let c = 0; c < puzzle.cols; c++) {
      const cell = cellAt(puzzle, r, c)
      if (!cell || cell.kind !== 'clue' || !cell.clues) continue
      for (const clue of cell.clues) {
        const direction = arrowDirection(clue.arrow)
        const { dr, dc } = arrowStartOffset(clue.arrow)
        const step = direction === 'across' ? { dr: 0, dc: 1 } : { dr: 1, dc: 0 }
        const cells: { r: number; c: number }[] = []
        let rr = r + dr
        let cc = c + dc
        while (cellAt(puzzle, rr, cc)?.kind === 'letter') {
          cells.push({ r: rr, c: cc })
          rr += step.dr
          cc += step.dc
        }
        words.push({
          id: `${clue.id}`,
          clueId: clue.id,
          clueText: clue.text,
          arrow: clue.arrow,
          direction,
          origin: { r, c },
          cells,
        })
      }
    }
  }
  return words
}

/** Index of words by the cells they cover, for hit-testing taps on the grid. */
export interface WordIndex {
  words: Word[]
  byCell: Map<string, Word[]>
  byId: Map<string, Word>
}

export function indexWords(words: Word[]): WordIndex {
  const byCell = new Map<string, Word[]>()
  const byId = new Map<string, Word>()
  for (const word of words) {
    byId.set(word.id, word)
    for (const { r, c } of word.cells) {
      const key = cellKey(r, c)
      const list = byCell.get(key)
      if (list) list.push(word)
      else byCell.set(key, [word])
    }
  }
  return { words, byCell, byId }
}

/** Every letter square that at least one clue points at. */
export function countAnswerCells(puzzle: Puzzle): number {
  let n = 0
  for (const cell of puzzle.cells) if (cell.kind === 'letter') n++
  return n
}

export function countFilled(puzzle: Puzzle, progress: Progress | undefined): number {
  if (!progress) return 0
  let n = 0
  for (let r = 0; r < puzzle.rows; r++) {
    for (let c = 0; c < puzzle.cols; c++) {
      if (cellAt(puzzle, r, c)?.kind !== 'letter') continue
      if (progress.letters[cellKey(r, c)]) n++
    }
  }
  return n
}

export function progressRatio(puzzle: Puzzle, progress: Progress | undefined): number {
  const total = countAnswerCells(puzzle)
  if (total === 0) return 0
  return countFilled(puzzle, progress) / total
}

/** Letter squares no clue points at — usually a sign of a wrong arrow. */
export function findOrphanCells(puzzle: Puzzle, index: WordIndex): { r: number; c: number }[] {
  const orphans: { r: number; c: number }[] = []
  for (let r = 0; r < puzzle.rows; r++) {
    for (let c = 0; c < puzzle.cols; c++) {
      if (cellAt(puzzle, r, c)?.kind !== 'letter') continue
      if (!index.byCell.has(cellKey(r, c))) orphans.push({ r, c })
    }
  }
  return orphans
}

export function allClues(puzzle: Puzzle): { r: number; c: number; clue: Clue }[] {
  const out: { r: number; c: number; clue: Clue }[] = []
  for (let r = 0; r < puzzle.rows; r++) {
    for (let c = 0; c < puzzle.cols; c++) {
      const cell = cellAt(puzzle, r, c)
      if (cell?.kind !== 'clue' || !cell.clues) continue
      for (const clue of cell.clues) out.push({ r, c, clue })
    }
  }
  return out
}

/** Replaces one clue in place, returning a new puzzle. */
export function updateClue(
  puzzle: Puzzle,
  clueId: string,
  patch: Partial<Omit<Clue, 'id'>>,
): Puzzle {
  const cells = puzzle.cells.map((cell) => {
    if (cell.kind !== 'clue' || !cell.clues?.some((cl) => cl.id === clueId)) return cell
    return {
      ...cell,
      clues: cell.clues.map((cl) => (cl.id === clueId ? { ...cl, ...patch } : cl)),
    }
  })
  return { ...puzzle, cells, updatedAt: Date.now() }
}

export function setCellKind(puzzle: Puzzle, r: number, c: number, kind: Cell['kind']): Puzzle {
  const i = r * puzzle.cols + c
  const current = puzzle.cells[i]
  if (!current) return puzzle
  const cells = puzzle.cells.slice()
  if (kind === 'clue') {
    cells[i] = {
      kind: 'clue',
      clues: current.clues?.length
        ? current.clues
        : [{ id: makeId('cl_'), text: '', arrow: 'right', confidence: 0 }],
    }
  } else {
    cells[i] = { kind }
  }
  return { ...puzzle, cells, updatedAt: Date.now() }
}

export function emptyProgress(puzzleId: string): Progress {
  return { puzzleId, letters: {}, drafts: {}, updatedAt: Date.now() }
}

export function isComplete(puzzle: Puzzle, progress: Progress | undefined): boolean {
  const total = countAnswerCells(puzzle)
  return total > 0 && countFilled(puzzle, progress) === total
}

/* --------------------------------------------------------------- mystery word */

/** Position (1-based) of each square that feeds the mystery answer. */
export function mysteryPositions(puzzle: Puzzle): Map<string, number> {
  const positions = new Map<string, number>()
  puzzle.mystery?.slots.forEach((key, i) => {
    if (key) positions.set(key, i + 1)
  })
  return positions
}

/**
 * The mystery answer as it currently stands, one entry per position. Empty
 * strings are letters still to be found, so the caller can render the gaps.
 */
export function readMysteryAnswer(
  puzzle: Puzzle,
  progress: Progress | undefined,
): string[] {
  const slots = puzzle.mystery?.slots ?? []
  return slots.map((key) => (key ? (progress?.letters[key] ?? '') : ''))
}

export function mysteryIsComplete(puzzle: Puzzle, progress: Progress | undefined): boolean {
  const answer = readMysteryAnswer(puzzle, progress)
  return answer.length > 0 && answer.every(Boolean)
}

/** Adds a mystery word to a grid, or clears it. */
export function setMystery(puzzle: Puzzle, mystery: Mystery | undefined): Puzzle {
  const next = { ...puzzle, updatedAt: Date.now() }
  if (mystery) next.mystery = mystery
  else delete next.mystery
  return next
}

/**
 * Assigns a square to the mystery answer, or unassigns it.
 *
 * Tapping an unassigned square appends it to the next free position; tapping an
 * assigned one removes it and closes the gap, so the numbering stays contiguous
 * without the user having to renumber anything by hand.
 */
export function toggleMysterySlot(puzzle: Puzzle, r: number, c: number): Puzzle {
  if (cellAt(puzzle, r, c)?.kind !== 'letter') return puzzle
  const key = cellKey(r, c)
  const current = puzzle.mystery ?? { clue: '', slots: [] }
  const existing = current.slots.indexOf(key)
  const slots =
    existing >= 0
      ? current.slots.filter((_, i) => i !== existing)
      : [...current.slots, key]
  return setMystery(puzzle, { ...current, slots })
}

/** Grows or shrinks the answer length, keeping the squares already pointed out. */
export function resizeMystery(puzzle: Puzzle, length: number): Puzzle {
  const current = puzzle.mystery ?? { clue: '', slots: [] }
  const clamped = Math.max(0, Math.min(40, length))
  const slots = current.slots.slice(0, clamped)
  while (slots.length < clamped) slots.push(null)
  return setMystery(puzzle, { ...current, slots })
}
