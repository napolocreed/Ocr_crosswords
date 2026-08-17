import type { Progress, Puzzle } from '../types'
import { getAllProgress, getPuzzle, listPuzzles, saveProgress, savePuzzle } from './db'
import { makeId } from './puzzle'

/**
 * Export/import of grids as a single JSON file — the "take a few with me"
 * feature. Kept deliberately plain so a pack can be mailed to yourself, dropped
 * in a cloud folder, or shared with someone else's phone.
 */

const FORMAT = 'grilles.pack'
const VERSION = 1

export interface Pack {
  format: typeof FORMAT
  version: number
  exportedAt: number
  puzzles: Puzzle[]
  /** Answers so far, only for the grids included. Optional on import. */
  progress?: Progress[]
}

export async function buildPack(
  puzzleIds: string[],
  includeProgress: boolean,
): Promise<Pack> {
  const puzzles: Puzzle[] = []
  for (const id of puzzleIds) {
    const puzzle = await getPuzzle(id)
    if (puzzle) puzzles.push(puzzle)
  }
  const pack: Pack = {
    format: FORMAT,
    version: VERSION,
    exportedAt: Date.now(),
    puzzles,
  }
  if (includeProgress) {
    const all = await getAllProgress()
    pack.progress = puzzles.map((puzzle) => all.get(puzzle.id)).filter((p): p is Progress => !!p)
  }
  return pack
}

export function packFilename(pack: Pack): string {
  const date = new Date(pack.exportedAt).toISOString().slice(0, 10)
  const count = pack.puzzles.length
  return `grilles-${date}-${count}grille${count > 1 ? 's' : ''}.json`
}

/** Offers the pack to the user: the share sheet when available, else a download. */
export async function sharePack(pack: Pack): Promise<'shared' | 'downloaded'> {
  const json = JSON.stringify(pack)
  const filename = packFilename(pack)
  const file = new File([json], filename, { type: 'application/json' })

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Grilles de mots fléchés' })
      return 'shared'
    } catch (error) {
      // The user dismissed the sheet, or sharing files is unsupported here.
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared'
    }
  }

  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return 'downloaded'
}

export interface ImportOutcome {
  added: number
  skipped: number
}

/**
 * Reads a pack file. Grids already present are kept as-is rather than
 * overwritten, so importing the same pack twice cannot wipe your answers; a grid
 * whose id clashes with a *different* grid is stored under a fresh id.
 */
export async function importPack(file: Blob): Promise<ImportOutcome> {
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Ce fichier n’est pas un pack de grilles valide.')
  }
  const pack = parsed as Partial<Pack>
  if (pack.format !== FORMAT || !Array.isArray(pack.puzzles)) {
    throw new Error('Ce fichier n’est pas un pack de grilles valide.')
  }
  if ((pack.version ?? 0) > VERSION) {
    throw new Error('Ce pack vient d’une version plus récente de l’application.')
  }

  const existing = new Map((await listPuzzles()).map((puzzle) => [puzzle.id, puzzle]))
  const progressById = new Map((pack.progress ?? []).map((row) => [row.puzzleId, row]))
  let added = 0
  let skipped = 0

  for (const incoming of pack.puzzles) {
    if (!isPuzzleShaped(incoming)) {
      skipped++
      continue
    }
    const clash = existing.get(incoming.id)
    if (clash) {
      // Same grid already here: leave the local copy and its answers alone.
      if (clash.rows === incoming.rows && clash.cols === incoming.cols) {
        skipped++
        continue
      }
      const freshId = makeId('pz_')
      const progress = progressById.get(incoming.id)
      await savePuzzle({ ...incoming, id: freshId })
      if (progress) await saveProgress({ ...progress, puzzleId: freshId })
      added++
      continue
    }
    await savePuzzle(incoming)
    const progress = progressById.get(incoming.id)
    if (progress) await saveProgress(progress)
    added++
  }

  return { added, skipped }
}

function isPuzzleShaped(value: unknown): value is Puzzle {
  if (!value || typeof value !== 'object') return false
  const puzzle = value as Partial<Puzzle>
  return (
    typeof puzzle.id === 'string' &&
    typeof puzzle.title === 'string' &&
    Number.isInteger(puzzle.rows) &&
    Number.isInteger(puzzle.cols) &&
    Array.isArray(puzzle.cells) &&
    puzzle.cells.length === (puzzle.rows ?? 0) * (puzzle.cols ?? 0)
  )
}
