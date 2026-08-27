#!/usr/bin/env node
/**
 * Vérifie les parseurs de solutions contre du HTML réellement observé.
 *
 *   npm run dev:solvers
 *
 * Les extraits ci-dessous ne sont pas inventés : ils viennent du rapport de
 * `scripts/probe-solvers.py`, qui interroge chaque site sur des définitions dont
 * la réponse est connue d'avance et joint le HTML autour de chaque réponse
 * trouvée. Un parseur écrit sur du HTML supposé se casse à la première page
 * réelle ; celui-ci est écrit sur la page réelle.
 */
import { parseFsolver, fsolverUrl } from '../src/lib/solvers/fsolver.ts'
import { normaliseAnswer, ofLength, slugify } from '../src/lib/solvers/types.ts'

let failures = 0

function check(label, condition, detail = '') {
  console.log(`${condition ? '  OK  ' : '  FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!condition) failures++
}

/*
 * FSolver, page « ASTRE DU JOUR ». Structure recopiée du rapport : microdonnées
 * schema.org pour la réponse, `<span class='colorN'>(N)</span>` pour la
 * longueur. Le bloc JSON-LD du haut est conservé exprès — c'est le piège de
 * cette page, il contient les mêmes mots dans des liens qui ne sont pas des
 * résultats, et le parseur ne doit pas les compter.
 */
const entry = (word, length) =>
  `<div class='elemTable bg-white'> <span class='letter2px' itemprop='acceptedAnswer' ` +
  `itemscope itemtype='https://schema.org/Answer'> <a itemprop='url' ` +
  `href='https://www.fsolver.fr/definition/${word}'><span itemprop='text'>${word}</span></a> ` +
  `</span> <span class='color${length}'>(${length})</span> </div>`

const FSOLVER_PAGE = `<!DOCTYPE html><html lang="fr"><head>
<title> ASTRE DU JOUR - mots crois&eacute;s - 20 solutions de 2 &agrave; 9 lettres | FSolver </title>
<script type="application/ld+json">{ "@type":"Question",
 "name":"Quelles sont les solutions pour ASTRE DU JOUR ?",
 "acceptedAnswer": { "@type":"Answer", "text":"Voici une liste des meilleures et des plus
 r&eacute;centes propositions de d&eacute;finition ASTRE DU JOUR . <br /><strong>Notre meilleure
 solution : </strong> <a href='https://www.fsolver.fr/mots-fleches/SOLEIL'>SOLEIL</a>" } }
</script></head><body>
${entry('SOLEIL', 6)}
${entry('ETOILE', 6)}
${entry('ASTRE', 5)}
${entry('L&#039;ARC', 4)}
${entry('SAINT-OUEN', 9)}
${entry('CASSE', 7)}
${entry('QUASAR', 6)}
<a href='https://www.fsolver.fr/mots-fleches/SOLEIL'>SOLEIL</a>
</body></html>`

console.log('\nFSolver — page « ASTRE DU JOUR »')
const candidates = parseFsolver(FSOLVER_PAGE)
const words = candidates.map((c) => c.answer)

check('les solutions sont lues', words.length > 0, words.join(', '))
check('la meilleure solution vient en tête', words[0] === 'SOLEIL', String(words[0]))
check('la longueur vaut le nombre de cases',
  candidates.every((c) => c.length === c.answer.length))
check('le JSON-LD n\'est pas pris pour un résultat',
  words.filter((w) => w === 'SOLEIL').length === 1,
  `${words.filter((w) => w === 'SOLEIL').length} occurrence(s)`)
check('le lien nu de bas de page non plus', words.length === 6, `${words.length} lues`)
check('l\'apostrophe encodée est décodée et ne prend pas de case',
  words.includes('LARC'), words.join(', '))
check('le trait d\'union ne prend pas de case non plus',
  words.includes('SAINTOUEN'), words.join(', '))
check('une longueur annoncée qui ne colle pas fait rejeter l\'entrée',
  !words.includes('CASSE'), words.join(', '))
check('filtrage par longueur',
  ofLength(candidates, 6).map((c) => c.answer).join(',') === 'SOLEIL,ETOILE,QUASAR',
  ofLength(candidates, 6).map((c) => c.answer).join(','))

console.log('\nFormes')
check('slug sans accent ni ponctuation',
  slugify("FLEUVE D'ÉGYPTE") === 'fleuve-d-egypte', slugify("FLEUVE D'ÉGYPTE"))
check('URL FSolver mesurée comme répondante',
  fsolverUrl("FLEUVE D'ÉGYPTE") === 'https://www.fsolver.fr/mots-fleches/fleuve-d-egypte',
  fsolverUrl("FLEUVE D'ÉGYPTE"))
check('réponse réduite aux cases', normaliseAnswer("l'arc-en-ciel") === 'LARCENCIEL',
  normaliseAnswer("l'arc-en-ciel"))
check('page vide ne casse rien', parseFsolver('').length === 0)
check('page sans balisage ne rend rien',
  parseFsolver('<p>Aucun résultat pour cette définition.</p>').length === 0)

console.log(`\n${failures} échec(s)\n`)
process.exit(failures ? 1 : 0)
