import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type Progress, type Puzzle, arrowStartOffset, cellKey } from '../types'
import type { Word } from '../lib/puzzle'
import { GridArrow, entersFromLeft } from './GridArrow'
import { fitClueSize, shortenClue } from '../lib/clueTypography'

/**
 * The grid, pan- and pinch-zoomable.
 *
 * Zoom is handled by hand rather than by the browser: an arrowword needs to be
 * usable both fitted to the screen (to see the shape of the puzzle) and zoomed
 * in (to read the definitions printed inside the squares), and native
 * pinch-zoom inside a scroller fights the fixed keyboard band below.
 */

/**
 * Smallest type, in physical pixels, that is worth drawing at all.
 *
 * Below this a definition is texture, not text. Rather than blank the square
 * when its definition will not fit — which left the fitted grid with no text in
 * it anywhere — the definition is set at exactly this size and cut short. Only
 * when even a few characters will not fit does the square go empty.
 */
const LEGIBLE_PX = 6.5

/**
 * How far below the floor a shortened definition may go to keep a whole word.
 *
 * A square only wide enough for RIVI… is wide enough for RIVIÈRE… one step of
 * type smaller, and the whole word is worth much more than the step.
 */
const SHORTENED_FLOOR = 0.84

/** Cell size in CSS pixels at zoom 1. Everything else scales from this. */
const BASE_CELL = 44

/** Padding inside a definition square, matching `.cell.clue` in styles.css. */
const CLUE_PAD_X = 1
const CLUE_PAD_Y = 1
/** Rule, margin and padding between two definitions stacked in one square. */
const CLUE_DIVIDER = 3

/** Largest a very short definition is allowed to grow to. */
const CLUE_MAX = BASE_CELL * 0.34

const clueBox = (stacked: boolean) => ({
  w: BASE_CELL - 2 * CLUE_PAD_X,
  h: stacked
    ? (BASE_CELL - 2 * CLUE_PAD_Y - CLUE_DIVIDER) / 2
    : BASE_CELL - 2 * CLUE_PAD_Y,
})

/** An arrow to draw in a letter square, put there by a neighbouring definition. */
interface Mark {
  id: string
  arrow: Parameters<typeof entersFromLeft>[0]
  lane: number
}

interface Props {
  puzzle: Puzzle
  progress: Progress
  activeCell: { r: number; c: number } | null
  activeWord: Word | null
  onSelectCell: (r: number, c: number) => void
  onSelectClueCell: (r: number, c: number) => void
  /** Extra squares to call out, e.g. unreachable ones during review. */
  highlights?: Set<string>
  /** "r,c" → position in the mystery answer, shown as a small corner badge. */
  mysteryPositions?: Map<string, number>
}

interface Transform {
  zoom: number
  x: number
  y: number
}

export function GridView({
  puzzle,
  progress,
  activeCell,
  activeWord,
  onSelectCell,
  onSelectClueCell,
  highlights,
  mysteryPositions,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [transform, setTransform] = useState<Transform>({ zoom: 1, x: 0, y: 0 })
  const [viewport, setViewport] = useState({ w: 0, h: 0 })
  const gridW = puzzle.cols * BASE_CELL + puzzle.cols + 1
  const gridH = puzzle.rows * BASE_CELL + puzzle.rows + 1

  const minZoom = useMemo(() => {
    if (!viewport.w || !viewport.h) return 0.3
    return Math.min(viewport.w / gridW, viewport.h / gridH)
  }, [viewport, gridW, gridH])

  const clamp = useCallback(
    (next: Transform): Transform => {
      const zoom = Math.min(4, Math.max(minZoom * 0.9, next.zoom))
      const scaledW = gridW * zoom
      const scaledH = gridH * zoom
      // Centre whichever axis is smaller than the viewport; otherwise keep the
      // content covering it, so the grid can never be flung off screen.
      const x =
        scaledW <= viewport.w
          ? (viewport.w - scaledW) / 2
          : Math.min(0, Math.max(viewport.w - scaledW, next.x))
      const y =
        scaledH <= viewport.h
          ? (viewport.h - scaledH) / 2
          : Math.min(0, Math.max(viewport.h - scaledH, next.y))
      return { zoom, x, y }
    },
    [minZoom, gridW, gridH, viewport],
  )

  useLayoutEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setViewport({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Fit the whole grid on first measure, and whenever the puzzle changes shape.
  const fittedFor = useRef('')
  useEffect(() => {
    const key = `${puzzle.id}:${puzzle.rows}x${puzzle.cols}:${viewport.w}x${viewport.h}`
    if (!viewport.w || fittedFor.current === key) return
    fittedFor.current = key
    setTransform(clamp({ zoom: minZoom, x: 0, y: 0 }))
  }, [puzzle.id, puzzle.rows, puzzle.cols, viewport, minZoom, clamp])

  /* ------------------------------------------------------- pointer handling */

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{
    startDistance: number
    startZoom: number
    startCentre: { x: number; y: number }
    startTransform: Transform
    moved: boolean
  } | null>(null)

  const onPointerDown = (event: React.PointerEvent) => {
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 1) {
      gesture.current = {
        startDistance: 0,
        startZoom: transform.zoom,
        startCentre: { x: event.clientX, y: event.clientY },
        startTransform: transform,
        moved: false,
      }
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      if (!a || !b) return
      gesture.current = {
        startDistance: Math.hypot(a.x - b.x, a.y - b.y),
        startZoom: transform.zoom,
        startCentre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        startTransform: transform,
        moved: true,
      }
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const current = gesture.current
    if (!current) return
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return

    if (pointers.current.size >= 2 && current.startDistance > 0) {
      const [a, b] = [...pointers.current.values()]
      if (!a || !b) return
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      const ratio = distance / current.startDistance
      const zoom = current.startZoom * ratio
      // Keep the point between the fingers pinned while scaling.
      const anchorX = current.startCentre.x - rect.left
      const anchorY = current.startCentre.y - rect.top
      const scale = zoom / current.startTransform.zoom
      setTransform(
        clamp({
          zoom,
          x: anchorX - (anchorX - current.startTransform.x) * scale,
          y: anchorY - (anchorY - current.startTransform.y) * scale,
        }),
      )
      return
    }

    const dx = event.clientX - current.startCentre.x
    const dy = event.clientY - current.startCentre.y
    if (!current.moved && Math.hypot(dx, dy) > 8) current.moved = true
    if (!current.moved) return
    setTransform(
      clamp({
        zoom: current.startTransform.zoom,
        x: current.startTransform.x + dx,
        y: current.startTransform.y + dy,
      }),
    )
  }

  /*
   * Zoom shortcuts, because pinching is not a good way to read.
   *
   * Fitted to a phone the definitions are at the edge of legibility however they
   * are set, so getting in close is not an occasional thing — it is most of
   * playing. A double tap and a button both toggle between the whole grid and a
   * comfortable reading zoom, anchored where the tap landed so the square you
   * were looking at stays under your thumb.
   */
  const comfortZoom = useMemo(() => Math.min(3, Math.max(minZoom * 1.35, 1.2)), [minZoom])
  const isFitted = transform.zoom <= minZoom * 1.05

  const zoomTo = useCallback(
    (zoom: number, anchor?: { x: number; y: number }) => {
      setTransform((current) => {
        const anchorX = anchor?.x ?? viewport.w / 2
        const anchorY = anchor?.y ?? viewport.h / 2
        const scale = zoom / current.zoom
        return clamp({
          zoom,
          x: anchorX - (anchorX - current.x) * scale,
          y: anchorY - (anchorY - current.y) * scale,
        })
      })
    },
    [clamp, viewport],
  )

  const toggleZoom = useCallback(
    (anchor?: { x: number; y: number }) => zoomTo(isFitted ? comfortZoom : minZoom, anchor),
    [zoomTo, isFitted, comfortZoom, minZoom],
  )

  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null)

  const onPointerUp = (event: React.PointerEvent) => {
    const dragged = gesture.current?.moved === true
    const alone = pointers.current.size === 1
    pointers.current.delete(event.pointerId)
    if (pointers.current.size === 0) gesture.current = null

    if (dragged || !alone) return
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const previous = lastTap.current
    const at = Date.now()
    if (previous && at - previous.at < 320 && Math.hypot(point.x - previous.x, point.y - previous.y) < 28) {
      lastTap.current = null
      toggleZoom(point)
      return
    }
    lastTap.current = { at, ...point }
  }

  const wasDrag = () => gesture.current?.moved === true

  const onWheel = (event: React.WheelEvent) => {
    if (!event.ctrlKey && Math.abs(event.deltaY) < 2) return
    event.preventDefault()
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const anchorX = event.clientX - rect.left
    const anchorY = event.clientY - rect.top
    const zoom = transform.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)
    const scale = zoom / transform.zoom
    setTransform(
      clamp({
        zoom,
        x: anchorX - (anchorX - transform.x) * scale,
        y: anchorY - (anchorY - transform.y) * scale,
      }),
    )
  }

  /* ---------------------------------------------- keep the active cell shown */

  useEffect(() => {
    if (!activeCell || !viewport.w) return
    setTransform((current) => {
      const cellLeft = activeCell.c * (BASE_CELL + 1) * current.zoom + current.x
      const cellTop = activeCell.r * (BASE_CELL + 1) * current.zoom + current.y
      const size = BASE_CELL * current.zoom
      const margin = size * 1.2
      let { x, y } = current
      if (cellLeft < margin) x += margin - cellLeft
      if (cellLeft + size > viewport.w - margin) x -= cellLeft + size - (viewport.w - margin)
      if (cellTop < margin) y += margin - cellTop
      if (cellTop + size > viewport.h - margin) y -= cellTop + size - (viewport.h - margin)
      return x === current.x && y === current.y ? current : clamp({ ...current, x, y })
    })
  }, [activeCell, viewport, clamp])

  const activeKey = activeCell ? cellKey(activeCell.r, activeCell.c) : null
  const wordKeys = useMemo(() => {
    if (!activeWord) return new Set<string>()
    return new Set(activeWord.cells.map((cell: { r: number; c: number }) => cellKey(cell.r, cell.c)))
  }, [activeWord])

  const fontSize = Math.max(7, BASE_CELL * 0.52)

  /*
   * Every arrow, filed under the square it belongs in rather than the square it
   * came from — which is the neighbouring letter square the answer starts in.
   *
   * Two definitions stacked in one square can send their arrows through the same
   * border into the same neighbour, and then they have to be pushed apart or
   * they land on top of each other. Only arrows actually sharing a border are
   * moved: two definitions pointing different ways go to different squares, or
   * through different borders of the same square, and each should sit in the
   * middle of its own. So the lanes are worked out per border, after the arrows
   * have been filed, rather than from the definition's position in its square.
   *
   * An arrow whose answer starts nowhere — off the grid, or in a square that is
   * not a letter — has no square to be drawn in. Those stay in the definition,
   * marked, because an arrow silently vanishing would hide a misread one.
   */
  const { marks, orphans } = useMemo(() => {
    const marks = new Map<string, Mark[]>()
    const orphans = new Map<string, Mark[]>()
    for (let i = 0; i < puzzle.cells.length; i += 1) {
      const cell = puzzle.cells[i]
      if (!cell || cell.kind !== 'clue') continue
      const r = Math.floor(i / puzzle.cols)
      const c = i % puzzle.cols
      for (const clue of cell.clues ?? []) {
        const { dr, dc } = arrowStartOffset(clue.arrow)
        const tr = r + dr
        const tc = c + dc
        const target =
          tr < puzzle.rows && tc < puzzle.cols ? puzzle.cells[tr * puzzle.cols + tc] : undefined
        const lands = target?.kind === 'letter'
        const into = lands ? marks : orphans
        const key = lands ? cellKey(tr, tc) : cellKey(r, c)
        const mark: Mark = { id: clue.id, arrow: clue.arrow, lane: 0.5 }
        const list = into.get(key)
        if (list) list.push(mark)
        else into.set(key, [mark])
      }
    }
    for (const list of [...marks.values(), ...orphans.values()]) {
      if (list.length < 2) continue
      for (const side of [true, false]) {
        const sharing = list.filter((mark) => entersFromLeft(mark.arrow) === side)
        if (sharing.length < 2) continue
        sharing.forEach((mark, k) => {
          mark.lane = (k + 1) / (sharing.length + 1)
        })
      }
    }
    return { marks, orphans }
  }, [puzzle])

  /*
   * The size each definition gets, measured against its own box once per puzzle.
   *
   * A single size for all of them has to be small enough for the longest, which
   * left every short definition set several points below what its square could
   * have carried — and, fitted to a phone, below what anyone could read.
   */
  const clueSizes = useMemo(() => {
    const sizes = new Map<string, number>()
    for (const cell of puzzle.cells) {
      if (cell.kind !== 'clue') continue
      const clues = cell.clues ?? []
      const box = clueBox(clues.length > 1)
      // A stacked half is capped below the full-square maximum too, so the two
      // definitions in one square are never set at wildly different sizes.
      const max = Math.min(CLUE_MAX, box.h * 0.62)
      for (const clue of clues) sizes.set(clue.id, fitClueSize(clue.text, box.w, box.h, 3, max))
    }
    return sizes
  }, [puzzle])

  /*
   * The size a shortened definition is set at, rounded to a step.
   *
   * Shortening measures text, and it happens while the grid is being rendered.
   * Taken straight from the zoom this would be a different number on every
   * frame of a pinch, so nothing would ever come out of the measurement cache
   * and every definition on the page would be re-measured sixty times a second.
   * Across a zoom sweep that costs a dropped frame — 38 ms at worst against
   * 19 ms rounded, on a desktop, so several times that on a phone. Rounding up
   * to a step keeps the type above the legibility floor, gives the cache
   * something to hold on to, and stops the text reflowing continuously under
   * the fingers as well. scripts/dev-grid.mjs measures it.
   */
  const floorSize = Math.ceil((LEGIBLE_PX / transform.zoom) * 4) / 4

  return (
    <div
      className="grid-wrap"
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <div
        className="grid-pan"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})` }}
      >
        <div
          className="grid"
          style={{ gridTemplateColumns: `repeat(${puzzle.cols}, ${BASE_CELL}px)` }}
        >
          {puzzle.cells.map((cell, i) => {
            const r = Math.floor(i / puzzle.cols)
            const c = i % puzzle.cols
            const key = cellKey(r, c)
            const letter = progress.letters[key]
            const drafts = progress.drafts[key]

            const classes = ['cell']
            if (cell.kind === 'block') classes.push('block')
            if (cell.kind === 'clue') classes.push('clue')
            if (cell.kind === 'letter' && wordKeys.has(key)) classes.push('in-word')
            if (key === activeKey) classes.push('active')
            if (
              cell.kind === 'clue' &&
              activeWord &&
              activeWord.origin.r === r &&
              activeWord.origin.c === c
            ) {
              classes.push('active-clue')
            }
            if (highlights?.has(key)) classes.push('flagged')

            const handleTap = () => {
              if (wasDrag()) return
              if (cell.kind === 'clue') onSelectClueCell(r, c)
              else if (cell.kind === 'letter') onSelectCell(r, c)
            }

            return (
              <div
                key={key}
                className={classes.join(' ')}
                style={{
                  width: BASE_CELL,
                  height: BASE_CELL,
                  fontSize,
                  ...(highlights?.has(key)
                    ? { boxShadow: 'inset 0 0 0 2px var(--danger)' }
                    : null),
                }}
                onPointerUp={handleTap}
              >
                {cell.kind === 'clue' ? (
                  <>
                    {(cell.clues ?? []).map((clue) => {
                      const box = clueBox((cell.clues ?? []).length > 1)
                      let size = clueSizes.get(clue.id) ?? 4
                      let text: string | null = clue.text.trim()
                      if (!text) {
                        size = Math.min(CLUE_MAX, box.h * 0.6)
                        text = '—'
                      } else if (size * transform.zoom < LEGIBLE_PX) {
                        // Too small to read whole: set it at the legibility floor
                        // and cut it short, rather than showing nothing at all.
                        const short = shortenClue(
                          clue.text,
                          box.w,
                          box.h,
                          floorSize,
                          floorSize * SHORTENED_FLOOR,
                        )
                        text = short?.text ?? null
                        size = short?.size ?? size
                      }
                      return text === null ? null : (
                        <span key={clue.id} className="clue-text clue-half" style={{ fontSize: size }}>
                          {text}
                        </span>
                      )
                    })}
                    {(orphans.get(key) ?? []).map((mark) => (
                      <GridArrow
                        key={mark.id}
                        arrow={mark.arrow}
                        cell={BASE_CELL}
                        lane={mark.lane}
                        orphan
                      />
                    ))}
                  </>
                ) : cell.kind === 'letter' ? (
                  <>
                    {(marks.get(key) ?? []).map((mark) => (
                      <GridArrow key={mark.id} arrow={mark.arrow} cell={BASE_CELL} lane={mark.lane} />
                    ))}
                    {mysteryPositions?.has(key) && (
                      <span
                        className="mystery-badge"
                        style={{ fontSize: Math.max(5, BASE_CELL * 0.2) }}
                      >
                        {mysteryPositions.get(key)}
                      </span>
                    )}
                    {letter ? (
                    letter
                    ) : drafts && drafts.length > 0 ? (
                      <span
                        className="drafts"
                        style={{ fontSize: Math.max(6, BASE_CELL * 0.26) }}
                      >
                        {drafts.slice(0, 4).map((candidate, k) => (
                          <span key={`${candidate}-${k}`}>{candidate}</span>
                        ))}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
      <button
        type="button"
        className="grid-zoom"
        // The grid itself listens on pointer events, so the button has to keep
        // its own out of the pan/tap machinery.
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={() => toggleZoom()}
        aria-label={isFitted ? 'Agrandir pour lire les définitions' : 'Voir toute la grille'}
      >
        {isFitted ? '⊕' : '⊖'}
      </button>
    </div>
  )
}
