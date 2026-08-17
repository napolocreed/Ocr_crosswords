import { useCallback, useEffect, useState } from 'react'
import type { Progress, Puzzle, PuzzleAssets } from './types'
import {
  deletePuzzle,
  getAllProgress,
  getProgress,
  listPuzzles,
  requestPersistence,
  saveAssets,
  savePuzzle,
} from './lib/db'
import { emptyProgress } from './lib/puzzle'
import { LibraryScreen } from './screens/LibraryScreen'
import { ImportScreen } from './screens/ImportScreen'
import { ReviewScreen } from './screens/ReviewScreen'
import { PlayScreen } from './screens/PlayScreen'
import { SettingsScreen } from './screens/SettingsScreen'

/**
 * Screen orchestration and the single source of truth for the library.
 *
 * Navigation is a plain state machine rather than a router: there are five
 * screens, deep links are meaningless for local-only data, and this keeps the
 * back button behaving like a phone's back button via a history entry per screen.
 */

type Route =
  | { name: 'library' }
  | { name: 'import' }
  | { name: 'play'; puzzleId: string }
  | { name: 'review'; puzzleId: string }
  | { name: 'settings' }

export function App() {
  const [route, setRoute] = useState<Route>({ name: 'library' })
  const [puzzles, setPuzzles] = useState<Puzzle[]>([])
  const [progress, setProgress] = useState<Map<string, Progress>>(new Map())
  const [activeProgress, setActiveProgress] = useState<Progress | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [all, allProgress] = await Promise.all([listPuzzles(), getAllProgress()])
    setPuzzles(all)
    setProgress(allProgress)
  }, [])

  useEffect(() => {
    void (async () => {
      await refresh()
      setLoading(false)
      // Ask once, quietly: without this Safari may evict half-finished grids.
      void requestPersistence()
    })()
  }, [refresh])

  const showToast = useCallback((message: string) => {
    setToast(message)
    setTimeout(() => setToast((current) => (current === message ? null : current)), 2600)
  }, [])

  /* ------------------------------------------------------------- navigation */

  const go = useCallback((next: Route) => {
    setRoute(next)
    if (next.name !== 'library') history.pushState({ screen: next.name }, '')
  }, [])

  // The hardware/browser back button leaves the current screen instead of the app.
  useEffect(() => {
    const onPop = () => setRoute({ name: 'library' })
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const backToLibrary = useCallback(() => {
    setRoute({ name: 'library' })
    void refresh()
  }, [refresh])

  const openPuzzle = useCallback(
    async (puzzle: Puzzle) => {
      const found = await getProgress(puzzle.id)
      setActiveProgress(found ?? emptyProgress(puzzle.id))
      // A freshly imported grid goes straight to correction: definitions are
      // only worth reading once, while the magazine is still to hand.
      go(puzzle.reviewed ? { name: 'play', puzzleId: puzzle.id } : { name: 'review', puzzleId: puzzle.id })
    },
    [go],
  )

  const onImported = useCallback(
    async (puzzle: Puzzle, assets: PuzzleAssets) => {
      await savePuzzle(puzzle)
      await saveAssets(assets)
      await refresh()
      setActiveProgress(emptyProgress(puzzle.id))
      go({ name: 'review', puzzleId: puzzle.id })
    },
    [refresh, go],
  )

  const current = (id: string) => puzzles.find((puzzle) => puzzle.id === id)

  /* ----------------------------------------------------------------- render */

  if (loading) {
    return (
      <div className="app">
        <div className="scroll" style={{ display: 'grid', placeContent: 'center' }}>
          <div className="spinner" />
        </div>
      </div>
    )
  }

  let screen
  if (route.name === 'import') {
    screen = <ImportScreen onDone={onImported} onCancel={backToLibrary} />
  } else if (route.name === 'settings') {
    screen = <SettingsScreen onBack={backToLibrary} onToast={showToast} />
  } else if (route.name === 'review') {
    const puzzle = current(route.puzzleId)
    screen = puzzle ? (
      <ReviewScreen
        puzzle={puzzle}
        onCancel={backToLibrary}
        onSave={async (updated) => {
          await savePuzzle(updated)
          await refresh()
          const found = await getProgress(updated.id)
          setActiveProgress(found)
          setRoute({ name: 'play', puzzleId: updated.id })
          showToast('Grille enregistrée')
        }}
      />
    ) : null
  } else if (route.name === 'play') {
    const puzzle = current(route.puzzleId)
    screen =
      puzzle && activeProgress ? (
        <PlayScreen
          puzzle={puzzle}
          progress={activeProgress}
          onBack={backToLibrary}
          onReview={() => go({ name: 'review', puzzleId: puzzle.id })}
        />
      ) : null
  }

  return (
    <>
      {screen ?? (
        <LibraryScreen
          puzzles={puzzles}
          progress={progress}
          onOpen={(puzzle) => void openPuzzle(puzzle)}
          onReview={(puzzle) => go({ name: 'review', puzzleId: puzzle.id })}
          onDelete={async (puzzle) => {
            await deletePuzzle(puzzle.id)
            await refresh()
            showToast('Grille supprimée')
          }}
          onRename={async (puzzle, title) => {
            await savePuzzle({ ...puzzle, title, updatedAt: Date.now() })
            await refresh()
          }}
          onImport={() => void refresh()}
          onNew={() => go({ name: 'import' })}
          onSettings={() => go({ name: 'settings' })}
          onToast={showToast}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
