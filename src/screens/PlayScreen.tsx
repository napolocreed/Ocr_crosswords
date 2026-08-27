import { useEffect, useMemo, useState } from 'react'
import { ARROW_GLYPH, ARROW_LABEL, type Progress, type Puzzle } from '../types'
import { GridView } from '../components/GridView'
import { Keyboard } from '../components/Keyboard'
import { MysteryBar } from '../components/MysteryBar'
import { HintsSheet } from '../components/HintsSheet'
import { type RevealOutcome, usePlayState } from '../state/usePlayState'
import { Sheet } from '../components/Sheet'
import { mysteryPositions, readMysteryAnswer } from '../lib/puzzle'
import { buildShareLink, offerShareLink } from '../lib/shareLink'
import { getSetting } from '../lib/db'
import { CONSENT_SETTING } from '../lib/solvers'

/** Ce qu'on dit au joueur, sans jamais laisser croire qu'un joker a été perdu. */
function outcomeMessage(outcome: RevealOutcome): string {
  if (outcome.ok) {
    return outcome.kind === 'letter'
      ? `Lettre révélée : ${outcome.letter}`
      : `Solution : ${outcome.answer}`
  }
  switch (outcome.reason) {
    case 'no-word':
      return 'Touche d’abord une définition'
    case 'none-left':
      return 'Plus de joker de ce type sur cette grille'
    case 'already-solved':
      return 'Ce mot est déjà juste — joker non décompté'
    case 'unavailable':
      return 'Recherche impossible (réseau) — joker non décompté'
    case 'unknown':
      return 'Solution inconnue pour cette définition — joker non décompté'
  }
}

interface Props {
  puzzle: Puzzle
  progress: Progress
  onBack: () => void
  onReview: () => void
  onToast: (message: string) => void
}

/**
 * The solving screen: grid, definition of the current answer, keyboard.
 *
 * The clue bar between the two is load-bearing. In an arrowword the definition
 * is printed inside a square at a size no phone can render legibly at fit-to-
 * screen zoom, so the active one is repeated here at a readable size.
 */
export function PlayScreen({ puzzle, progress, onBack, onReview, onToast }: Props) {
  const play = usePlayState(puzzle, progress)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mysteryOpen, setMysteryOpen] = useState(false)
  const [hintsOpen, setHintsOpen] = useState(false)
  const [online, setOnline] = useState(false)
  const [seeking, setSeeking] = useState(false)

  useEffect(() => {
    void getSetting(CONSENT_SETTING, false).then(setOnline)
  }, [])

  const spend = async (whole: boolean) => {
    // Premier usage : le panneau explique ce qui part de l'appareil, et attend
    // une réponse. Rien n'est envoyé tant qu'elle n'est pas donnée.
    if (!online) {
      setHintsOpen(true)
      return
    }
    if (seeking) return
    const left = whole ? play.remaining.solutions : play.remaining.hints
    if (left <= 0) {
      onToast('Plus de joker de ce type sur cette grille')
      return
    }
    if (whole && !confirm(`Révéler « ${play.activeWord?.clueText || 'ce mot'} » en entier ?`)) {
      return
    }
    setSeeking(true)
    try {
      onToast(outcomeMessage(whole ? await play.revealWord(true) : await play.revealLetter(true)))
    } finally {
      setSeeking(false)
    }
  }

  const positions = useMemo(() => mysteryPositions(puzzle), [puzzle])
  const mysteryAnswer = useMemo(
    () => readMysteryAnswer(puzzle, play.progress),
    [puzzle, play.progress],
  )

  const word = play.activeWord
  const position = word && word.cells.length > 0 ? play.cursor + 1 : 0

  return (
    <div className="app">
      <div className="topbar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Retour">
          ←
        </button>
        <h1>
          {puzzle.title}
          <span className="subtitle">
            {play.filled}/{play.total} cases
            {play.complete ? ' · terminée' : ''}
          </span>
        </h1>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setMenuOpen(true)}
          aria-label="Options"
        >
          ⋯
        </button>
      </div>

      <GridView
        puzzle={puzzle}
        progress={play.progress}
        activeCell={play.activeCell}
        activeWord={play.activeWord}
        onSelectCell={play.selectCell}
        onSelectClueCell={play.selectClueCell}
        mysteryPositions={positions}
        revealed={play.revealed}
      />

      {puzzle.mystery && puzzle.mystery.slots.length > 0 && (
        <MysteryBar
          mystery={puzzle.mystery}
          answer={mysteryAnswer}
          onOpen={() => setMysteryOpen(true)}
        />
      )}

      <div className="cluebar">
        {word ? (
          <>
            {/* The printed arrow itself, bend included, rather than just the
                reading direction: it is how you find where the answer starts. */}
            <span
              className="arrow-chip"
              title={ARROW_LABEL[word.arrow]}
              aria-label={ARROW_LABEL[word.arrow]}
            >
              {ARROW_GLYPH[word.arrow]}
            </span>
            <span className={`text ${word.clueText ? '' : 'placeholder'}`}>
              {word.clueText || 'Définition non lue — corrige-la dans la relecture'}
            </span>
            <span className="count">
              {position}/{word.cells.length}
            </span>
          </>
        ) : (
          <span className="text placeholder">Touche une case pour commencer</span>
        )}
        {/* Les jokers sont ici et pas dans un menu : c'est en butant sur une
            définition qu'on veut de l'aide, et c'est cette ligne-là qu'on
            regarde à ce moment. */}
        <div className="jokers" role="group" aria-label="Jokers">
          <button
            type="button"
            className="joker"
            disabled={seeking || play.remaining.hints <= 0}
            aria-label={`Indice — une lettre (${play.remaining.hints} restants)`}
            onClick={() => void spend(false)}
          >
            <span aria-hidden="true">💡</span>
            <em>{play.remaining.hints}</em>
          </button>
          <button
            type="button"
            className="joker"
            disabled={seeking || play.remaining.solutions <= 0}
            aria-label={`Solution — le mot entier (${play.remaining.solutions} restantes)`}
            onClick={() => void spend(true)}
          >
            <span aria-hidden="true">🔑</span>
            <em>{play.remaining.solutions}</em>
          </button>
        </div>
      </div>

      <Keyboard
        onLetter={play.typeLetter}
        onBackspace={play.backspace}
        onClear={play.clearCell}
        draftMode={play.draftMode}
        onToggleDraft={() => play.setDraftMode(!play.draftMode)}
        onPreviousWord={play.previousWord}
        onNextWord={play.nextWord}
      />

      {mysteryOpen && puzzle.mystery && (
        <Sheet title="Mot mystère" onClose={() => setMysteryOpen(false)}>
          <p style={{ margin: '0 0 14px', fontSize: 16 }}>
            {puzzle.mystery.clue || (
              <span className="muted">Définition non saisie — ajoute-la dans la relecture.</span>
            )}
          </p>
          <div className="mystery-slots" style={{ flexWrap: 'wrap', marginBottom: 14 }}>
            {mysteryAnswer.map((letter, i) => (
              <span key={i} className={`mystery-slot ${letter ? 'filled' : ''}`}>
                {letter || ''}
              </span>
            ))}
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {mysteryAnswer.filter(Boolean).length} lettre(s) sur {mysteryAnswer.length} trouvée(s).
            Les lettres arrivent des cases numérotées de la grille.
          </p>
        </Sheet>
      )}

      {hintsOpen && (
        <HintsSheet
          words={play.words}
          allowance={play.allowance}
          remaining={play.remaining}
          online={online}
          onOnlineChange={setOnline}
          onClose={() => setHintsOpen(false)}
          onToast={onToast}
        />
      )}

      {menuOpen && (
        <Sheet title={puzzle.title} onClose={() => setMenuOpen(false)}>
          <button
            type="button"
            className="sheet-action"
            onClick={() => {
              setMenuOpen(false)
              setHintsOpen(true)
            }}
          >
            <span className="glyph">💡</span>
            Indices et solutions
          </button>
          <button
            type="button"
            className="sheet-action"
            onClick={() => {
              setMenuOpen(false)
              onReview()
            }}
          >
            <span className="glyph">✎</span>
            Corriger la grille et les définitions
          </button>
          <button
            type="button"
            className="sheet-action"
            onClick={async () => {
              setMenuOpen(false)
              try {
                const outcome = await offerShareLink(await buildShareLink(puzzle), puzzle.title)
                if (outcome === 'copied') onToast('Lien copié — colle-le à un ami')
              } catch {
                onToast('Partage impossible')
              }
            }}
          >
            <span className="glyph">🔗</span>
            Partager cette grille
          </button>
          <button
            type="button"
            className="sheet-action danger"
            onClick={() => {
              if (confirm('Effacer toutes les lettres saisies ?')) {
                play.resetAll()
                setMenuOpen(false)
              }
            }}
          >
            <span className="glyph">↺</span>
            Recommencer la grille
          </button>
        </Sheet>
      )}
    </div>
  )
}
