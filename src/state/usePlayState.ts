import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MAX_DRAFT_LETTERS,
  type Progress,
  type Puzzle,
  cellKey,
} from '../types'
import { buildWords, indexWords, isComplete, type Word } from '../lib/puzzle'
import { saveProgress } from '../lib/db'

/**
 * Solving state: which square is active, what gets typed where, and when it is
 * written to disk.
 *
 * Everything is keyed on the *word* rather than the square, because that is how
 * a solver thinks — you fill an answer, not a coordinate — and it makes
 * auto-advance, direction switching and the clue bar fall out naturally.
 */

/** Autosave delay: long enough to coalesce fast typing, short enough to be safe. */
const SAVE_DEBOUNCE_MS = 400

export interface PlayState {
  progress: Progress
  words: Word[]
  index: ReturnType<typeof indexWords>
  activeWord: Word | null
  activeCell: { r: number; c: number } | null
  cursor: number
  draftMode: boolean
  complete: boolean
  filled: number
  total: number
  setDraftMode: (value: boolean) => void
  selectCell: (r: number, c: number) => void
  selectClueCell: (r: number, c: number) => void
  typeLetter: (letter: string) => void
  backspace: () => void
  clearCell: () => void
  nextWord: () => void
  previousWord: () => void
  resetAll: () => void
}

export function usePlayState(puzzle: Puzzle, initialProgress: Progress): PlayState {
  const [progress, setProgress] = useState(initialProgress)
  const [draftMode, setDraftMode] = useState(false)
  const [activeWordId, setActiveWordId] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)

  const words = useMemo(() => buildWords(puzzle), [puzzle])
  const index = useMemo(() => indexWords(words), [words])

  // Answers with at least one square; a clue pointing nowhere is not playable.
  const playable = useMemo(() => words.filter((word) => word.cells.length > 0), [words])

  useEffect(() => {
    setProgress(initialProgress)
  }, [initialProgress])

  // Start on the first answer so the first keypress always lands somewhere.
  useEffect(() => {
    if (activeWordId === null && playable.length > 0) {
      setActiveWordId(playable[0]!.id)
      setCursor(0)
    }
  }, [activeWordId, playable])

  const activeWord = useMemo(
    () => (activeWordId ? (index.byId.get(activeWordId) ?? null) : null),
    [activeWordId, index],
  )

  const activeCell = useMemo(() => {
    if (!activeWord || activeWord.cells.length === 0) return null
    return activeWord.cells[Math.min(cursor, activeWord.cells.length - 1)] ?? null
  }, [activeWord, cursor])

  /* ------------------------------------------------------------- persistence */

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<Progress | null>(null)

  const commit = useCallback((next: Progress) => {
    setProgress(next)
    pending.current = next
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      if (pending.current) void saveProgress(pending.current)
      pending.current = null
    }, SAVE_DEBOUNCE_MS)
  }, [])

  // Never lose the last keystrokes when the app is backgrounded or closed.
  useEffect(() => {
    const flush = () => {
      if (!pending.current) return
      void saveProgress(pending.current)
      pending.current = null
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  /* ---------------------------------------------------------------- selection */

  const selectCell = useCallback(
    (r: number, c: number) => {
      const candidates = index.byCell.get(cellKey(r, c))
      if (!candidates || candidates.length === 0) return
      const position = (word: Word) =>
        word.cells.findIndex((cell: { r: number; c: number }) => cell.r === r && cell.c === c)

      // Tapping inside the current answer just moves the cursor; tapping the
      // same square again switches to the crossing answer.
      if (activeWord && candidates.some((word) => word.id === activeWord.id)) {
        const here = position(activeWord)
        if (here >= 0 && here !== cursor) {
          setCursor(here)
          return
        }
        const other = candidates.find((word) => word.id !== activeWord.id)
        if (other) {
          setActiveWordId(other.id)
          setCursor(Math.max(0, position(other)))
          return
        }
        setCursor(Math.max(0, here))
        return
      }
      const chosen = candidates[0]!
      setActiveWordId(chosen.id)
      setCursor(Math.max(0, position(chosen)))
    },
    [index, activeWord, cursor],
  )

  const selectClueCell = useCallback(
    (r: number, c: number) => {
      const cell = puzzle.cells[r * puzzle.cols + c]
      if (cell?.kind !== 'clue' || !cell.clues?.length) return
      const ids = cell.clues.map((clue) => clue.id)
      // A square holding two definitions cycles between them.
      const current = ids.indexOf(activeWordId ?? '')
      const nextId = ids[(current + 1) % ids.length]!
      const word = index.byId.get(nextId)
      if (!word) return
      setActiveWordId(word.id)
      setCursor(0)
    },
    [puzzle, index, activeWordId],
  )

  const stepWord = useCallback(
    (delta: number) => {
      if (playable.length === 0) return
      const current = playable.findIndex((word) => word.id === activeWordId)
      const next = playable[(current + delta + playable.length) % playable.length]!
      setActiveWordId(next.id)
      setCursor(0)
    },
    [playable, activeWordId],
  )

  /* ------------------------------------------------------------------ typing */

  const typeLetter = useCallback(
    (letter: string) => {
      if (!activeWord || !activeCell) return
      const key = cellKey(activeCell.r, activeCell.c)
      const upper = letter.toUpperCase()

      if (draftMode) {
        const current = progress.drafts[key] ?? []
        const drafts = { ...progress.drafts }
        // Tapping a candidate again removes it, so doubt can be walked back.
        const next = current.includes(upper)
          ? current.filter((candidate) => candidate !== upper)
          : [...current, upper].slice(-MAX_DRAFT_LETTERS)
        if (next.length === 0) delete drafts[key]
        else drafts[key] = next
        // Noting a candidate on a filled square means having second thoughts
        // about it, so the confirmed letter gives way to the doubt.
        const letters = { ...progress.letters }
        delete letters[key]
        commit({ ...progress, letters, drafts, updatedAt: Date.now() })
        return
      }

      const letters = { ...progress.letters, [key]: upper }
      // A confirmed letter supersedes the doubts recorded for that square.
      const drafts = { ...progress.drafts }
      delete drafts[key]
      commit({ ...progress, letters, drafts, updatedAt: Date.now() })
      if (cursor < activeWord.cells.length - 1) setCursor(cursor + 1)
    },
    [activeWord, activeCell, draftMode, progress, cursor, commit],
  )

  const backspace = useCallback(() => {
    if (!activeWord || !activeCell) return
    const key = cellKey(activeCell.r, activeCell.c)
    const hasContent = progress.letters[key] || progress.drafts[key]
    if (hasContent) {
      const letters = { ...progress.letters }
      const drafts = { ...progress.drafts }
      delete letters[key]
      delete drafts[key]
      commit({ ...progress, letters, drafts, updatedAt: Date.now() })
      return
    }
    // Empty square: step back and clear the one before it.
    if (cursor > 0) {
      const previous = activeWord.cells[cursor - 1]
      setCursor(cursor - 1)
      if (previous) {
        const previousKey = cellKey(previous.r, previous.c)
        const letters = { ...progress.letters }
        const drafts = { ...progress.drafts }
        delete letters[previousKey]
        delete drafts[previousKey]
        commit({ ...progress, letters, drafts, updatedAt: Date.now() })
      }
    }
  }, [activeWord, activeCell, cursor, progress, commit])

  const clearCell = useCallback(() => {
    if (!activeCell) return
    const key = cellKey(activeCell.r, activeCell.c)
    const letters = { ...progress.letters }
    const drafts = { ...progress.drafts }
    delete letters[key]
    delete drafts[key]
    commit({ ...progress, letters, drafts, updatedAt: Date.now() })
  }, [activeCell, progress, commit])

  const resetAll = useCallback(() => {
    commit({ ...progress, letters: {}, drafts: {}, updatedAt: Date.now() })
    setCursor(0)
  }, [progress, commit])

  /* --------------------------------------------------------------- reporting */

  const total = useMemo(
    () => puzzle.cells.filter((cell) => cell.kind === 'letter').length,
    [puzzle],
  )
  const filled = useMemo(() => {
    let n = 0
    for (const key of Object.keys(progress.letters)) {
      const [r, c] = key.split(',').map(Number)
      if (r === undefined || c === undefined) continue
      if (puzzle.cells[r * puzzle.cols + c]?.kind === 'letter') n++
    }
    return n
  }, [progress.letters, puzzle])

  const complete = useMemo(() => isComplete(puzzle, progress), [puzzle, progress])

  // Stamp the finish time once, the first time the grid is full.
  useEffect(() => {
    if (complete && !progress.completedAt) {
      const next = { ...progress, completedAt: Date.now() }
      setProgress(next)
      void saveProgress(next)
    }
  }, [complete, progress])

  return {
    progress,
    words,
    index,
    activeWord,
    activeCell,
    cursor,
    draftMode,
    complete,
    filled,
    total,
    setDraftMode,
    selectCell,
    selectClueCell,
    typeLetter,
    backspace,
    clearCell,
    nextWord: () => stepWord(1),
    previousWord: () => stepWord(-1),
    resetAll,
  }
}
