/**
 * Chercher la solution d'une définition dans une base existante.
 *
 * Une grille arrive ici par la photo d'un magazine : l'app connaît les
 * définitions et le nombre de cases, jamais les réponses. Les jokers ont donc
 * besoin d'un corrigé, et ce corrigé vient d'ailleurs.
 *
 * Aucun site français de solutions ne publie d'API — c'est mesuré, pas supposé
 * (voir `scripts/probe-solvers.py` et la section « Indices et solutions » du
 * README). Chaque source est donc une URL à construire et du HTML à lire, ce
 * que ce module réduit à deux fonctions par site.
 */

/** Une solution proposée pour une définition. */
export interface Candidate {
  /** En capitales sans accent, une lettre par case — comme la grille. */
  answer: string
  /** Nombre de cases occupées. Toujours `answer.length`. */
  length: number
}

export interface Solver {
  id: string
  label: string
  /**
   * `true` si le site renvoie un en-tête CORS couvrant l'origine de l'app,
   * donc s'il est appelable directement depuis la PWA sans relais.
   */
  direct: boolean
  /** L'adresse à interroger pour une définition. */
  url: (clue: string) => string
  /** Les solutions lisibles dans la page reçue. */
  parse: (html: string) => Candidate[]
}

/** « ÉGYPTE » → « EGYPTE ». Les grilles s'impriment sans accent. */
export function deaccent(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * Réduit une réponse à ce qui tient dans la grille.
 *
 * Une case porte une lettre : les espaces, apostrophes et traits d'union que
 * les sites impriment (`L'ARC`, `SAINT-OUEN`) n'en occupent aucune.
 */
export function normaliseAnswer(raw: string): string {
  return deaccent(raw).toUpperCase().replace(/[^A-Z]/g, '')
}

/** Définition → segment d'URL en minuscules-avec-tirets. */
export function slugify(clue: string): string {
  return deaccent(clue)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Les entités que le HTML français de ces sites contient en pratique. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#0*39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

/**
 * Dédoublonne en gardant l'ordre.
 *
 * L'ordre porte du sens : ces sites listent leurs solutions par pertinence, et
 * la première est celle qu'ils donnent pour « meilleure ». Un joker qui révèle
 * une lettre a intérêt à parier sur celle-là.
 */
export function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.answer)) continue
    seen.add(candidate.answer)
    out.push(candidate)
  }
  return out
}

/** Les solutions de la longueur voulue, dans l'ordre où le site les donne. */
export function ofLength(candidates: Candidate[], length: number): Candidate[] {
  return candidates.filter((candidate) => candidate.length === length)
}
