import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ARROW_GLYPH, type ArrowKind, type Progress, type Puzzle, cellKey } from '../types'
import type { Word } from '../lib/puzzle'

/**
 * The grid, pan- and pinch-zoomable.
 *
 * Zoom is handled by hand rather than by the browser: an arrowword needs to be
 * usable both fitted to the screen (to see the shape of the puzzle) and zoomed
 * in (to read the definitions printed inside the squares), and native
 * pinch-zoom inside a scroller fights the fixed keyboard band below.
 */

/** Cell size in CSS pixels at zoom 1. Everything else scales from this. */
const BASE_CELL = 44

/** Which edge of the clue square the arrow is drawn on. */
function arrowLeavesRight(arrow: ArrowKind): boolean {
  return arrow === 'right' || arrow === 'rightDown'
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

  const onPointerUp = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId)
    if (pointers.current.size === 0) gesture.current = null
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
  const clueFontSize = Math.max(4.5, BASE_CELL * 0.15)

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
                  fontSize: cell.kind === 'clue' ? clueFontSize : fontSize,
                  ...(highlights?.has(key)
                    ? { boxShadow: 'inset 0 0 0 2px var(--danger)' }
                    : null),
                }}
                onPointerUp={handleTap}
              >
                {cell.kind === 'clue' ? (
                  <>
                    {(cell.clues ?? []).map((clue) => (
                      <span key={clue.id} className="clue-text clue-half">
                        {clue.text || '—'}
                      </span>
                    ))}
                    {(cell.clues ?? []).map((clue) => (
                      <span
                        key={`arrow-${clue.id}`}
                        className={`arrow ${arrowLeavesRight(clue.arrow) ? 'right' : 'down'}`}
                        style={{ fontSize: Math.max(6, BASE_CELL * 0.2) }}
                      >
                        {ARROW_GLYPH[clue.arrow]}
                      </span>
                    ))}
                  </>
                ) : cell.kind === 'letter' ? (
                  <>
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
    </div>
  )
}
