import type { ArrowKind } from '../types'

/**
 * The arrow of a definition, drawn where the magazine prints it.
 *
 * A printed arrowword never puts the arrow inside the shaded square: the square
 * holds the words, and the arrow is struck into the *empty square the answer
 * starts in*, against the border the two share. That is what makes the grid
 * readable at a glance — you find an answer's first box by looking for the
 * arrow in it, not by working out which definition it belongs to. Drawing them
 * inside the definition, as this did at first, also cost the definition the
 * corner of its box, which is exactly the space the text needed.
 *
 * They are strokes rather than characters because a character has to be big
 * before its bend is visible, and there is no room to be big here.
 */

/**
 * Each arrow enters through one border. `entry` is where on that border, in
 * viewBox units, so a bent arrow and a straight one entering the same square
 * cross the border at the same point instead of sitting at different heights.
 */
const SHAPES: Record<ArrowKind, { entry: number; shaft: string; head: string }> = {
  right: { entry: 50, shaft: 'M-6,50 H62', head: '57,33 100,50 57,67' },
  rightDown: { entry: 34, shaft: 'M-6,34 H67 V62', head: '50,57 67,100 84,57' },
  down: { entry: 50, shaft: 'M50,-6 V62', head: '33,57 50,100 67,57' },
  downRight: { entry: 34, shaft: 'M34,-6 V67 H62', head: '57,50 100,67 57,84' },
}

/** Arrows entering through the left border rather than the top one. */
export function entersFromLeft(arrow: ArrowKind): boolean {
  return arrow === 'right' || arrow === 'rightDown'
}

interface Props {
  arrow: ArrowKind
  /** Cell size in grid units; the arrow is sized and placed relative to it. */
  cell: number
  /**
   * Where along the shared border the arrow crosses, 0–1. Two definitions
   * stacked in one square send their arrows into the same neighbour, so they
   * are pushed apart to the heights they were printed at.
   */
  lane: number
  /** True when the arrow points at no square at all, i.e. it is wrong. */
  orphan?: boolean
}

/**
 * Share of the square the arrow occupies.
 *
 * The magazines draw these small — a mark hugging the border, not a symbol
 * filling the box — because the square still has to be written in. Large enough
 * that the bend is legible with the whole grid on screen, small enough that a
 * letter written over it stays the more prominent of the two. 0.4 read as too
 * heavy next to the letters in play, so it came down.
 */
const ARROW_SIZE = 0.3

export function GridArrow({ arrow, cell, lane, orphan }: Props) {
  const shape = SHAPES[arrow]
  const size = cell * ARROW_SIZE
  const along = lane * cell - (shape.entry / 100) * size
  const fromLeft = entersFromLeft(arrow)
  // An orphaned arrow has no square to be drawn in, so it stays in the
  // definition, tucked against the border it should have crossed.
  const across = orphan ? cell - size : 0

  return (
    <svg
      className={`grid-arrow${orphan ? ' orphan' : ''}`}
      viewBox="0 0 100 100"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        left: fromLeft ? across : along,
        top: fromLeft ? along : across,
      }}
    >
      <path d={shape.shaft} fill="none" strokeWidth={13} strokeLinecap="butt" strokeLinejoin="round" />
      <polygon points={shape.head} stroke="none" />
    </svg>
  )
}
