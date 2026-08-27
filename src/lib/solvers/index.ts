import { getCachedClue, saveCachedClue } from '../db'
import { fsolver } from './fsolver'
import { motscroises } from './motscroises'
import { type Candidate, type Solver, clueKey } from './types'

export { clueKey, ofLength } from './types'
export type { Candidate, CachedClue, Solver } from './types'

/**
 * Chercher la solution d'une définition, et s'en souvenir.
 *
 * Une seule source est réellement utilisable depuis un navigateur :
 * MotsCroises.fr est le seul site mesuré qui envoie un en-tête CORS couvrant
 * l'origine de l'app. Les autres répondent parfaitement à un script, et pas du
 * tout à une page web — le navigateur refuse de laisser lire leur réponse.
 * FSolver reste écrit et testé au cas où un relais existerait un jour ; il n'est
 * pas branché ici, et le brancher sans relais ne produirait que des erreurs.
 */

export const SOLVERS: readonly Solver[] = [motscroises, fsolver]

/** Ceux qu'un navigateur peut réellement appeler. */
export const DIRECT_SOLVERS: readonly Solver[] = SOLVERS.filter((solver) => solver.direct)

const DAY = 24 * 60 * 60 * 1000
/** Une solution de mots croisés ne change pas ; inutile de la redemander. */
const HIT_TTL = 180 * DAY
/** Une définition absente peut avoir été ajoutée depuis. */
const MISS_TTL = 7 * DAY
const TIMEOUT_MS = 8000

/**
 * D'où vient la réponse.
 *
 * `unavailable` — on n'a pas pu demander : hors-ligne, refus, ou trop lent.
 * Ce cas n'est pas un « pas de solution » et ne doit jamais coûter un joker.
 */
export type LookupOrigin = 'cache' | 'network' | 'unavailable'

export interface Lookup {
  candidates: Candidate[]
  origin: LookupOrigin
  source?: string
}

function fresh(entry: { candidates: Candidate[]; fetchedAt: number }, now: number): boolean {
  const ttl = entry.candidates.length > 0 ? HIT_TTL : MISS_TTL
  return now - entry.fetchedAt < ttl
}

async function fetchPage(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      // `omit` plutôt que le défaut : aucun cookie ne part avec la requête, et
      // le site n'a aucun moyen de suivre un joueur d'une définition à l'autre.
      credentials: 'omit',
      mode: 'cors',
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) return null
    return await response.text()
  } catch {
    // Hors-ligne, CORS refusé, délai dépassé : indistinguables depuis une page
    // web, et de toute façon traités pareil — on n'a pas pu demander.
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Les solutions connues pour une définition.
 *
 * @param online autorise l'appel réseau. Faux ⇒ on se contente de la réserve
 *   locale, ce qui est le comportement tant que le joueur n'a pas accepté que
 *   ses définitions sortent de l'appareil.
 */
export async function lookupClue(clue: string, online: boolean): Promise<Lookup> {
  const key = clueKey(clue)
  if (!key) return { candidates: [], origin: 'unavailable' }

  const now = Date.now()
  const cached = await getCachedClue(key)
  if (cached && (fresh(cached, now) || !online)) {
    return { candidates: cached.candidates, origin: 'cache', source: cached.source }
  }
  if (!online) return { candidates: [], origin: 'unavailable' }

  for (const solver of DIRECT_SOLVERS) {
    const html = await fetchPage(solver.url(clue))
    if (html === null) continue
    const candidates = solver.parse(html)
    await saveCachedClue({ clue: key, candidates, fetchedAt: now, source: solver.id })
    return { candidates, origin: 'network', source: solver.id }
  }

  // Rien n'a répondu. Une réserve périmée vaut mieux que rien, et surtout mieux
  // que de faire croire que la définition n'a pas de solution.
  if (cached) return { candidates: cached.candidates, origin: 'cache', source: cached.source }
  return { candidates: [], origin: 'unavailable' }
}

/** Vrai si la définition a déjà une réponse en réserve, utilisable hors-ligne. */
export async function isClueCached(clue: string): Promise<boolean> {
  const key = clueKey(clue)
  if (!key) return false
  const cached = await getCachedClue(key)
  return cached !== undefined && fresh(cached, Date.now())
}
