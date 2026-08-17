import type { Mystery } from '../types'

/**
 * The mystery answer, assembling itself from the grid as it gets solved.
 *
 * Kept to a single compact line because the play screen already spends its
 * height on the grid, the active definition and the keyboard. The full clue
 * lives behind a tap rather than on screen permanently.
 */

interface Props {
  mystery: Mystery
  /** One entry per position; an empty string is a letter not yet found. */
  answer: string[]
  onOpen: () => void
}

export function MysteryBar({ mystery, answer, onOpen }: Props) {
  const found = answer.filter(Boolean).length
  return (
    <button type="button" className="mystery-bar" onClick={onOpen}>
      <span className="mystery-label" aria-hidden="true">
        ✦
      </span>
      <span className="mystery-slots" aria-label={`Mot mystère, ${found} lettres sur ${answer.length}`}>
        {answer.map((letter, i) => (
          <span key={i} className={`mystery-slot ${letter ? 'filled' : ''}`}>
            {letter || ''}
          </span>
        ))}
      </span>
      {mystery.clue && <span className="mystery-hint">?</span>}
    </button>
  )
}
