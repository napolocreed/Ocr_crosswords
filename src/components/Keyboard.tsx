/**
 * The in-app keyboard.
 *
 * Deliberately not the system keyboard: on iOS and Android the native one
 * resizes the viewport, applies autocorrection and auto-capitalisation, and
 * usually covers the square being filled. A fixed AZERTY band avoids all of
 * that, and gives room for the actions that matter while solving — draft mode,
 * and moving between answers — right under the thumb.
 */

import { useLayoutEffect, useRef } from 'react'

const ROWS = [
  ['A', 'Z', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['Q', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'M'],
  ['W', 'X', 'C', 'V', 'B', 'N'],
] as const

interface Props {
  onLetter: (letter: string) => void
  onBackspace: () => void
  onClear: () => void
  draftMode: boolean
  onToggleDraft: () => void
  onPreviousWord: () => void
  onNextWord: () => void
}

export function Keyboard({
  onLetter,
  onBackspace,
  onClear,
  draftMode,
  onToggleDraft,
  onPreviousWord,
  onNextWord,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)

  /*
   * Publishes the band's height so anything floating over the screen can sit
   * above it. Toasts are rendered at the top of the app, where they cannot know
   * a keyboard exists — and pinned to the bottom of the viewport they landed on
   * the last row of keys, covering the thing being used at the one moment the
   * app had something to say.
   */
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const publish = () => {
      document.documentElement.style.setProperty(
        '--toast-bottom',
        `${element.offsetHeight + 12}px`,
      )
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--toast-bottom')
    }
  }, [])

  return (
    <div className="keyboard" ref={ref} role="group" aria-label="Clavier de saisie">
      <div className="kb-row">
        <button
          type="button"
          className={`key util wide ${draftMode ? 'draft-on' : ''}`}
          aria-pressed={draftMode}
          onClick={onToggleDraft}
        >
          {draftMode ? '✎ Brouillon' : 'Brouillon'}
        </button>
        <button type="button" className="key util" onClick={onPreviousWord} aria-label="Mot précédent">
          ◀ mot
        </button>
        <button type="button" className="key util" onClick={onNextWord} aria-label="Mot suivant">
          mot ▶
        </button>
        <button type="button" className="key util" onClick={onClear} aria-label="Vider la case">
          Vider
        </button>
      </div>
      {ROWS.map((row, i) => (
        <div className="kb-row" key={i}>
          {i === 2 && <span className="key util" aria-hidden="true" style={{ flex: 0.6, background: 'transparent', border: 'none' }} />}
          {row.map((letter) => (
            <button type="button" key={letter} className="key" onClick={() => onLetter(letter)}>
              {letter}
            </button>
          ))}
          {i === 2 && (
            <button
              type="button"
              className="key util"
              style={{ flex: 1.6 }}
              onClick={onBackspace}
              aria-label="Effacer"
            >
              ⌫
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
