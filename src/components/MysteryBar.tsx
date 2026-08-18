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
      {/* Named, not just starred. A row of empty boxes behind a symbol is a
          puzzle in itself: it was not obvious that the row *was* the mystery
          word, nor that tapping it showed the clue. */}
      <span className="mystery-label">
        <span aria-hidden="true">✦</span> Mot mystère
      </span>
      <span
        className="mystery-slots"
        aria-label={`Mot mystère, ${found} lettres trouvées sur ${answer.length}`}
      >
        {answer.map((letter, i) => (
          <span key={i} className={`mystery-slot ${letter ? 'filled' : ''}`}>
            {letter || ''}
          </span>
        ))}
      </span>
      <span className="mystery-hint">{mystery.clue ? 'Voir l’indice' : `${found}/${answer.length}`}</span>
    </button>
  )
}
