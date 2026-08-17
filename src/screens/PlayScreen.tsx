import { useState } from 'react'
import { ARROW_LABEL, type Progress, type Puzzle } from '../types'
import { GridView } from '../components/GridView'
import { Keyboard } from '../components/Keyboard'
import { usePlayState } from '../state/usePlayState'
import { Sheet } from '../components/Sheet'

interface Props {
  puzzle: Puzzle
  progress: Progress
  onBack: () => void
  onReview: () => void
}

/**
 * The solving screen: grid, definition of the current answer, keyboard.
 *
 * The clue bar between the two is load-bearing. In an arrowword the definition
 * is printed inside a square at a size no phone can render legibly at fit-to-
 * screen zoom, so the active one is repeated here at a readable size.
 */
export function PlayScreen({ puzzle, progress, onBack, onReview }: Props) {
  const play = usePlayState(puzzle, progress)
  const [menuOpen, setMenuOpen] = useState(false)

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
      />

      <div className="cluebar">
        {word ? (
          <>
            <span className="arrow-chip" title={ARROW_LABEL[word.arrow]}>
              {word.direction === 'across' ? '→' : '↓'}
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

      {menuOpen && (
        <Sheet title={puzzle.title} onClose={() => setMenuOpen(false)}>
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
