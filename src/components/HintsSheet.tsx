import { useEffect, useRef, useState } from 'react'
import { Sheet } from './Sheet'
import type { Word } from '../lib/puzzle'
import { type PrefetchProgress, prefetchAnswers } from '../lib/hints'
import { clearCachedClues, countCachedClues, setSetting } from '../lib/db'
import type { Allowance } from '../lib/jokers'

interface Props {
  words: Word[]
  allowance: Allowance
  remaining: Allowance
  /** Le joueur a-t-il accepté que ses définitions soient envoyées au site ? */
  online: boolean
  onOnlineChange: (value: boolean) => void
  onClose: () => void
  onToast: (message: string) => void
}

/**
 * Le panneau des jokers : ce qu'ils sont, ce qui reste, et la seule question
 * qui mérite d'être posée avant de s'en servir.
 *
 * Cette app promet que rien ne quitte l'appareil. Chercher la solution d'une
 * définition la rompt : le texte de la définition part chez motscroises.fr.
 * C'est peu, ce n'est pas rien, et ça ne se décide pas à la place du joueur —
 * d'où un consentement explicite, refusé par défaut, révocable, et une phrase
 * qui dit exactement ce qui part plutôt qu'un « améliorer votre expérience ».
 */
export function HintsSheet({
  words,
  allowance,
  remaining,
  online,
  onOnlineChange,
  onClose,
  onToast,
}: Props) {
  const [cached, setCached] = useState<number | null>(null)
  const [running, setRunning] = useState<PrefetchProgress | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    void countCachedClues().then(setCached)
    // Une préparation en cours doit s'arrêter si le panneau se ferme : sinon
    // elle continue d'interroger le site pour une grille qu'on a quittée.
    return () => abort.current?.abort()
  }, [])

  const playable = words.filter((word) => word.cells.length > 0 && word.clueText.trim())

  const prepare = async () => {
    abort.current = new AbortController()
    setRunning({ done: 0, total: playable.length, found: 0 })
    const final = await prefetchAnswers(playable, true, setRunning, abort.current.signal)
    setRunning(null)
    setCached(await countCachedClues())
    if (!abort.current.signal.aborted) {
      onToast(
        final.found === 0
          ? 'Aucune solution trouvée — le site ne connaît pas ces définitions'
          : `${final.found} définition(s) sur ${final.total} prêtes hors-ligne`,
      )
    }
  }

  return (
    <Sheet title="Indices et solutions" onClose={onClose}>
      <div className="joker-counts">
        <div className="joker-count">
          <span className="glyph">💡</span>
          <strong>
            {remaining.hints}
            <span className="of">/{allowance.hints}</span>
          </strong>
          <span className="label">indices — une lettre</span>
        </div>
        <div className="joker-count">
          <span className="glyph">🔑</span>
          <strong>
            {remaining.solutions}
            <span className="of">/{allowance.solutions}</span>
          </strong>
          <span className="label">solutions — un mot</span>
        </div>
      </div>

      <p className="muted" style={{ margin: '0 0 14px' }}>
        Les jokers portent sur la définition sélectionnée. Un indice choisit la case la plus
        utile — de préférence vide, et traversée par un autre mot. Un joker qui ne trouve rien
        n'est pas décompté.
      </p>

      <div className="card" style={{ margin: '0 0 14px' }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <input
            type="checkbox"
            checked={online}
            style={{ width: 22, height: 22, flex: 'none', marginTop: 2 }}
            onChange={(event) => {
              onOnlineChange(event.target.checked)
              void setSetting('hints.online', event.target.checked)
            }}
          />
          <span>
            Chercher les solutions en ligne
            <span className="hint" style={{ display: 'block' }}>
              Le <strong>texte de la définition</strong> est envoyé à{' '}
              <code>motscroises.fr</code> pour en obtenir la solution. Ni la photo, ni la grille,
              ni tes lettres ne sortent de l'appareil, et aucun cookie n'est transmis. Sans cette
              autorisation, les jokers ne puisent que dans ce qui est déjà en réserve.
            </span>
          </span>
        </label>
      </div>

      {online && (
        <>
          {running ? (
            <>
              <div className="bar">
                <i
                  style={{
                    width: `${running.total ? Math.round((running.done / running.total) * 100) : 0}%`,
                  }}
                />
              </div>
              <p className="muted" style={{ margin: '8px 0 12px' }}>
                {running.done}/{running.total} définitions — {running.found} avec solution.
              </p>
              <button
                type="button"
                className="btn wide"
                onClick={() => {
                  abort.current?.abort()
                  onToast('Préparation interrompue')
                }}
              >
                Arrêter
              </button>
            </>
          ) : (
            <button type="button" className="btn wide" onClick={() => void prepare()}>
              Préparer les {playable.length} définitions pour le hors-ligne
            </button>
          )}
        </>
      )}

      <p className="muted" style={{ margin: '14px 0 0', fontSize: 12 }}>
        {cached === null
          ? 'Réserve locale : taille inconnue.'
          : `${cached} définition(s) en réserve sur cet appareil, réutilisables d'une grille à l'autre et sans réseau.`}
      </p>
      {cached !== null && cached > 0 && (
        <button
          type="button"
          className="sheet-action danger"
          style={{ marginTop: 10 }}
          onClick={async () => {
            if (!confirm('Vider la réserve de solutions ?')) return
            await clearCachedClues()
            setCached(0)
            onToast('Réserve vidée')
          }}
        >
          <span className="glyph">↺</span>
          Vider la réserve
        </button>
      )}
    </Sheet>
  )
}
