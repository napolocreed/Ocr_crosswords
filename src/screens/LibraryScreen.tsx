import { useMemo, useRef, useState } from 'react'
import type { Progress, Puzzle } from '../types'
import { progressRatio } from '../lib/puzzle'
import { Sheet } from '../components/Sheet'
import { buildPack, importPack, sharePack } from '../lib/exchange'

/**
 * The library: the grids you carry with you.
 *
 * Built around the "take a few for later" habit — a pack of grids can be
 * exported to a single file and imported on another device, and every grid is
 * playable offline the moment it appears here.
 */

interface Props {
  puzzles: Puzzle[]
  progress: Map<string, Progress>
  onOpen: (puzzle: Puzzle) => void
  onReview: (puzzle: Puzzle) => void
  onDelete: (puzzle: Puzzle) => void
  onRename: (puzzle: Puzzle, title: string) => void
  onImport: () => void
  onNew: () => void
  onSettings: () => void
  onToast: (message: string) => void
}

type Filter = 'all' | 'open' | 'done'

export function LibraryScreen({
  puzzles,
  progress,
  onOpen,
  onReview,
  onDelete,
  onRename,
  onImport,
  onNew,
  onSettings,
  onToast,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const [menuFor, setMenuFor] = useState<Puzzle | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const fileInput = useRef<HTMLInputElement>(null)

  const visible = useMemo(() => {
    if (filter === 'all') return puzzles
    return puzzles.filter((puzzle) => {
      const ratio = progressRatio(puzzle, progress.get(puzzle.id))
      return filter === 'done' ? ratio >= 1 : ratio < 1
    })
  }, [puzzles, progress, filter])

  const toggleSelected = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const exportSelection = async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    try {
      const pack = await buildPack(ids, true)
      const outcome = await sharePack(pack)
      onToast(
        outcome === 'shared'
          ? `${ids.length} grille(s) partagée(s)`
          : `${ids.length} grille(s) exportée(s)`,
      )
      setSelecting(false)
      setSelected(new Set())
    } catch {
      onToast('Export impossible')
    }
  }

  const runImport = async (file: File) => {
    try {
      const outcome = await importPack(file)
      onToast(
        outcome.added > 0
          ? `${outcome.added} grille(s) importée(s)${outcome.skipped ? `, ${outcome.skipped} déjà présente(s)` : ''}`
          : 'Ces grilles sont déjà dans ta bibliothèque',
      )
      onImport()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Import impossible')
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>
          Mes grilles
          <span className="subtitle">
            {puzzles.length === 0
              ? 'aucune grille'
              : `${puzzles.length} grille${puzzles.length > 1 ? 's' : ''}`}
          </span>
        </h1>
        {puzzles.length > 0 && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              setSelecting(!selecting)
              setSelected(new Set())
            }}
            aria-label={selecting ? 'Annuler la sélection' : 'Sélectionner'}
          >
            {selecting ? '✕' : '⤴'}
          </button>
        )}
        <button type="button" className="icon-btn" onClick={onSettings} aria-label="Réglages">
          ⚙
        </button>
      </div>

      <div className="scroll">
        {puzzles.length > 0 && !selecting && (
          <div className="seg" style={{ marginBottom: 12 }}>
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              Toutes
            </button>
            <button type="button" aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>
              En cours
            </button>
            <button type="button" aria-pressed={filter === 'done'} onClick={() => setFilter('done')}>
              Terminées
            </button>
          </div>
        )}

        {puzzles.length === 0 && (
          <div className="empty">
            <h2>Ta bibliothèque est vide</h2>
            <p>
              Photographie une grille de mots fléchés de ton magazine : l’application la
              numérise, tu corriges ce qui a été mal lu, et tu peux la remplir partout, même
              sans réseau.
            </p>
          </div>
        )}

        {visible.map((puzzle) => {
          const ratio = progressRatio(puzzle, progress.get(puzzle.id))
          const done = ratio >= 1
          const isSelected = selected.has(puzzle.id)
          return (
            <button
              type="button"
              key={puzzle.id}
              className="library-item"
              style={isSelected ? { borderColor: 'var(--accent)' } : undefined}
              onClick={() => (selecting ? toggleSelected(puzzle.id) : onOpen(puzzle))}
            >
              {puzzle.thumbnail ? (
                <img className="thumb" src={puzzle.thumbnail} alt="" />
              ) : (
                <div className="thumb placeholder">▦</div>
              )}
              <div className="meta">
                <div className="title">{puzzle.title}</div>
                <div className="sub">
                  {puzzle.cols} × {puzzle.rows}
                  {puzzle.source ? ` · ${puzzle.source}` : ''}
                  {' · '}
                  {new Date(puzzle.updatedAt).toLocaleDateString('fr-FR', {
                    day: 'numeric',
                    month: 'short',
                  })}
                </div>
                <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                  {!puzzle.reviewed && <span className="badge warn">à relire</span>}
                  {done && <span className="badge ok">terminée</span>}
                  {!done && ratio > 0 && (
                    <span className="badge">{Math.round(ratio * 100)} %</span>
                  )}
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
                </div>
              </div>
              {selecting ? (
                <span className="icon-btn" aria-hidden="true">
                  {isSelected ? '☑' : '☐'}
                </span>
              ) : (
                <span
                  className="icon-btn"
                  role="button"
                  tabIndex={0}
                  aria-label={`Options de ${puzzle.title}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuFor(puzzle)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.stopPropagation()
                      setMenuFor(puzzle)
                    }
                  }}
                >
                  ⋯
                </span>
              )}
            </button>
          )
        })}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void runImport(file)
          event.target.value = ''
        }}
      />

      <div className="toolbar">
        {selecting ? (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setSelected(new Set(visible.map((puzzle) => puzzle.id)))}
            >
              Tout
            </button>
            <button
              type="button"
              className="btn primary grow"
              disabled={selected.size === 0}
              onClick={() => void exportSelection()}
            >
              Exporter {selected.size > 0 ? `(${selected.size})` : ''}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
              ⤵ Importer
            </button>
            <button type="button" className="btn primary grow" onClick={onNew}>
              📷 Nouvelle grille
            </button>
          </>
        )}
      </div>

      {menuFor && (
        <Sheet title={menuFor.title} onClose={() => setMenuFor(null)}>
          <button
            type="button"
            className="sheet-action"
            onClick={() => {
              const puzzle = menuFor
              setMenuFor(null)
              onOpen(puzzle)
            }}
          >
            <span className="glyph">▶</span>
            Ouvrir
          </button>
          <button
            type="button"
            className="sheet-action"
            onClick={() => {
              const puzzle = menuFor
              setMenuFor(null)
              onReview(puzzle)
            }}
          >
            <span className="glyph">✎</span>
            Corriger la grille et les définitions
          </button>
          <button
            type="button"
            className="sheet-action"
            onClick={() => {
              const next = prompt('Nouveau nom', menuFor.title)
              if (next && next.trim()) onRename(menuFor, next.trim())
              setMenuFor(null)
            }}
          >
            <span className="glyph">Aa</span>
            Renommer
          </button>
          <button
            type="button"
            className="sheet-action"
            onClick={async () => {
              const puzzle = menuFor
              setMenuFor(null)
              try {
                await sharePack(await buildPack([puzzle.id], true))
                onToast('Grille exportée')
              } catch {
                onToast('Export impossible')
              }
            }}
          >
            <span className="glyph">⤴</span>
            Exporter cette grille
          </button>
          <button
            type="button"
            className="sheet-action danger"
            onClick={() => {
              const puzzle = menuFor
              setMenuFor(null)
              if (confirm(`Supprimer « ${puzzle.title} » et sa progression ?`)) onDelete(puzzle)
            }}
          >
            <span className="glyph">🗑</span>
            Supprimer
          </button>
        </Sheet>
      )}
    </div>
  )
}
