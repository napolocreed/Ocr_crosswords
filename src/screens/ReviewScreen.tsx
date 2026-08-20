import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { holdReload } from '../lib/updateGuard'

/**
 * The correction step, one pass per kind of mistake.
 *
 * *Grille* fixes what kind each square is and trims stray border rows — the
 * things detection gets wrong on a photo of a bound magazine. *Définitions*
 * pairs each OCR result with the crop it came from, so text is corrected while
 * looking at the printed text. *Flèches* is deliberately its own pass: checking
 * text and checking arrows are different acts — one is reading, the other is
 * comparing a glyph against the photo — and while they shared a queue, the
 * queue was ranked by TEXT confidence, so a wrong arrow sat invisible inside a
 * confidently read definition. Each pass flags for its own reasons and keeps
 * its own per-clue tick.
 */

type Pass = 'structure' | 'definitions' | 'arrows' | 'mystery'

interface Props {
  puzzle: Puzzle
  onSave: (puzzle: Puzzle) => void
  onCancel: () => void
}

/**
 * Arrow confidence below which the arrow joins the arrows-pass queue: it was
 * deduced from geometry rather than read off the page, and deserves a glance.
 */
const ARROW_REVIEW_THRESHOLD = 0.6

/**
 * The definition field: a textarea that grows to its content rather than an input
 * that hides it.
 *
 * This row exists so a reader can compare the reading against the picture beside
 * it. A single-line field cut `BATTU SUR L'ÉCHIQUIER` off at `L'ÉCHIQU`, and text
 * you have to scroll a field to see is text nobody checks — so the one element
 * the screen is built around was the one element you could not read.
 */
function ClueField({
  value,
  onChange,
  onDone,
  onCaret,
}: {
  value: string
  onChange: (text: string) => void
  onDone: () => void
  onCaret?: (at: number) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // `field-sizing: content` would do this in CSS, but Safari has not shipped it.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder="Définition non lue"
      autoCapitalize="characters"
      autoCorrect="off"
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onSelect={(event) => onCaret?.(event.currentTarget.selectionStart ?? 0)}
      onBlur={onDone}
    />
  )
}

export function ReviewScreen({ puzzle: initial, onSave, onCancel }: Props) {
  const [puzzle, setPuzzle] = useState(initial)
  const [pass, setPass] = useState<Pass>('structure')
  const [assets, setAssets] = useState<PuzzleAssets | null>(null)
  const [onlyFlagged, setOnlyFlagged] = useState(true)
  const [onlyFlaggedArrows, setOnlyFlaggedArrows] = useState(true)
  const [zoomed, setZoomed] = useState<string | null>(null)
  /**
   * Where the caret last sat, and in which definition. A ref rather than state so
   * that moving it does not re-render sixty rows; tagged with the clue it came
   * from so a cut cannot use a position left behind in another one.
   */
  const caret = useRef<{ id: string; at: number } | null>(null)

  useEffect(() => {
    void getAssets(initial.id).then((found) => setAssets(found ?? null))
  }, [initial.id])

  /*
   * Hold off a version update while there are corrections that have not been
   * saved. Everything else in the app is written to IndexedDB as it is typed, so
   * this screen is the only place where a reload could throw work away — and a
   * new version arriving is not worth a lost review.
   */
  const dirty = puzzle !== initial
  useEffect(() => {
    if (!dirty) return
    return holdReload()
  }, [dirty])

  const words = useMemo(() => buildWords(puzzle), [puzzle])
  const index = useMemo(() => indexWords(words), [words])
  const orphans = useMemo(() => findOrphanCells(puzzle, index), [puzzle, index])
  const orphanKeys = useMemo(
    () => new Set(orphans.map((cell) => cellKey(cell.r, cell.c))),
    [orphans],
  )

  const clues = useMemo(() => allClues(puzzle), [puzzle])

  /**
   * Why a definition's TEXT wants attention: unread, or read without confidence.
   * Nothing here is about the arrow — that has its own pass, its own reasons.
   */
  const textConcernOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const { clue } of clues) {
      if (!clue.text) map.set(clue.id, 'non lue')
      else if ((clue.confidence ?? 0) < REVIEW_THRESHOLD) map.set(clue.id, 'lecture peu sûre')
    }
    return map
  }, [clues])

  /**
   * Why an ARROW wants attention. Where the answer lands is the arrow's doing,
   * so the structural signals live here: an answer of no letters means the
   * arrow points at nothing, one letter is barely more plausible — both are the
   * strongest evidence available that the arrow (or the square) is wrong. And a
   * low arrow confidence means the glyph was deduced from geometry rather than
   * read off the page. These used to be mixed into a single queue ranked by
   * TEXT confidence, where a wrong arrow hid inside a well-read definition.
   */
  const arrowConcernOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const { clue } of clues) {
      const word = index.byId.get(clue.id)
      if (!word || word.cells.length === 0) map.set(clue.id, 'ne mène nulle part')
      else if (word.cells.length === 1) map.set(clue.id, 'réponse d’une seule lettre')
      else if ((clue.arrowConfidence ?? 0) < ARROW_REVIEW_THRESHOLD) {
        map.set(clue.id, 'déduite, pas lue sur la photo')
      }
    }
    return map
  }, [clues, index])

  /** Older grids carry one flag for both; treat their tick as covering the arrow. */
  const arrowOk = (clue: (typeof clues)[number]['clue']) =>
    clue.arrowReviewed ?? clue.reviewed ?? false

  const flagged = useMemo(
    () => clues.filter(({ clue }) => !clue.reviewed && textConcernOf.has(clue.id)),
    [clues, textConcernOf],
  )
  const visibleClues = onlyFlagged && flagged.length > 0 ? flagged : clues

  const arrowFlagged = useMemo(
    () => clues.filter(({ clue }) => !arrowOk(clue) && arrowConcernOf.has(clue.id)),
    [clues, arrowConcernOf],
  )
  const visibleArrowClues =
    onlyFlaggedArrows && arrowFlagged.length > 0 ? arrowFlagged : clues

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
        {/* The magazine prints its level next to the grid ("Fléchés Niveau 2/3"),
            so this is asked here, while the page is still to hand. It mostly
            matters to whoever receives the grid through a shared link. */}
        <span className="muted" style={{ width: '100%', marginBottom: 4 }}>
          Difficulté (indiquée sur la page du magazine)
        </span>
        <div className="seg" style={{ width: '100%', marginBottom: 10 }} data-role="difficulty">
          {[1, 2, 3, 4].map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={puzzle.difficulty === level}
              onClick={() =>
                setPuzzle((current) => ({
                  ...current,
                  difficulty: current.difficulty === level ? undefined : level,
                }))
              }
            >
              {level}
            </button>
          ))}
        </div>
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

      {visibleClues.length > 0 && (
        /* Most of this list is right, and reading a row to agree with it is still
           reading it. One tap accepts everything on screen; anything wrong is
           still correctable here, or later from the grid itself. */
        <button
          type="button"
          className="btn wide accept-all"
          onClick={() =>
            setPuzzle(
              visibleClues.reduce(
                (next, { clue }) => updateClue(next, clue.id, { reviewed: true }),
                puzzle,
              ),
            )
          }
        >
          ✓ Tout valider ({visibleClues.filter(({ clue }) => !clue.reviewed).length})
        </button>
      )}

      {visibleClues.map(({ r, c, clue }) => {
        // Older imports filed crops by coordinate; fall back so they still show.
        const crop = assets?.crops[clue.id] ?? assets?.crops[cellKey(r, c)]
        const concern = textConcernOf.get(clue.id)
        const count = cellAt(puzzle, r, c)?.clues?.length ?? 1
        return (
          <div
            key={clue.id}
            className={
              'review-row' +
              (concern && !clue.reviewed ? ' flagged' : '') +
              (clue.reviewed ? ' done' : '')
            }
          >
            {crop ? (
              <img
                className="crop"
                src={crop}
                alt={`Case ligne ${r + 1}, colonne ${c + 1}`}
                onClick={() => setZoomed(crop)}
              />
            ) : (
              <div className="crop crop-missing" />
            )}
            <div className="fields">
              {/* The definition is the subject, so it comes first and largest.
                  Nothing about the arrow appears here: it has its own pass. */}
              <ClueField
                value={clue.text}
                onChange={(text) => setPuzzle(updateClue(puzzle, clue.id, { text }))}
                onDone={() => setPuzzle(updateClue(puzzle, clue.id, { reviewed: true }))}
                onCaret={(at) => (caret.current = { id: clue.id, at })}
              />
              <div className="row-meta">
                <span className="position">
                  L{r + 1}·C{c + 1}
                </span>
                {concern && !clue.reviewed && <span className="concern">{concern}</span>}
                <span className="spacer" />
                <button
                  type="button"
                  className="tick"
                  aria-pressed={clue.reviewed === true}
                  aria-label={clue.reviewed ? 'Vérifiée' : 'Marquer comme vérifiée'}
                  onClick={() =>
                    setPuzzle(updateClue(puzzle, clue.id, { reviewed: !clue.reviewed }))
                  }
                >
                  ✓
                </button>
              </div>
              {/* Out where it can be seen. A missed hairline is the one error the
                  reader cannot work around by editing, so the way out of it must
                  not be behind another control. */}
              {count === 2 ? (
                <button
                  type="button"
                  className="split-toggle"
                  onClick={() => setPuzzle(setClueCount(puzzle, r, c, 1))}
                >
                  ⇧ Réunir : c’est une seule définition
                </button>
              ) : (
                <button
                  type="button"
                  className="split-toggle"
                  onClick={() => {
                    // Cut where the reader put the caret, when they put it
                    // somewhere useful; otherwise split and let them type the
                    // second half. Either way the first half keeps its text.
                    const mark = caret.current
                    const at =
                      mark && mark.id === clue.id && mark.at > 0 && mark.at < clue.text.length
                        ? mark.at
                        : undefined
                    setPuzzle(setClueCount(puzzle, r, c, 2, at))
                  }}
                >
                  ⇩ Couper en deux au curseur
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )

  /* ---------------------------------------------------------------- arrows */

  /*
   * Checking an arrow is one comparison: the printed glyph in the photo against
   * the four possible directions. So the crop is the biggest thing in the row —
   * it reaches past the square into the neighbouring cells, which is where the
   * magazine prints the arrow — and the four choices are permanent buttons, not
   * a popover: this pass exists to look at them, hiding them would be backwards.
   * Choosing a direction IS verifying it, so picking one also ticks the row.
   */
  const arrowsPass = (
    <div className="scroll">
      <div className="seg" style={{ marginBottom: 12 }}>
        <button
          type="button"
          aria-pressed={onlyFlaggedArrows}
          onClick={() => setOnlyFlaggedArrows(true)}
        >
          À vérifier ({arrowFlagged.length})
        </button>
        <button
          type="button"
          aria-pressed={!onlyFlaggedArrows}
          onClick={() => setOnlyFlaggedArrows(false)}
        >
          Toutes ({clues.length})
        </button>
      </div>

      {visibleArrowClues.length === 0 && (
        <div className="empty">
          <h2>Rien à vérifier</h2>
          <p>Toutes les flèches ont été lues sur la photo avec un bon niveau de confiance.</p>
        </div>
      )}

      {visibleArrowClues.length > 0 && (
        <button
          type="button"
          className="btn wide accept-all"
          onClick={() =>
            setPuzzle(
              visibleArrowClues.reduce(
                (next, { clue }) => updateClue(next, clue.id, { arrowReviewed: true }),
                puzzle,
              ),
            )
          }
        >
          ✓ Tout valider ({visibleArrowClues.filter(({ clue }) => !arrowOk(clue)).length})
        </button>
      )}

      {visibleArrowClues.map(({ r, c, clue }) => {
        const crop = assets?.crops[clue.id] ?? assets?.crops[cellKey(r, c)]
        const concern = arrowConcernOf.get(clue.id)
        const ok = arrowOk(clue)
        const word = index.byId.get(clue.id)
        const landsNowhere = !word || word.cells.length === 0
        return (
          <div
            key={clue.id}
            className={
              'review-row arrow-row' +
              (concern && !ok ? ' flagged' : '') +
              (ok ? ' done' : '')
            }
          >
            {crop ? (
              <img
                className="crop"
                src={crop}
                alt={`Case ligne ${r + 1}, colonne ${c + 1}`}
                onClick={() => setZoomed(crop)}
              />
            ) : (
              <div className="crop crop-missing" />
            )}
            <div className="fields">
              {/* Read-only here on purpose: this pass is about the arrow, and the
                  text is only shown so you know which definition you are on. */}
              <div className="clue-caption">{clue.text || 'Définition non lue'}</div>
              <div className="row-meta">
                <div className="arrow-picker inline">
                  {ARROW_KINDS.map((arrow) => (
                    <button
                      key={arrow}
                      type="button"
                      aria-pressed={clue.arrow === arrow}
                      title={ARROW_LABEL[arrow]}
                      aria-label={ARROW_LABEL[arrow]}
                      onClick={() =>
                        setPuzzle(updateClue(puzzle, clue.id, { arrow, arrowReviewed: true }))
                      }
                    >
                      {ARROW_GLYPH[arrow]}
                    </button>
                  ))}
                </div>
                <span className="spacer" />
                <button
                  type="button"
                  className="tick"
                  aria-pressed={ok}
                  aria-label={ok ? 'Flèche vérifiée' : 'Marquer la flèche comme vérifiée'}
                  onClick={() => setPuzzle(updateClue(puzzle, clue.id, { arrowReviewed: !ok }))}
                >
                  ✓
                </button>
              </div>
              <div className="row-meta">
                <span className="position">
                  L{r + 1}·C{c + 1}
                  {word && word.cells.length > 0
                    ? ` · réponse de ${word.cells.length} lettre${word.cells.length > 1 ? 's' : ''}`
                    : ''}
                </span>
                {concern && !ok && (
                  <span className={`concern${landsNowhere ? ' danger' : ''}`}>{concern}</span>
                )}
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
              ? // Progress, not a repeat of the filter's own count: the reader
                // wants to know how much is left, and the tab already says how
                // many are flagged.
                `${clues.filter(({ clue }) => clue.reviewed).length} / ${clues.length} textes vérifiés`
              : pass === 'arrows'
                ? `${clues.filter(({ clue }) => arrowOk(clue)).length} / ${clues.length} flèches vérifiées`
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
        <div className="seg tight">
          <button
            type="button"
            aria-pressed={pass === 'structure'}
            onClick={() => setPass('structure')}
          >
            1. Grille
          </button>
          {/* The dot says "this pass still has a queue" from any tab — the whole
              point of separate passes is lost if one can be left unvisited
              without noticing. */}
          <button
            type="button"
            aria-pressed={pass === 'definitions'}
            onClick={() => setPass('definitions')}
          >
            2. Définitions
            {flagged.length > 0 && <span className="seg-dot" aria-hidden="true" />}
          </button>
          <button
            type="button"
            aria-pressed={pass === 'arrows'}
            onClick={() => setPass('arrows')}
          >
            3. Flèches
            {arrowFlagged.length > 0 && <span className="seg-dot" aria-hidden="true" />}
          </button>
          <button
            type="button"
            aria-pressed={pass === 'mystery'}
            onClick={() => setPass('mystery')}
          >
            4. Mystère
          </button>
        </div>
      </div>

      {pass === 'structure'
        ? structurePass
        : pass === 'arrows'
          ? arrowsPass
          : pass === 'mystery'
            ? mysteryPass
            : definitionsPass}

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
