import { useEffect, useMemo, useState } from 'react'
import {
  ARROW_GLYPH,
  ARROW_KINDS,
  ARROW_LABEL,
  REVIEW_THRESHOLD,
  type Puzzle,
  type PuzzleAssets,
  cellKey,
} from '../types'
import {
  allClues,
  buildWords,
  cellAt,
  emptyProgress,
  findOrphanCells,
  indexWords,
  resizeGrid,
  setCellKind,
  updateClue,
} from '../lib/puzzle'
import { GridView } from '../components/GridView'
import { getAssets } from '../lib/db'

/**
 * The correction step, in two passes.
 *
 * *Structure* fixes what kind each square is and trims stray border rows — the
 * things detection gets wrong on a photo of a bound magazine. *Definitions* pairs
 * each OCR result with the crop it came from, which is the point of the whole
 * screen: you correct while looking at the printed text, without going back to
 * the magazine.
 */

type Pass = 'structure' | 'definitions'

interface Props {
  puzzle: Puzzle
  onSave: (puzzle: Puzzle) => void
  onCancel: () => void
}

export function ReviewScreen({ puzzle: initial, onSave, onCancel }: Props) {
  const [puzzle, setPuzzle] = useState(initial)
  const [pass, setPass] = useState<Pass>('structure')
  const [assets, setAssets] = useState<PuzzleAssets | null>(null)
  const [onlyFlagged, setOnlyFlagged] = useState(true)
  const [zoomed, setZoomed] = useState<string | null>(null)

  useEffect(() => {
    void getAssets(initial.id).then((found) => setAssets(found ?? null))
  }, [initial.id])

  const words = useMemo(() => buildWords(puzzle), [puzzle])
  const index = useMemo(() => indexWords(words), [words])
  const orphans = useMemo(() => findOrphanCells(puzzle, index), [puzzle, index])
  const orphanKeys = useMemo(
    () => new Set(orphans.map((cell) => cellKey(cell.r, cell.c))),
    [orphans],
  )

  const clues = useMemo(() => allClues(puzzle), [puzzle])
  const flagged = useMemo(
    () =>
      clues.filter(
        ({ clue }) => !clue.reviewed && (!clue.text || (clue.confidence ?? 0) < REVIEW_THRESHOLD),
      ),
    [clues],
  )
  const visibleClues = onlyFlagged && flagged.length > 0 ? flagged : clues

  /* ------------------------------------------------------------- structure */

  const cycleKind = (r: number, c: number) => {
    const current = cellAt(puzzle, r, c)?.kind ?? 'letter'
    const next = current === 'letter' ? 'clue' : current === 'clue' ? 'block' : 'letter'
    setPuzzle(setCellKind(puzzle, r, c, next))
  }

  const trim = (edge: 'top' | 'bottom' | 'left' | 'right') => {
    if (puzzle.rows <= 2 || puzzle.cols <= 2) return
    if (edge === 'bottom') {
      setPuzzle(resizeGrid(puzzle, puzzle.rows - 1, puzzle.cols))
      return
    }
    if (edge === 'right') {
      setPuzzle(resizeGrid(puzzle, puzzle.rows, puzzle.cols - 1))
      return
    }
    // Trimming the top or left means shifting every cell, not just resizing.
    const rows = edge === 'top' ? puzzle.rows - 1 : puzzle.rows
    const cols = edge === 'left' ? puzzle.cols - 1 : puzzle.cols
    const cells = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const sourceR = edge === 'top' ? r + 1 : r
        const sourceC = edge === 'left' ? c + 1 : c
        cells.push(cellAt(puzzle, sourceR, sourceC) ?? { kind: 'letter' as const })
      }
    }
    setPuzzle({ ...puzzle, rows, cols, cells, updatedAt: Date.now() })
  }

  const structurePass = (
    <>
      <GridView
        puzzle={puzzle}
        progress={emptyProgress(puzzle.id)}
        activeCell={null}
        activeWord={null}
        onSelectCell={cycleKind}
        onSelectClueCell={cycleKind}
        highlights={orphanKeys}
      />
      <div className="cluebar">
        <span className="text" style={{ fontSize: 13, fontWeight: 400 }}>
          {orphans.length > 0
            ? `${orphans.length} case(s) encadrée(s) en rouge : aucune définition n’y mène. Corrige une flèche, ou change le type de la case.`
            : 'Touche une case pour changer son type : vide → définition → noire. Toutes les cases sont atteignables.'}
        </span>
      </div>
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <span className="muted" style={{ width: '100%', marginBottom: 4 }}>
          Rogner une rangée en trop ({puzzle.cols} × {puzzle.rows})
        </span>
        <button type="button" className="btn" onClick={() => trim('top')}>
          ↑ haut
        </button>
        <button type="button" className="btn" onClick={() => trim('bottom')}>
          ↓ bas
        </button>
        <button type="button" className="btn" onClick={() => trim('left')}>
          ← gauche
        </button>
        <button type="button" className="btn" onClick={() => trim('right')}>
          → droite
        </button>
      </div>
    </>
  )

  /* ----------------------------------------------------------- definitions */

  const definitionsPass = (
    <div className="scroll">
      <div className="seg" style={{ marginBottom: 12 }}>
        <button
          type="button"
          aria-pressed={onlyFlagged}
          onClick={() => setOnlyFlagged(true)}
        >
          À vérifier ({flagged.length})
        </button>
        <button
          type="button"
          aria-pressed={!onlyFlagged}
          onClick={() => setOnlyFlagged(false)}
        >
          Toutes ({clues.length})
        </button>
      </div>

      {visibleClues.length === 0 && (
        <div className="empty">
          <h2>Rien à vérifier</h2>
          <p>Toutes les définitions ont été lues avec un bon niveau de confiance.</p>
        </div>
      )}

      {visibleClues.map(({ r, c, clue }) => {
        const crop = assets?.crops[cellKey(r, c)]
        const isFlagged = !clue.text || (clue.confidence ?? 0) < REVIEW_THRESHOLD
        const word = index.byId.get(clue.id)
        return (
          <div key={clue.id} className={`review-row ${isFlagged && !clue.reviewed ? 'flagged' : ''}`}>
            {crop ? (
              <img
                className="crop"
                src={crop}
                alt={`Case ligne ${r + 1}, colonne ${c + 1}`}
                onClick={() => setZoomed(crop)}
              />
            ) : (
              <div className="crop" style={{ height: 60, background: 'var(--bg-input)' }} />
            )}
            <div className="fields">
              <span className="position">
                L{r + 1} · C{c + 1}
                {word ? ` · ${word.cells.length} lettres` : ' · ne mène nulle part'}
                {clue.reviewed ? ' · vérifiée' : ''}
              </span>
              <input
                value={clue.text}
                placeholder="Définition"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) =>
                  setPuzzle(updateClue(puzzle, clue.id, { text: event.target.value }))
                }
                onBlur={() => setPuzzle(updateClue(puzzle, clue.id, { reviewed: true }))}
              />
              <div className="arrow-picker">
                {ARROW_KINDS.map((arrow) => (
                  <button
                    key={arrow}
                    type="button"
                    aria-pressed={clue.arrow === arrow}
                    title={ARROW_LABEL[arrow]}
                    aria-label={ARROW_LABEL[arrow]}
                    onClick={() =>
                      setPuzzle(updateClue(puzzle, clue.id, { arrow, reviewed: true }))
                    }
                  >
                    {ARROW_GLYPH[arrow]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="app">
      <div className="topbar">
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="Annuler">
          ←
        </button>
        <h1>
          Relecture
          <span className="subtitle">
            {pass === 'structure' ? 'forme de la grille' : `${flagged.length} à vérifier`}
          </span>
        </h1>
        <button
          type="button"
          className="icon-btn"
          onClick={() => onSave({ ...puzzle, reviewed: true, updatedAt: Date.now() })}
          aria-label="Enregistrer"
        >
          ✓
        </button>
      </div>

      <div style={{ padding: '10px 12px 0' }}>
        <div className="seg">
          <button
            type="button"
            aria-pressed={pass === 'structure'}
            onClick={() => setPass('structure')}
          >
            1. Structure
          </button>
          <button
            type="button"
            aria-pressed={pass === 'definitions'}
            onClick={() => setPass('definitions')}
          >
            2. Définitions
          </button>
        </div>
      </div>

      {pass === 'structure' ? structurePass : definitionsPass}

      {zoomed && (
        <div
          className="sheet-backdrop"
          onClick={() => setZoomed(null)}
          role="presentation"
          style={{ alignItems: 'center', justifyContent: 'center', padding: 16 }}
        >
          <img
            src={zoomed}
            alt="Case agrandie"
            style={{
              maxWidth: '100%',
              maxHeight: '80dvh',
              background: '#fff',
              borderRadius: 12,
              // Nearest-neighbour keeps small print crisp instead of mushy.
              imageRendering: 'pixelated',
            }}
          />
        </div>
      )}
    </div>
  )
}
