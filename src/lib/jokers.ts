import type { Spent } from '../types'
import type { Candidate } from './solvers/types'

/**
 * L'économie des jokers, et le choix de ce qu'ils révèlent.
 *
 * Tout est ici en fonctions pures : ce sont les décisions qui font la qualité de
 * l'aide — quelle solution retenir quand le site en propose plusieurs, quelle
 * lettre montrer — et elles doivent pouvoir être éprouvées sans réseau ni écran.
 */

export interface Allowance {
  /** Indices : chacun révèle une lettre. */
  hints: number
  /** Solutions : chacune révèle un mot entier. */
  solutions: number
}

export const NO_SPEND: Spent = { hints: 0, solutions: 0 }

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

/**
 * Ce qu'une grille donne comme jokers.
 *
 * Proportionné au nombre de définitions plutôt que fixe : cinq indices sur une
 * grille de douze mots la déverrouillent presque entièrement, alors que sur
 * soixante ils se remarquent à peine. Les bornes sont celles demandées — 5 à 10
 * indices, 1 à 3 solutions — et une grille moyenne de mots fléchés, une
 * trentaine de définitions, tombe à 8 et 2.
 */
export function allowanceFor(wordCount: number): Allowance {
  return {
    hints: clamp(Math.round(wordCount / 4), 5, 10),
    solutions: clamp(Math.round(wordCount / 15), 1, 3),
  }
}

export function remainingJokers(allowance: Allowance, spent: Spent | undefined): Allowance {
  return {
    hints: Math.max(0, allowance.hints - (spent?.hints ?? 0)),
    solutions: Math.max(0, allowance.solutions - (spent?.solutions ?? 0)),
  }
}

/**
 * Laquelle des solutions proposées retenir.
 *
 * Le site en donne souvent plusieurs de la bonne longueur, classées par
 * pertinence. Deux garde-fous les départagent :
 *
 *   · les lettres déjà révélées par un joker sont **certaines**, donc
 *     éliminatoires — c'est ce qui garantit qu'un second indice sur le même mot
 *     ne vienne pas d'une autre solution que le premier ;
 *   · les lettres tapées par le joueur ne sont qu'une **préférence**, jamais un
 *     filtre. Elles peuvent être fausses, et éliminer la bonne réponse sur une
 *     erreur de joueur serait le pire des deux mondes.
 *
 * @param certain lettres sûres, indexées par position dans le mot
 * @param typed lettres actuellement dans la grille, indexées de même
 */
export function pickAnswer(
  candidates: readonly Candidate[],
  length: number,
  certain: readonly (string | undefined)[] = [],
  typed: readonly (string | undefined)[] = [],
): string | null {
  const pool = candidates.filter((candidate) => candidate.length === length)
  if (pool.length === 0) return null

  const matches = (answer: string) =>
    certain.every((letter, i) => !letter || answer[i] === letter)
  const usable = pool.filter((candidate) => matches(candidate.answer))
  /*
   * Vide veut dire qu'aucune solution ne s'accorde avec une lettre déjà
   * révélée — la réserve a changé sous nos pieds entre deux jokers. On rend
   * `null` plutôt qu'une solution de repli : contredire une lettre qu'on a
   * soi-même donnée est la pire issue possible, le joueur y croit sans réserve
   * et il a payé pour elle. Sans lettre certaine, ce cas ne peut pas se
   * produire — tout le monde passe le filtre.
   */
  if (usable.length === 0) return null

  const agreement = (answer: string) =>
    typed.reduce<number>((total, letter, i) => total + (letter && answer[i] === letter ? 1 : 0), 0)

  let best = usable[0]!
  let bestScore = agreement(best.answer)
  for (const candidate of usable.slice(1)) {
    const score = agreement(candidate.answer)
    // Strictement supérieur : à égalité, l'ordre du site tranche, et il classe
    // par pertinence.
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best.answer
}

/**
 * Quelle lettre un indice doit montrer.
 *
 * Une case vide vaut mieux qu'une case fausse : le joueur qui s'est trompé
 * découvrira son erreur en butant sur le croisement, alors qu'une case vide ne
 * lui apprendrait rien tant qu'elle reste vide. À égalité, une case qui
 * appartient aussi à un autre mot est préférée — elle débloque deux définitions
 * pour le prix d'une.
 *
 * @param current lettres actuellement dans la grille, indexées par position
 * @param crossing vrai aux positions qu'un autre mot traverse
 * @returns la position à révéler, ou `null` si le mot est déjà juste partout
 */
export function pickRevealPosition(
  answer: string,
  current: readonly (string | undefined)[],
  crossing: readonly boolean[] = [],
): number | null {
  let best: number | null = null
  let bestScore = -1
  for (let i = 0; i < answer.length; i++) {
    if (current[i] === answer[i]) continue
    const score = (current[i] ? 0 : 2) + (crossing[i] ? 1 : 0)
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  }
  return best
}
