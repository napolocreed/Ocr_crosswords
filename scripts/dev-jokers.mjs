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
check('si plus rien ne colle, on aide quand même',
  pickAnswer(words(['SOLEIL']), 6, ['Z']) === 'SOLEIL',
  String(pickAnswer(words(['SOLEIL']), 6, ['Z'])))

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

console.log(`\n${failures} échec(s)\n`)
process.exit(failures ? 1 : 0)
