import {
  type Candidate,
  type Solver,
  decodeEntities,
  dedupe,
  normaliseAnswer,
  slugify,
} from './types'

/**
 * FSolver — lecture des solutions d'une définition.
 *
 * Mesuré sur quatre définitions dont la réponse était connue d'avance : le site
 * répond aux quatre, et il balise ses résultats en microdonnées schema.org,
 * ce qui vaut mieux qu'une classe CSS — une page peut se refaire une apparence
 * sans toucher à son balisage sémantique.
 *
 *     <span class='letter2px' itemprop='acceptedAnswer' itemscope
 *           itemtype='https://schema.org/Answer'>
 *       <a itemprop='url' href='https://www.fsolver.fr/definition/NIL'>
 *         <span itemprop='text'>NIL</span>
 *       </a>
 *     </span>
 *     <span class='color3'>(3)</span>
 *
 * Il n'envoie aucun en-tête CORS : la PWA ne peut pas l'appeler directement,
 * il lui faut un relais.
 */

/*
 * Trois formes d'URL répondent — espaces en `*`, ponctuation en `*`, ou
 * minuscules-avec-tirets. La dernière est retenue : c'est la seule qui ne
 * demande aucun encodage, donc la seule qui ne peut pas se déformer en chemin.
 * Vérifié : `/mots-fleches/fleuve-d-egypte` renvoie bien la page de NIL.
 */
export function fsolverUrl(clue: string): string {
  return `https://www.fsolver.fr/mots-fleches/${slugify(clue)}`
}

/** La réponse elle-même. */
const ANSWER = /itemprop=["']text["']\s*>([^<]{1,60})<\/span>/gi

/*
 * Le nombre de lettres que le site annonce, juste après. Il ne sert pas à
 * mesurer — `answer.length` le fait mieux, puisque c'est le nombre de cases —
 * mais à repérer une lecture qui dérape : si les deux cessent de s'accorder,
 * c'est que la page a changé de forme et que le parseur lit à côté.
 */
const DECLARED = /class=["']color\d+["'][^>]*>\s*\((\d+)\)/i
const DECLARED_WINDOW = 160

export function parseFsolver(html: string): Candidate[] {
  const found: Candidate[] = []
  for (const match of html.matchAll(ANSWER)) {
    const answer = normaliseAnswer(decodeEntities(match[1] ?? ''))
    if (!answer) continue
    const from = (match.index ?? 0) + match[0].length
    const declared = DECLARED.exec(html.slice(from, from + DECLARED_WINDOW))
    // Un désaccord veut dire qu'on n'a pas lu ce qu'on croit : mieux vaut
    // perdre une solution que d'en inventer une, un joker ne se rattrape pas.
    if (declared && Number(declared[1]) !== answer.length) continue
    found.push({ answer, length: answer.length })
  }
  return dedupe(found)
}

export const fsolver: Solver = {
  id: 'fsolver',
  label: 'FSolver',
  direct: false,
  url: fsolverUrl,
  parse: parseFsolver,
}
