import {
  type Candidate,
  type Solver,
  deaccent,
  decodeEntities,
  dedupe,
  normaliseAnswer,
} from './types'

/**
 * MotsCroises.fr — la source retenue.
 *
 * C'est le seul site mesuré dont l'en-tête `Access-Control-Allow-Origin` couvre
 * l'origine GitHub Pages, **sur la page de résultats elle-même** et non
 * seulement sur l'accueil, préflight OPTIONS compris. La PWA peut donc
 * l'appeler directement : pas de relais, pas de serveur, la promesse du README
 * reste vraie. Les autres sites qui savent répondre n'envoient aucun en-tête
 * CORS et resteraient inaccessibles depuis un navigateur.
 *
 * Ses pages portent les solutions à deux endroits, et il faut les deux :
 *
 *   · l'encart de tête, groupé par longueur — c'est le seul qui couvre toutes
 *     les longueurs à la fois ;
 *   · le tableau principal, qui ne montre qu'une longueur mais donne la forme
 *     canonique de chaque mot dans son lien.
 *
 * Le reste de la page est plein de mots qui n'en sont pas : synonymes et
 * « sujets similaires » pointent vers `/sujet/…`, les solutions vers
 * `/solution/…`. Les confondre remplirait la grille de faux amis.
 */

const BASE = 'https://www.motscroises.fr'

/**
 * Le site écrit ses propres liens en capitales, apostrophe comprise :
 * `/sujet/DE-L-ASTRE-DU-JOUR`. Toutes les graphies essayées répondent, mais
 * autant demander la forme qu'il publie.
 */
export function motscroisesSlug(clue: string): string {
  return deaccent(clue)
    .toUpperCase()
    .replace(/['’]/g, '-')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function motscroisesUrl(clue: string): string {
  return `${BASE}/sujet/${motscroisesSlug(clue)}`
}

/*
 * L'encart de tête : un bloc par longueur, chacun annonçant son compte de
 * lettres avant la liste des meilleures réponses.
 *
 *   <a href="/sujet/ASTRE-DU-JOUR/6/******">
 *     <strong class="bigger-letter">6</strong> Lettres : </a>
 *   <ul class="top-results-group">
 *     <li class="best"><a title="Définition: Astre du jour">SOLEIL</a></li>
 *   </ul>
 */
const BEST_GROUP =
  /bigger-letter["'][^>]*>\s*(\d+)\s*<\/strong>[\s\S]{0,400}?<ul[^>]*top-results-group[^>]*>([\s\S]*?)<\/ul>/gi
const BEST_ITEM = /<a\b[^>]*>([^<]{1,60})<\/a>/gi

/*
 * Le tableau principal. Le lien porte la forme canonique — `/solution/SOLEIL` —
 * là où le texte peut être accentué (`PHÉBUS`), ce qui en fait la lecture la
 * plus sûre.
 */
const TABLE_START = /id=["']result-table["']/i
const TABLE_END = /id=["']synonyms["']/i
const SOLUTION_HREF = /href=["']\/solution\/([^"'/?#]+)["']/gi

/** « Astre du jour en 6 lettres » — sert de contrôle, pas de mesure. */
const TITLE_LENGTH = /\ben\s+(\d+)\s+lettres?\b/i

function take(raw: string, declared: number | null, into: Candidate[]): void {
  const answer = normaliseAnswer(decodeEntities(raw))
  if (!answer) return
  // Un désaccord entre la longueur annoncée et les lettres lues veut dire qu'on
  // ne lit pas ce qu'on croit. Perdre une solution est sans gravité ; en
  // inventer une fait révéler une mauvaise lettre, et un joker ne se rend pas.
  if (declared !== null && declared !== answer.length) return
  into.push({ answer, length: answer.length })
}

function fromBestBox(html: string): Candidate[] {
  const out: Candidate[] = []
  for (const group of html.matchAll(BEST_GROUP)) {
    const declared = Number(group[1])
    for (const item of (group[2] ?? '').matchAll(BEST_ITEM)) {
      take(item[1] ?? '', declared, out)
    }
  }
  return out
}

function fromResultTable(html: string): Candidate[] {
  const start = html.search(TABLE_START)
  if (start < 0) return []
  // S'arrêter aux synonymes : au-delà, `/sujet/…` et solutions se mélangent.
  const rest = html.slice(start)
  const stop = rest.search(TABLE_END)
  const region = stop > 0 ? rest.slice(0, stop) : rest

  const title = TITLE_LENGTH.exec(region)
  const declared = title ? Number(title[1]) : null
  const out: Candidate[] = []
  for (const match of region.matchAll(SOLUTION_HREF)) {
    take(decodeURIComponent(match[1] ?? ''), declared, out)
  }
  return out
}

export function parseMotscroises(html: string): Candidate[] {
  return dedupe([...fromBestBox(html), ...fromResultTable(html)])
}

export const motscroises: Solver = {
  id: 'motscroises',
  label: 'MotsCroises.fr',
  direct: true,
  url: motscroisesUrl,
  parse: parseMotscroises,
}
