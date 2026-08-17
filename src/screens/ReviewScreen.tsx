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
  mysteryPositions,
  resizeGrid,
  setCellKind,
  setClueCount,
  setMystery,
  toggleMysterySlot,
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

type Pass = 'structure' | 'definitions' | 'mystery'

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

  /**
   * Why a definition wants attention. An answer of one letter or none is the
   * strongest signal available that a square was mistaken for a definition when
   * it is not one: a real arrowword answer is at least two letters, so this
   * catches structural errors that the OCR confidence cannot see.
   */
  const concernOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const { clue } of clues) {
      const word = index.byId.get(clue.id)
      if (!word || word.cells.length === 0) map.set(clue.id, 'ne mène nulle part')
      else if (word.cells.length === 1) map.set(clue.id, 'réponse d’une seule lettre')
      else if (!clue.text) map.set(clue.id, 'non lue')
      else if ((clue.confidence ?? 0) < REVIEW_THRESHOLD) map.set(clue.id, 'lecture peu sûre')
    }
    return map
  }, [clues, index])

  const flagged = useMemo(
    () => clues.filter(({ clue }) => !clue.reviewed && concernOf.has(clue.id)),
    [clues, concernOf],
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

  const positions = useMemo(() => mysteryPositions(puzzle), [puzzle])

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
        mysteryPositions={positions}
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
        // Older imports filed crops by coordinate; fall back so they still show.
        const crop = assets?.crops[clue.id] ?? assets?.crops[cellKey(r, c)]
        const concern = concernOf.get(clue.id)
        const word = index.byId.get(clue.id)
        return (
          <div key={clue.id} className={`review-row ${concern && !clue.reviewed ? 'flagged' : ''}`}>
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
                {word
                  ? ` · ${word.cells.length} lettre${word.cells.length > 1 ? 's' : ''}`
                  : ' · ne mène nulle part'}
                {clue.reviewed ? ' · vérifiée' : ''}
              </span>
              {concern && !clue.reviewed && <span className="concern">⚠ {concern}</span>}
              {(() => {
                const cell = cellAt(puzzle, r, c)
                const count = cell?.clues?.length ?? 1
                return (
                  <button
                    type="button"
                    className="split-toggle"
                    onClick={() => setPuzzle(setClueCount(puzzle, r, c, count === 2 ? 1 : 2))}
                  >
                    {count === 2
                      ? '⇧ Cette case n’a qu’une définition'
                      : '⇩ Cette case en contient deux'}
                  </button>
                )
              })()}
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

  /* --------------------------------------------------------------- mystery */

  const mystery = puzzle.mystery
  const assigned = mystery?.slots.filter(Boolean).length ?? 0

  const mysteryPass = (
    <>
      <div className="mystery-editor">
        <label className="field-label" htmlFor="mystery-clue">
          Définition du mot mystère (imprimée en marge de la grille)
        </label>
        <input
          id="mystery-clue"
          value={mystery?.clue ?? ''}
          placeholder="Ex. : Tropique, signe astrologique et coléoptère…"
          onChange={(event) =>
            setPuzzle(
              setMystery(puzzle, {
                clue: event.target.value,
                slots: mystery?.slots ?? [],
              }),
            )
          }
        />
        <p className="hint">
          {assigned === 0
            ? 'Touche ensuite les cases numérotées de la grille, dans l’ordre 1, 2, 3… Touche une case déjà numérotée pour la retirer.'
            : `${assigned} case(s) numérotée(s). Touche une case pour l’ajouter à la suite, ou une case déjà numérotée pour la retirer.`}
        </p>
        {assigned > 0 && (
          <div className="mystery-order">
            {(mystery?.slots ?? []).map((key, i) => (
              <span key={i} className={`mystery-order-chip ${key ? '' : 'empty'}`}>
                <span className="n">{i + 1}</span>
                {key ? `L${Number(key.split(',')[0]) + 1}·C${Number(key.split(',')[1]) + 1}` : '—'}
              </span>
            ))}
          </div>
        )}
      </div>

      <GridView
        puzzle={puzzle}
        progress={emptyProgress(puzzle.id)}
        activeCell={null}
        activeWord={null}
        onSelectCell={(r, c) => setPuzzle(toggleMysterySlot(puzzle, r, c))}
        onSelectClueCell={() => {}}
        mysteryPositions={positions}
      />

      <div className="toolbar">
        <button
          type="button"
          className="btn"
          disabled={assigned === 0}
          onClick={() =>
            setPuzzle(
              setMystery(puzzle, {
                clue: mystery?.clue ?? '',
                slots: (mystery?.slots ?? []).slice(0, -1),
              }),
            )
          }
        >
          ↩ Annuler
        </button>
        <button
          type="button"
          className="btn danger grow"
          disabled={!mystery}
          onClick={() => setPuzzle(setMystery(puzzle, undefined))}
        >
          Aucun mot mystère
        </button>
      </div>
    </>
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
            {pass === 'structure'
            ? 'forme de la grille'
            : pass === 'definitions'
              ? `${flagged.length} à vérifier`
              : `${assigned} case(s) numérotée(s)`}
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
          <button
            type="button"
            aria-pressed={pass === 'mystery'}
            onClick={() => setPass('mystery')}
          >
            3. Mystère
          </button>
        </div>
      </div>

      {pass === 'structure' ? structurePass : pass === 'mystery' ? mysteryPass : definitionsPass}

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
