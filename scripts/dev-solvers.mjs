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
import {
  parseMotscroises,
  motscroisesUrl,
  motscroisesSlug,
} from '../src/lib/solvers/motscroises.ts'
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

/*
 * MotsCroises.fr, page « ASTRE DU JOUR ». Recopiée du rapport, balise pour
 * balise, marqueurs Vue compris. C'est la page la plus piégeuse des deux : elle
 * répète les mêmes mots dans trois zones qui n'ont pas le même sens — les
 * solutions, les synonymes, et les « sujets similaires » — et seules les
 * premières remplissent la grille.
 */
const MC_PAGE = `<div class="col col-xl-12"><div class="best-treffer-box"><h2 class="title mt-30"> Les meilleures solutions pour Astre du jour</h2><!--[--><div><a href="/sujet/ASTRE-DU-JOUR/6/******" class="bold d-block d-md-inline"><strong class="bigger-letter">6</strong> Lettres : </a><ul class="top-results-group"><!--[--><li class="best"><a title="Définition: Astre du jour">SOLEIL</a></li><!--]--></ul></div><!--]--></div></div><!----><!---->
<div id="result-table" class="search-result-left"><div class="table-box table-responsive enable-sticky-ad"><div><div class="result-title"><!--[--><h2 class="mb-0 border-0 font-weight-normal h6"><!--[-->Astre du jour en 6 lettres <br> 1 réponse <!--]--></h2><!----><br><span class="category">Astrologie et Astronomie</span><!--]--></div><!----><!----><table class="table"><tbody><tr class="light-gray best"><td class="solution w-100 pl-0 float-none"><div class="puzzle-solution text-center w-100"><a href="/solution/SOLEIL" class="">SOLEIL</a></div></td></tr><tr class="w-100"><td class="w-100 float-none pl-0 text-center"><a class="pt-2" href="#suggestion-box"> Suggérer une autre solution </a></td></tr></tbody></table>
<div id="synonyms" class="col-12 mt-3"><h2 class="h3like">Synonymes pour ASTRE DU JOUR</h2><p> Nous avons trouvé 2 Synonymes</p><!--[--><div class="mb-10 container"><strong>Mots en 6 lettres</strong><div class="row mt-2"><!--[--><div class="col-4 col-md-3 synonym-link"><a href="/sujet/PHEBUS" class="">PHÉBUS</a></div><div class="col-4 col-md-3 synonym-link"><a href="/sujet/SOLEIL" class="">SOLEIL</a></div><!--]--></div></div><!--]--></div></div></div></div>
<div class="suggestion-solution-box"><div class="right-bottom-search related-box p25 pb20"><ul><!--[--><li><a href="/sujet/DE-L-ASTRE-DU-JOUR" class="btn related small highlited">DE L&#39;ASTRE DU JOUR <small class="dark-orange">(100%)</small></a></li><li><a href="/sujet/AU-JOUR-LE-JOUR" class="btn related small highlited">AU JOUR LE JOUR <small class="dark-orange">(68.46%)</small></a></li><!--]--></ul></div></div>`

console.log('\nMotsCroises.fr — page « ASTRE DU JOUR » (recopiée du site)')
const mc = parseMotscroises(MC_PAGE)
const mcWords = mc.map((c) => c.answer)

check('la solution est lue', mcWords.includes('SOLEIL'), mcWords.join(', '))
check('sa longueur est juste', mc.find((c) => c.answer === 'SOLEIL')?.length === 6)
check('les synonymes ne sont pas des solutions', !mcWords.includes('PHEBUS'), mcWords.join(', '))
check('les sujets similaires non plus',
  !mcWords.some((w) => w.startsWith('DEL') || w.includes('JOURLE')), mcWords.join(', '))
check('« Suggérer une autre solution » n\'est pas un mot',
  !mcWords.some((w) => w.startsWith('SUGGERER')), mcWords.join(', '))
check('rien n\'est compté deux fois', new Set(mcWords).size === mcWords.length,
  mcWords.join(', '))
check('une seule solution, comme la page l\'annonce', mc.length === 1, `${mc.length}`)

/*
 * Une page à plusieurs longueurs. Construite par analogie — la page réelle
 * d'« ASTRE DU JOUR » n'a qu'une solution — mais sur le gabarit exact de
 * l'encart de tête relevé ci-dessus, qui est justement le seul endroit du site
 * couvrant toutes les longueurs à la fois.
 */
const MC_MULTI = `<div class="best-treffer-box"><h2 class="title"> Les meilleures solutions pour Note de musique</h2><!--[-->
<div><a href="/sujet/NOTE-DE-MUSIQUE/2/**"><strong class="bigger-letter">2</strong> Lettres : </a><ul class="top-results-group"><!--[--><li class="best"><a title="Définition: Note de musique">DO</a></li><li><a title="Définition: Note de musique">RE</a></li><li><a title="Définition: Note de musique">MI</a></li><!--]--></ul></div>
<div><a href="/sujet/NOTE-DE-MUSIQUE/3/***"><strong class="bigger-letter">3</strong> Lettres : </a><ul class="top-results-group"><!--[--><li class="best"><a title="Définition: Note de musique">SOL</a></li><!--]--></ul></div>
<!--]--></div>
<div id="result-table"><div class="result-title"><h2>Note de musique en 2 lettres <br> 3 réponses</h2></div><table><tbody>
<tr><td><a href="/solution/DO">DO</a></td></tr>
<tr><td><a href="/solution/RE">RE</a></td></tr>
<tr><td><a href="/solution/UT">UT</a></td></tr>
</tbody></table></div>`

console.log('\nMotsCroises.fr — plusieurs longueurs')
const multi = parseMotscroises(MC_MULTI)
check('toutes les longueurs sont couvertes',
  ofLength(multi, 2).length === 4 && ofLength(multi, 3).length === 1,
  multi.map((c) => `${c.answer}(${c.length})`).join(' '))
check('l\'encart de tête vient avant le tableau',
  multi[0]?.answer === 'DO', multi.map((c) => c.answer).join(','))
check('le tableau complète sans doublonner',
  multi.filter((c) => c.answer === 'DO').length === 1,
  multi.map((c) => c.answer).join(','))
check('les 3 lettres ne se mélangent pas aux 2',
  ofLength(multi, 3).map((c) => c.answer).join(',') === 'SOL',
  ofLength(multi, 3).map((c) => c.answer).join(','))

console.log('\nMotsCroises.fr — formes')
check('le slug reprend la graphie du site',
  motscroisesSlug("DE L'ASTRE DU JOUR") === 'DE-L-ASTRE-DU-JOUR',
  motscroisesSlug("DE L'ASTRE DU JOUR"))
check('accents ôtés du slug',
  motscroisesSlug("FLEUVE D'ÉGYPTE") === 'FLEUVE-D-EGYPTE',
  motscroisesSlug("FLEUVE D'ÉGYPTE"))
check('URL complète',
  motscroisesUrl('ASTRE DU JOUR') === 'https://www.motscroises.fr/sujet/ASTRE-DU-JOUR',
  motscroisesUrl('ASTRE DU JOUR'))
check('page vide ne casse rien', parseMotscroises('').length === 0)
check('page sans solution ne rend rien',
  parseMotscroises('<div id="result-table"><p>Aucune solution.</p></div>').length === 0)
check('une page qui n\'a que des synonymes ne rend rien',
  parseMotscroises('<div id="synonyms"><a href="/sujet/PHEBUS">PHÉBUS</a></div>').length === 0)

console.log(`\n${failures} échec(s)\n`)
process.exit(failures ? 1 : 0)
