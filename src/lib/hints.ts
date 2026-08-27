import { type Progress, cellKey } from '../types'
import { pickAnswer } from './jokers'
import type { Word } from './puzzle'
import { type LookupOrigin, lookupClue } from './solvers'

/**
 * Trouver la réponse d'une définition, pour que les jokers aient de quoi
 * révéler.
 *
 * Un point de conception qui tient tout le reste : le corrigé se résout **avant**
 * que le joueur ne voie quoi que ce soit, et ne s'affiche jamais. Si l'app se
 * contentait d'ouvrir le site dans un onglet, le joueur lirait le mot entier et
 * l'indice « une lettre » n'aurait plus aucun sens.
 */

export interface WordLetters {
  /** Ce qui est dans la grille, position par position. */
  typed: (string | undefined)[]
  /** Ce qui vient d'un joker, donc certain. */
  certain: (string | undefined)[]
}

export function lettersOf(
  word: Word,
  progress: Progress,
  revealed: ReadonlySet<string>,
): WordLetters {
  const typed: (string | undefined)[] = []
  const certain: (string | undefined)[] = []
  for (const cell of word.cells) {
    const key = cellKey(cell.r, cell.c)
    const letter = progress.letters[key]
    typed.push(letter)
    certain.push(revealed.has(key) ? letter : undefined)
  }
  return { typed, certain }
}

export type AnswerResult =
  | { ok: true; answer: string; origin: LookupOrigin }
  /** On n'a pas pu demander — hors-ligne, refusé, trop lent. Ne coûte rien. */
  | { ok: false; reason: 'unavailable' }
  /** On a demandé : le site ne connaît pas cette définition, ou pas à cette longueur. */
  | { ok: false; reason: 'unknown' }

export async function answerForWord(
  word: Word,
  progress: Progress,
  revealed: ReadonlySet<string>,
  online: boolean,
): Promise<AnswerResult> {
  if (word.cells.length === 0 || !word.clueText.trim()) return { ok: false, reason: 'unknown' }

  const { candidates, origin } = await lookupClue(word.clueText, online)
  if (origin === 'unavailable') return { ok: false, reason: 'unavailable' }

  const { typed, certain } = lettersOf(word, progress, revealed)
  const answer = pickAnswer(candidates, word.cells.length, certain, typed)
  return answer ? { ok: true, answer, origin } : { ok: false, reason: 'unknown' }
}

export interface PrefetchProgress {
  /** Définitions traitées. */
  done: number
  total: number
  /** Définitions pour lesquelles une solution est désormais en réserve. */
  found: number
}

/**
 * Met en réserve les solutions de toute une grille.
 *
 * L'app se joue dans le train, donc l'aide doit pouvoir s'y jouer aussi. Une
 * pause sépare les requêtes : c'est le navigateur d'une personne qui interroge
 * un site gratuit, pas un moissonneur.
 */
const PREFETCH_GAP_MS = 250

export async function prefetchAnswers(
  words: readonly Word[],
  online: boolean,
  onProgress: (progress: PrefetchProgress) => void,
  signal?: AbortSignal,
): Promise<PrefetchProgress> {
  const wanted = words.filter((word) => word.cells.length > 0 && word.clueText.trim())
  // Une même définition peut apparaître deux fois dans une grille ; le cache le
  // rattraperait, mais autant ne pas la compter deux fois dans la progression.
  const seen = new Set<string>()
  const unique = wanted.filter((word) => {
    const key = word.clueText.trim().toUpperCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const state: PrefetchProgress = { done: 0, total: unique.length, found: 0 }
  onProgress({ ...state })

  for (const word of unique) {
    if (signal?.aborted) break
    /*
     * `lookupClue` sert aussi pour ce qui est déjà en réserve : il rend le cache
     * sans rien demander, et surtout il dit s'il y a vraiment une solution.
     * Se fier à « la définition est en cache » comptait comme prête une
     * définition dont on avait justement appris que le site ne l'a pas, et
     * annonçait au joueur une réserve qu'il n'avait pas.
     */
    const { candidates, origin } = await lookupClue(word.clueText, online)
    state.done++
    if (candidates.length > 0) state.found++
    onProgress({ ...state })
    if (signal?.aborted) break
    // Aucune pause quand rien n'est parti sur le réseau : la politesse concerne
    // le site, pas la base locale.
    if (origin === 'network') {
      await new Promise((resolve) => setTimeout(resolve, PREFETCH_GAP_MS))
    }
  }
  return { ...state }
}
