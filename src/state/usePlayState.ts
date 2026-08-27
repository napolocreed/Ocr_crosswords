import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MAX_DRAFT_LETTERS,
  type Progress,
  type Puzzle,
  cellKey,
} from '../types'
import { buildWords, indexWords, isComplete, type Word } from '../lib/puzzle'
import { saveProgress } from '../lib/db'
import { answerForWord, lettersOf } from '../lib/hints'
import {
  type Allowance,
  NO_SPEND,
  allowanceFor,
  pickRevealPosition,
  remainingJokers,
} from '../lib/jokers'

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

/**
 * Ce qu'un joker a donné, ou pourquoi il n'a rien donné.
 *
 * Les échecs sont distingués parce qu'ils ne se valent pas : `unavailable` veut
 * dire qu'on n'a pas pu demander, `unknown` que le site ne connaît pas la
 * définition. Ni l'un ni l'autre ne coûte de joker — on ne fait pas payer une
 * aide qu'on n'a pas rendue.
 */
export type RevealOutcome =
  | { ok: true; kind: 'letter'; letter: string }
  | { ok: true; kind: 'word'; answer: string }
  | {
      ok: false
      reason: 'no-word' | 'none-left' | 'already-solved' | 'unavailable' | 'unknown'
    }

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
  /** Jokers alloués par cette grille, et ce qu'il en reste. */
  allowance: Allowance
  remaining: Allowance
  /** Cases dont la lettre vient d'un joker. */
  revealed: ReadonlySet<string>
  setDraftMode: (value: boolean) => void
  selectCell: (r: number, c: number) => void
  selectClueCell: (r: number, c: number) => void
  typeLetter: (letter: string) => void
  backspace: () => void
  clearCell: () => void
  nextWord: () => void
  previousWord: () => void
  resetAll: () => void
  /** Dépense un indice : une lettre du mot courant. */
  revealLetter: (online: boolean) => Promise<RevealOutcome>
  /** Dépense une solution : le mot courant en entier. */
  revealWord: (online: boolean) => Promise<RevealOutcome>
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

  /*
   * L'état le plus récent, lisible hors du rendu.
   *
   * Chercher une solution prend le temps d'un aller-retour réseau, pendant lequel
   * le joueur continue de taper. Écrire à partir de l'état capturé au moment du
   * clic effacerait ces lettres-là. Tout ce qui écrit après une attente relit
   * donc cette référence.
   */
  const latest = useRef(progress)
  useEffect(() => {
    latest.current = progress
  }, [progress])

  const commit = useCallback((next: Progress) => {
    latest.current = next
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
    // Recommencer rend aussi les jokers : la grille repart vierge, l'aide avec.
    commit({
      ...progress,
      letters: {},
      drafts: {},
      revealed: [],
      spent: { ...NO_SPEND },
      updatedAt: Date.now(),
    })
    setCursor(0)
  }, [progress, commit])

  /* ------------------------------------------------------------------ jokers */

  const revealedKeys = useMemo(() => new Set(progress.revealed ?? []), [progress.revealed])
  const allowance = useMemo(() => allowanceFor(playable.length), [playable.length])
  const remaining = useMemo(
    () => remainingJokers(allowance, progress.spent),
    [allowance, progress.spent],
  )

  /** Positions du mot qu'un autre mot traverse : une lettre y sert deux fois. */
  const crossingOf = useCallback(
    (word: Word) =>
      word.cells.map(({ r, c }) => (index.byCell.get(cellKey(r, c))?.length ?? 0) > 1),
    [index],
  )

  const reveal = useCallback(
    async (word: Word | null, whole: boolean, online: boolean): Promise<RevealOutcome> => {
      if (!word || word.cells.length === 0) return { ok: false, reason: 'no-word' }

      const before = latest.current
      const left = remainingJokers(allowance, before.spent)
      if ((whole ? left.solutions : left.hints) <= 0) return { ok: false, reason: 'none-left' }

      const result = await answerForWord(word, before, new Set(before.revealed ?? []), online)
      if (!result.ok) return { ok: false, reason: result.reason }

      // Relu après l'attente : le joueur a pu remplir des cases entre-temps, et
      // les écraser avec l'état d'il y a trois secondes perdrait sa frappe.
      const current = latest.current
      const nowRevealed = new Set(current.revealed ?? [])
      const { typed } = lettersOf(word, current, nowRevealed)

      const wrong = word.cells
        .map((_, i) => i)
        .filter((i) => typed[i] !== result.answer[i])
      const positions = whole
        ? wrong
        : (() => {
            const at = pickRevealPosition(result.answer, typed, crossingOf(word))
            return at === null ? [] : [at]
          })()
      // Rien à montrer : le mot est déjà juste. Le joker reste en poche.
      if (positions.length === 0) return { ok: false, reason: 'already-solved' }

      const letters = { ...current.letters }
      const drafts = { ...current.drafts }
      for (const i of positions) {
        const cell = word.cells[i]!
        const key = cellKey(cell.r, cell.c)
        letters[key] = result.answer[i]!
        delete drafts[key]
        nowRevealed.add(key)
      }
      commit({
        ...current,
        letters,
        drafts,
        revealed: [...nowRevealed],
        spent: {
          hints: (current.spent?.hints ?? 0) + (whole ? 0 : 1),
          solutions: (current.spent?.solutions ?? 0) + (whole ? 1 : 0),
        },
        updatedAt: Date.now(),
      })
      return whole
        ? { ok: true, kind: 'word', answer: result.answer }
        : { ok: true, kind: 'letter', letter: result.answer[positions[0]!]! }
    },
    [allowance, crossingOf, commit],
  )

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
    allowance,
    remaining,
    revealed: revealedKeys,
    setDraftMode,
    selectCell,
    selectClueCell,
    typeLetter,
    backspace,
    clearCell,
    nextWord: () => stepWord(1),
    previousWord: () => stepWord(-1),
    resetAll,
    revealLetter: (online: boolean) => reveal(activeWord, false, online),
    revealWord: (online: boolean) => reveal(activeWord, true, online),
  }
}
