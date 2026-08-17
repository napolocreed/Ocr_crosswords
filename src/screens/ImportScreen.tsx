import { useCallback, useEffect, useRef, useState } from 'react'
import type { Puzzle, PuzzleAssets } from '../types'
import type { Quad, RgbaImage } from '../lib/image'
import { rotateRgba } from '../lib/image'
import { decodeImageFileScaled } from '../lib/canvas'
import {
  analyseStructure,
  buildPuzzleFromDetection,
  makeThumbnail,
  readDefinitions,
  suggestQuad,
  type StructureAnalysis,
} from '../lib/importPipeline'
import { createBrowserOcrEngine } from '../lib/ocrBrowser'
import { CropStage } from '../components/CropStage'

/**
 * Photo → grid, in three steps: frame it, check what was found, read the text.
 *
 * The structure pass is re-run whenever the crop changes, so the user sees
 * immediately whether the app has understood the grid — before committing to the
 * slow OCR pass.
 */

/**
 * Working size for the photo held in memory. A modern phone shoots 12 Mpx, which
 * would cost ~50 MB as RGBA and risks the tab being killed mid-import; 2400px on
 * the long side keeps the definitions comfortably legible.
 */
const MAX_PHOTO_DIM = 2400

type Step = 'pick' | 'crop' | 'ocr'

interface Props {
  onDone: (puzzle: Puzzle, assets: PuzzleAssets) => void
  onCancel: () => void
}

export function ImportScreen({ onDone, onCancel }: Props) {
  const [step, setStep] = useState<Step>('pick')
  const [photo, setPhoto] = useState<RgbaImage | null>(null)
  const [quad, setQuad] = useState<Quad | null>(null)
  const [turns, setTurns] = useState(0)
  const [analysis, setAnalysis] = useState<StructureAnalysis | null>(null)
  const [analysing, setAnalysing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [ocrProgress, setOcrProgress] = useState({ done: 0, total: 0, note: '' })
  const fileInput = useRef<HTMLInputElement>(null)

  /** The photo as the user currently sees it, rotation applied. */
  const oriented = photo && turns ? rotateRgba(photo, turns) : photo

  const pick = async (file: File) => {
    setError(null)
    try {
      const decoded = await decodeImageFileScaled(file, MAX_PHOTO_DIM)
      setPhoto(decoded)
      setTurns(0)
      setQuad(suggestQuad(decoded))
      setTitle(defaultTitle())
      setStep('crop')
    } catch {
      setError('Impossible de lire cette image. Réessaie avec une photo JPEG ou PNG.')
    }
  }

  // Re-detect after the crop settles, rather than on every pointer move.
  const analysisToken = useRef(0)
  const runAnalysis = useCallback(
    async (source: RgbaImage, currentQuad: Quad) => {
      const token = ++analysisToken.current
      setAnalysing(true)
      try {
        const result = await analyseStructure(source, currentQuad, 0)
        if (analysisToken.current === token) setAnalysis(result)
      } catch {
        if (analysisToken.current === token) {
          setError('La détection a échoué sur cette image.')
        }
      } finally {
        if (analysisToken.current === token) setAnalysing(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (step !== 'crop' || !oriented || !quad) return
    const timer = setTimeout(() => void runAnalysis(oriented, quad), 260)
    return () => clearTimeout(timer)
  }, [step, oriented, quad, runAnalysis])

  const rotate = () => {
    if (!photo) return
    const next = (turns + 1) % 4
    setTurns(next)
    // The crop is expressed in the rotated frame, so it has to rotate with it.
    const rotated = rotateRgba(photo, next)
    setQuad(suggestQuad(rotated))
  }

  const startOcr = async () => {
    if (!analysis || !oriented) return
    const detection = analysis.detection
    if (detection.rows < 2 || detection.cols < 2) {
      setError('Aucune grille détectée. Ajuste le cadrage sur le contour de la grille.')
      return
    }
    setStep('ocr')
    setError(null)
    const puzzle = buildPuzzleFromDetection(detection, title.trim() || defaultTitle())
    setOcrProgress({ done: 0, total: 0, note: 'Préparation du moteur de lecture…' })
    try {
      const engine = await createBrowserOcrEngine()
      await engine.init()
      setOcrProgress({ done: 0, total: 0, note: 'Lecture des définitions…' })
      const result = await readDefinitions(puzzle, analysis, engine, (progress) => {
        setOcrProgress({ done: progress.done, total: progress.total, note: progress.lastText ?? '' })
      })
      await engine.terminate()
      if (result.quality.suspect) {
        // Almost nothing legible came out. By far the most common cause is a
        // photo that is upright but upside down — which the orientation check
        // cannot see, since the text lines are horizontal either way.
        setStep('crop')
        setError(
          `Seules ${result.quality.plausible} définitions sur ${result.quality.read} ressemblent à du texte. ` +
            'La photo est probablement à l’envers : appuie deux fois sur ⟳ puis relance la lecture.',
        )
        return
      }
      const thumbnail = await makeThumbnail(analysis.preview)
      onDone({ ...result.puzzle, thumbnail }, result.assets)
    } catch (cause) {
      setStep('crop')
      setError(
        cause instanceof Error && /fetch|network|load/i.test(cause.message)
          ? 'Le moteur de lecture n’a pas pu être chargé. Connecte-toi une fois pour le télécharger, puis il fonctionnera hors-ligne.'
          : 'La lecture des définitions a échoué. Tu peux réessayer, ou saisir les définitions à la main.',
      )
    }
  }

  /** Import the structure only, and let the user type the definitions. */
  const skipOcr = async () => {
    if (!analysis) return
    const detection = analysis.detection
    if (detection.rows < 2 || detection.cols < 2) {
      setError('Aucune grille détectée. Ajuste le cadrage sur le contour de la grille.')
      return
    }
    const puzzle = buildPuzzleFromDetection(detection, title.trim() || defaultTitle())
    const thumbnail = await makeThumbnail(analysis.preview)
    onDone({ ...puzzle, thumbnail }, { puzzleId: puzzle.id, crops: {} })
  }

  if (step === 'pick') {
    return (
      <div className="app">
        <div className="topbar">
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="Retour">
            ←
          </button>
          <h1>Nouvelle grille</h1>
        </div>
        <div className="scroll">
          <div className="card">
            <h2 style={{ margin: '0 0 8px', fontSize: 17 }}>Photographie la grille</h2>
            <p className="muted" style={{ margin: '0 0 14px' }}>
              Pose le magazine bien à plat, en lumière homogène, et cadre la grille seule — sans
              la page en face. Tu pourras ajuster le cadrage juste après.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void pick(file)
                event.target.value = ''
              }}
            />
            <button
              type="button"
              className="btn primary wide"
              onClick={() => fileInput.current?.click()}
            >
              📷 Prendre une photo
            </button>
          </div>
          {error && (
            <div className="card" style={{ borderColor: '#5a2b2b' }}>
              <p className="muted" style={{ margin: 0, color: 'var(--danger)' }}>
                {error}
              </p>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (step === 'ocr') {
    const ratio = ocrProgress.total > 0 ? ocrProgress.done / ocrProgress.total : 0
    return (
      <div className="app">
        <div className="topbar">
          <h1>Lecture en cours</h1>
        </div>
        <div className="scroll" style={{ display: 'grid', placeContent: 'center' }}>
          <div style={{ textAlign: 'center', maxWidth: 340 }}>
            <div className="spinner" />
            <p style={{ margin: '0 0 12px' }}>
              {ocrProgress.total > 0
                ? `${ocrProgress.done} / ${ocrProgress.total} définitions`
                : ocrProgress.note}
            </p>
            <div className="bar">
              <i style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
            {ocrProgress.note && ocrProgress.total > 0 && (
              <p className="hint" style={{ minHeight: 34 }}>
                « {ocrProgress.note} »
              </p>
            )}
            <p className="hint">
              Tout se passe sur ton téléphone, sans connexion. Tu corrigeras ensuite ce qui a été
              mal lu.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const detection = analysis?.detection
  const clueCount =
    detection?.cells.reduce((sum, cell) => sum + (cell.kind === 'clue' ? 1 : 0), 0) ?? 0

  return (
    <div className="app">
      <div className="topbar">
        <button type="button" className="icon-btn" onClick={() => setStep('pick')} aria-label="Retour">
          ←
        </button>
        <h1>
          Cadre la grille
          <span className="subtitle">
            {analysing
              ? 'analyse…'
              : detection && detection.rows > 1
                ? `${detection.cols} × ${detection.rows} · ${clueCount} définitions`
                : 'grille non reconnue'}
          </span>
        </h1>
        <button type="button" className="icon-btn" onClick={rotate} aria-label="Pivoter">
          ⟳
        </button>
      </div>

      {oriented && quad && <CropStage image={oriented} quad={quad} onChange={setQuad} />}

      {analysis?.looksSideways && !analysing && (
        <div
          style={{
            padding: '10px 12px',
            background: '#40320d',
            color: 'var(--warn)',
            fontSize: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span>
            Les définitions semblent écrites de haut en bas : la photo est couchée. Pivote-la
            avec ⟳, sinon la lecture ne donnera rien.
          </span>
          <button type="button" className="btn" style={{ flex: 'none' }} onClick={rotate}>
            ⟳ Pivoter
          </button>
        </div>
      )}

      {error && (
        <div style={{ padding: '8px 12px', color: 'var(--danger)', fontSize: 14 }}>{error}</div>
      )}

      <div className="toolbar">
        <input
          className="grow"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Nom de la grille"
          aria-label="Nom de la grille"
        />
        <button type="button" className="btn primary" onClick={() => void startOcr()}>
          Lire
        </button>
      </div>
      <div className="toolbar" style={{ borderTop: 'none', paddingTop: 0 }}>
        <button type="button" className="btn wide" onClick={() => void skipOcr()}>
          Passer l’OCR et saisir à la main
        </button>
      </div>
    </div>
  )
}

function defaultTitle(): string {
  const now = new Date()
  return `Grille du ${now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`
}
