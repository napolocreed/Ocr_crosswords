import { useEffect, useState } from 'react'
import { getSetting, requestPersistence, setSetting, storageEstimate } from '../lib/db'
import { isOcrEngineCached, primeOcrEngine } from '../lib/ocrBrowser'

interface Props {
  onBack: () => void
  onToast: (message: string) => void
}

export function SettingsScreen({ onBack, onToast }: Props) {
  const [uppercase, setUppercase] = useState(true)
  const [cached, setCached] = useState<boolean | null>(null)
  const [priming, setPriming] = useState<number | null>(null)
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const [persistent, setPersistent] = useState<boolean | null>(null)

  useEffect(() => {
    void getSetting('ocr.uppercase', true).then(setUppercase)
    void isOcrEngineCached().then(setCached)
    void storageEstimate().then(setStorage)
    void navigator.storage?.persisted?.().then(setPersistent).catch(() => setPersistent(null))
  }, [])

  const download = async () => {
    setPriming(0)
    await primeOcrEngine((ratio) => setPriming(ratio))
    setPriming(null)
    setCached(await isOcrEngineCached())
    onToast('Moteur de lecture disponible hors-ligne')
  }

  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} Mo`

  return (
    <div className="app">
      <div className="topbar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Retour">
          ←
        </button>
        <h1>Réglages</h1>
      </div>
      <div className="scroll">
        <div className="card">
          <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Lecture hors-ligne</h2>
          <p className="muted" style={{ margin: '0 0 12px' }}>
            Le moteur de reconnaissance pèse environ 7 Mo. Télécharge-le une fois pour pouvoir
            numériser une grille sans réseau — dans le train, par exemple.
          </p>
          {priming !== null ? (
            <div className="bar">
              <i style={{ width: `${Math.round(priming * 100)}%` }} />
            </div>
          ) : (
            <button
              type="button"
              className={`btn wide ${cached ? '' : 'primary'}`}
              onClick={() => void download()}
            >
              {cached === null
                ? 'Vérification…'
                : cached
                  ? '✓ Déjà disponible hors-ligne — retélécharger'
                  : 'Télécharger le moteur (7 Mo)'}
            </button>
          )}
        </div>

        <div className="card">
          <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Reconnaissance</h2>
          <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="checkbox"
              checked={uppercase}
              style={{ width: 22, height: 22, flex: 'none' }}
              onChange={(event) => {
                setUppercase(event.target.checked)
                void setSetting('ocr.uppercase', event.target.checked)
              }}
            />
            <span>
              Définitions en majuscules
              <span className="hint" style={{ display: 'block' }}>
                Le cas de presque tous les magazines français. Améliore nettement la lecture ;
                décoche-le si ton magazine imprime les définitions en minuscules.
              </span>
            </span>
          </label>
        </div>

        <div className="card">
          <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Stockage</h2>
          <p className="muted" style={{ margin: 0 }}>
            {storage
              ? `${mb(storage.usage)} utilisés sur ${mb(storage.quota)} disponibles.`
              : 'Taille inconnue sur ce navigateur.'}
          </p>
          <p className="muted" style={{ margin: '6px 0 12px' }}>
            {persistent
              ? 'Tes grilles sont marquées comme persistantes : le navigateur ne les supprimera pas.'
              : 'Le navigateur peut supprimer tes grilles s’il manque de place.'}
          </p>
          {!persistent && (
            <button
              type="button"
              className="btn wide"
              onClick={async () => {
                const granted = await requestPersistence()
                setPersistent(granted)
                onToast(
                  granted
                    ? 'Grilles protégées contre la suppression'
                    : 'Le navigateur a refusé — ajoute l’app à l’écran d’accueil et réessaie',
                )
              }}
            >
              Protéger mes grilles
            </button>
          )}
        </div>

        <div className="card">
          <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>À propos</h2>
          <p className="muted" style={{ margin: 0 }}>
            Tout se passe sur ton téléphone : les photos, la reconnaissance et tes grilles ne
            quittent jamais l’appareil. Aucun compte, aucun serveur.
          </p>
          {/* An offline app can sit a version behind without looking like it, so
              the build has to be readable from the phone itself. */}
          <p className="muted" data-role="build" style={{ margin: '8px 0 0', fontSize: 12 }}>
            Version {__BUILD_ID__}
          </p>
        </div>
      </div>
    </div>
  )
}
