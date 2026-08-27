#!/usr/bin/env node
/**
 * Vérifie la mécanique des jokers.
 *
 *   npm run dev:jokers
 *
 * Ce sont les décisions qui font la qualité de l'aide : laquelle des solutions
 * proposées retenir, et quelle lettre montrer. Un mauvais choix ne plante pas —
 * il révèle une lettre fausse, ce qui est pire, parce que le joueur y croit et
 * qu'un joker ne se rend pas.
 */
import {
  allowanceFor,
  pickAnswer,
  pickRevealPosition,
  remainingJokers,
} from '../src/lib/jokers.ts'
import { parseMotscroises } from '../src/lib/solvers/motscroises.ts'
import { lettersOf } from '../src/lib/hints.ts'

let failures = 0

function check(label, condition, detail = '') {
  console.log(`${condition ? '  OK  ' : '  FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!condition) failures++
}

const words = (list) => list.map((answer) => ({ answer, length: answer.length }))

console.log('\nAllocation')
check('une grille moyenne donne 8 indices et 2 solutions',
  JSON.stringify(allowanceFor(32)) === '{"hints":8,"solutions":2}',
  JSON.stringify(allowanceFor(32)))
check('jamais moins de 5 indices ni de 1 solution',
  allowanceFor(1).hints === 5 && allowanceFor(1).solutions === 1,
  JSON.stringify(allowanceFor(1)))
check('jamais plus de 10 indices ni de 3 solutions',
  allowanceFor(500).hints === 10 && allowanceFor(500).solutions === 3,
  JSON.stringify(allowanceFor(500)))
check('toujours dans les bornes demandées',
  Array.from({ length: 200 }, (_, n) => allowanceFor(n)).every(
    (a) => a.hints >= 5 && a.hints <= 10 && a.solutions >= 1 && a.solutions <= 3))
check('l\'allocation croît avec la grille',
  allowanceFor(12).hints <= allowanceFor(40).hints)

console.log('\nCompte restant')
check('le dépensé se déduit',
  JSON.stringify(remainingJokers({ hints: 8, solutions: 2 }, { hints: 3, solutions: 1 }))
    === '{"hints":5,"solutions":1}')
check('sans dépense, tout reste',
  remainingJokers({ hints: 8, solutions: 2 }, undefined).hints === 8)
check('jamais négatif, même si la grille rétrécit',
  remainingJokers({ hints: 5, solutions: 1 }, { hints: 9, solutions: 4 }).hints === 0)

console.log('\nChoix de la solution')
const pool = words(['SOLEIL', 'ETOILE', 'ASTRE', 'DO'])
check('seule la bonne longueur est retenue',
  pickAnswer(pool, 5) === 'ASTRE', String(pickAnswer(pool, 5)))
check('l\'ordre du site fait foi par défaut',
  pickAnswer(pool, 6) === 'SOLEIL', String(pickAnswer(pool, 6)))
check('aucune solution de cette longueur', pickAnswer(pool, 4) === null,
  String(pickAnswer(pool, 4)))
check('liste vide', pickAnswer([], 6) === null)

check('une lettre révélée élimine les solutions incompatibles',
  pickAnswer(pool, 6, [undefined, undefined, undefined, 'I']) === 'ETOILE',
  String(pickAnswer(pool, 6, [undefined, undefined, undefined, 'I'])))
check('deux révélations restent cohérentes entre elles',
  pickAnswer(pool, 6, ['E', undefined, undefined, 'I']) === 'ETOILE',
  String(pickAnswer(pool, 6, ['E', undefined, undefined, 'I'])))

check('une lettre tapée oriente sans éliminer',
  pickAnswer(pool, 6, [], [undefined, 'T']) === 'ETOILE',
  String(pickAnswer(pool, 6, [], [undefined, 'T'])))
check('une lettre tapée FAUSSE ne fait pas perdre la bonne réponse',
  pickAnswer(words(['SOLEIL']), 6, [], ['Z', 'Z', 'Z']) === 'SOLEIL',
  String(pickAnswer(words(['SOLEIL']), 6, [], ['Z', 'Z', 'Z'])))
check('la préférence la plus forte l\'emporte',
  pickAnswer(pool, 6, [], ['E', 'T', 'O']) === 'ETOILE',
  String(pickAnswer(pool, 6, [], ['E', 'T', 'O'])))
// Le cas où la réserve a changé entre deux jokers : plus rien ne s'accorde avec
// une lettre déjà donnée. Rendre une solution de repli contredirait cette
// lettre-là — celle en qui le joueur a le plus confiance, et pour laquelle il a
// payé. On préfère ne rien rendre, et ne rien décompter.
check('rien plutôt qu\'une solution qui contredit une lettre déjà révélée',
  pickAnswer(words(['SOLEIL']), 6, ['Z']) === null,
  String(pickAnswer(words(['SOLEIL']), 6, ['Z'])))
check('sans lettre révélée, ce refus ne peut pas se déclencher',
  pickAnswer(words(['SOLEIL']), 6, [], ['Z', 'Z']) === 'SOLEIL',
  String(pickAnswer(words(['SOLEIL']), 6, [], ['Z', 'Z'])))

console.log('\nChoix de la lettre à montrer')
const empty = [undefined, undefined, undefined, undefined, undefined, undefined]
check('à égalité, la première case', pickRevealPosition('SOLEIL', empty) === 0,
  String(pickRevealPosition('SOLEIL', empty)))
check('une case vide plutôt qu\'une case fausse',
  pickRevealPosition('SOLEIL', ['Z', undefined, undefined, undefined, undefined, undefined]) === 1,
  String(pickRevealPosition('SOLEIL', ['Z', undefined, undefined, undefined, undefined, undefined])))
check('à vide égal, une case traversée par un autre mot',
  pickRevealPosition('SOLEIL', empty, [false, false, true, false, false, false]) === 2,
  String(pickRevealPosition('SOLEIL', empty, [false, false, true, false, false, false])))
check('une case déjà juste est passée',
  pickRevealPosition('SOLEIL', ['S', 'O', undefined, undefined, undefined, undefined]) === 2,
  String(pickRevealPosition('SOLEIL', ['S', 'O', undefined, undefined, undefined, undefined])))
check('un mot entièrement juste ne coûte rien',
  pickRevealPosition('SOLEIL', ['S', 'O', 'L', 'E', 'I', 'L']) === null,
  String(pickRevealPosition('SOLEIL', ['S', 'O', 'L', 'E', 'I', 'L'])))
check('une case fausse est corrigée quand il ne reste qu\'elle',
  pickRevealPosition('SOLEIL', ['S', 'O', 'L', 'E', 'I', 'Z']) === 5,
  String(pickRevealPosition('SOLEIL', ['S', 'O', 'L', 'E', 'I', 'Z'])))
check('une case vide non traversée bat une case fausse traversée',
  pickRevealPosition('SOLEIL', ['Z', undefined, undefined, undefined, undefined, undefined],
    [true, false, false, false, false, false]) === 1,
  String(pickRevealPosition('SOLEIL', ['Z', undefined, undefined, undefined, undefined, undefined],
    [true, false, false, false, false, false])))

console.log('\nDeux indices de suite sur le même mot')
/*
 * Le scénario qui casse une implémentation naïve : le premier indice vient
 * d'une solution, le second doit venir de la MÊME. Sans le filtre par lettres
 * certaines, le joueur récolterait un « E » d'ETOILE après un « S » de SOLEIL.
 */
let certain = []
let typed = []
const first = pickAnswer(pool, 6, certain, typed)
const at1 = pickRevealPosition(first, typed)
certain[at1] = first[at1]
typed[at1] = first[at1]
const second = pickAnswer(pool, 6, certain, typed)
const at2 = pickRevealPosition(second, typed)
check('la seconde lettre vient de la même solution', first === second, `${first} puis ${second}`)
check('et d\'une autre case', at1 !== at2, `${at1} puis ${at2}`)
check('les deux lettres forment bien un début de mot',
  `${first[at1]}${second[at2]}` === 'SO', `${first[at1]}${second[at2]}`)

console.log('\nLecture de la grille')
/*
 * `lettersOf` est la couture entre l'état de jeu et la mécanique : elle traduit
 * un mot et une progression en deux tableaux indexés par position. Une erreur
 * d'un cran ici décalerait toutes les lettres révélées.
 */
const word = {
  id: 'w1',
  clueId: 'c1',
  clueText: 'ASTRE DU JOUR',
  arrow: 'right',
  direction: 'across',
  origin: { r: 0, c: 0 },
  cells: [
    { r: 0, c: 1 }, { r: 0, c: 2 }, { r: 0, c: 3 },
    { r: 0, c: 4 }, { r: 0, c: 5 }, { r: 0, c: 6 },
  ],
}
const progress = {
  puzzleId: 'p',
  letters: { '0,1': 'S', '0,3': 'Z' },
  drafts: {},
  updatedAt: 0,
}
const seen = lettersOf(word, progress, new Set(['0,1']))
// JSON.stringify rend `undefined` en `null` dans un tableau : la comparaison
// porte donc sur cette forme-là, pas sur le littéral d'origine.
check('les lettres suivent l\'ordre de lecture du mot',
  JSON.stringify(seen.typed) === '["S",null,"Z",null,null,null]',
  JSON.stringify(seen.typed))
check('seule la case révélée est certaine',
  seen.certain[0] === 'S' && seen.certain[2] === undefined,
  JSON.stringify(seen.certain))
check('une case vide reste vide des deux côtés',
  seen.typed[1] === undefined && seen.certain[1] === undefined)

console.log('\nDe la page réelle à la lettre montrée')
/*
 * La chaîne complète, sans réseau : le HTML capturé sur motscroises.fr, lu par
 * le parseur, puis conduit jusqu'à la case que l'indice révélera. C'est la
 * couture que les tests unitaires des deux bouts ne couvrent pas.
 */
const REAL = `<div class="best-treffer-box"><h2 class="title"> Les meilleures solutions pour Astre du jour</h2><!--[--><div><a href="/sujet/ASTRE-DU-JOUR/6/******" class="bold d-block d-md-inline"><strong class="bigger-letter">6</strong> Lettres : </a><ul class="top-results-group"><!--[--><li class="best"><a title="Définition: Astre du jour">SOLEIL</a></li><!--]--></ul></div><!--]--></div>
<div id="result-table" class="search-result-left"><div class="result-title"><h2>Astre du jour en 6 lettres <br> 1 réponse</h2></div><table class="table"><tbody><tr class="light-gray best"><td class="solution"><div class="puzzle-solution"><a href="/solution/SOLEIL" class="">SOLEIL</a></div></td></tr></tbody></table>
<div id="synonyms"><h2>Synonymes pour ASTRE DU JOUR</h2><div class="synonym-link"><a href="/sujet/PHEBUS" class="">PHÉBUS</a></div></div></div>`

const parsed = parseMotscroises(REAL)
const chain = pickAnswer(parsed, 6, seen.certain, seen.typed)
check('la page réelle donne bien SOLEIL', chain === 'SOLEIL', String(chain))
check('le synonyme PHÉBUS n\'a pas contaminé le choix',
  !parsed.some((c) => c.answer === 'PHEBUS'), parsed.map((c) => c.answer).join(','))

// La case 0 porte déjà « S », juste ; la case 2 porte « Z », faux ; le reste est
// vide. L'indice doit préférer une case vide — donc ni 0 ni 2.
const at = pickRevealPosition(chain, seen.typed)
check('l\'indice évite la case déjà juste et la case fausse',
  at === 1, `case ${at}`)
check('et il montre la bonne lettre', chain[at] === 'O', chain[at])

console.log(`\n${failures} échec(s)\n`)
process.exit(failures ? 1 : 0)
