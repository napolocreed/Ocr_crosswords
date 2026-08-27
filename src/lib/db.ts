import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Progress, Puzzle, PuzzleAssets } from '../types'
import type { CachedClue } from './solvers/types'
import { emptyProgress } from './puzzle'

interface GrillesDB extends DBSchema {
  puzzles: {
    key: string
    value: Puzzle
    indexes: { 'by-updated': number }
  }
  progress: {
    key: string
    value: Progress
  }
  /** Cell crops and the straightened photo: only loaded by the review screen. */
  assets: {
    key: string
    value: PuzzleAssets
  }
  settings: {
    key: string
    value: unknown
  }
  /**
   * Solutions déjà trouvées pour une définition, quelle que soit la grille.
   *
   * Volontairement global plutôt que par grille : les magazines réemploient
   * beaucoup leurs définitions, si bien que le cache se remplit et qu'une grille
   * suivante se résout de plus en plus souvent sans réseau.
   */
  answers: {
    key: string
    value: CachedClue
  }
}

let dbPromise: Promise<IDBPDatabase<GrillesDB>> | null = null

function db() {
  dbPromise ??= openDB<GrillesDB>('grilles', 2, {
    upgrade(database, oldVersion) {
      // Chaque palier est gardé : une base déjà en v1 ne doit pas recréer ses
      // magasins, une base neuve doit les avoir tous.
      if (oldVersion < 1) {
        const puzzles = database.createObjectStore('puzzles', { keyPath: 'id' })
        puzzles.createIndex('by-updated', 'updatedAt')
        database.createObjectStore('progress', { keyPath: 'puzzleId' })
        database.createObjectStore('assets', { keyPath: 'puzzleId' })
        database.createObjectStore('settings')
      }
      if (oldVersion < 2) {
        database.createObjectStore('answers', { keyPath: 'clue' })
      }
    },
  })
  return dbPromise
}

export async function listPuzzles(): Promise<Puzzle[]> {
  const all = await (await db()).getAllFromIndex('puzzles', 'by-updated')
  return all.reverse() // most recently touched first
}

export async function getPuzzle(id: string): Promise<Puzzle | undefined> {
  return (await db()).get('puzzles', id)
}

export async function savePuzzle(puzzle: Puzzle): Promise<void> {
  await (await db()).put('puzzles', puzzle)
}

export async function deletePuzzle(id: string): Promise<void> {
  const database = await db()
  const tx = database.transaction(['puzzles', 'progress', 'assets'], 'readwrite')
  await Promise.all([
    tx.objectStore('puzzles').delete(id),
    tx.objectStore('progress').delete(id),
    tx.objectStore('assets').delete(id),
    tx.done,
  ])
}

export async function getAllProgress(): Promise<Map<string, Progress>> {
  const rows = await (await db()).getAll('progress')
  return new Map(rows.map((row) => [row.puzzleId, row]))
}

export async function getProgress(puzzleId: string): Promise<Progress> {
  return (await (await db()).get('progress', puzzleId)) ?? emptyProgress(puzzleId)
}

export async function saveProgress(progress: Progress): Promise<void> {
  await (await db()).put('progress', progress)
}

export async function getAssets(puzzleId: string): Promise<PuzzleAssets | undefined> {
  return (await db()).get('assets', puzzleId)
}

export async function saveAssets(assets: PuzzleAssets): Promise<void> {
  await (await db()).put('assets', assets)
}

/** Frees the photo of a reviewed puzzle while keeping the small cell crops. */
export async function dropStraightenedImage(puzzleId: string): Promise<void> {
  const assets = await getAssets(puzzleId)
  if (!assets?.straightened) return
  const { straightened: _dropped, ...rest } = assets
  await saveAssets(rest as PuzzleAssets)
}

export async function getCachedClue(key: string): Promise<CachedClue | undefined> {
  return (await db()).get('answers', key)
}

export async function saveCachedClue(entry: CachedClue): Promise<void> {
  await (await db()).put('answers', entry)
}

/** Combien de définitions ont déjà une réponse en réserve, hors-ligne. */
export async function countCachedClues(): Promise<number> {
  return (await db()).count('answers')
}

/** Vide la réserve. Le seul moyen de reprendre à zéro si le site a changé. */
export async function clearCachedClues(): Promise<void> {
  await (await db()).clear('answers')
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const value = await (await db()).get('settings', key)
  return value === undefined ? fallback : (value as T)
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await (await db()).put('settings', value, key)
}

/** Rough disk usage, when the browser is willing to tell us. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

/**
 * Asks the browser not to evict our data under storage pressure. Without this,
 * Safari in particular will throw away IndexedDB after a few weeks unused —
 * which would mean losing half-finished grids.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted?.()) return true
  return navigator.storage.persist()
}
