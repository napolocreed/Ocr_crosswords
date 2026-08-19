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
 * Smallest type worth drawing at all, in CSS pixels on screen.
 *
 * CSS pixels, not device pixels: nothing here reads devicePixelRatio, and the
 * comparison is a font-size in grid units against the zoom that scales them —
 * running the grid at a device ratio of 1 and of 3 gives byte-identical text.
 * (This said "physical pixels" for a while, which is the sort of comment that
 * sends the next person hunting for a bug that is not there.)
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

/**
 * The box each definition in a square gets.
 *
 * Two stacked definitions used to be given half the square each, which is only
 * right when they are the same length — and they very often are not. MONTAGNES
 * above FEMELLES PORCINES had the short one sitting in a half-empty box while
 * the long one was squeezed into type two points smaller. Sharing the height by
 * how much text there is gives the long one a third more room, with a floor
 * under each so neither is starved.
 */
const clueBoxes = (texts: string[]): { w: number; h: number }[] => {
  const w = BASE_CELL - 2 * CLUE_PAD_X
  const full = BASE_CELL - 2 * CLUE_PAD_Y
  if (texts.length < 2) return texts.map(() => ({ w, h: full }))
  const usable = full - CLUE_DIVIDER
  const weights = texts.map((text) => Math.max(4, text.trim().length))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const first = Math.min(0.66, Math.max(0.34, (weights[0] ?? 1) / total))
  return [
    { w, h: usable * first },
    { w, h: usable * (1 - first) },
  ]
}

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

  /*
   * Fit the whole grid on first measure, and whenever the puzzle changes shape —
   * but never because the box it sits in moved.
   *
   * This used to key on the measured viewport as well, and reset the zoom to
   * fitted whenever that key changed. The viewport is a ResizeObserver reading
   * `.grid-wrap`, which is `flex: 1` between the clue bar and the keyboard and
   * is reported in fractional pixels — so selecting a word, which re-flows the
   * clue bar by a pixel or two, resized the box and threw away whatever zoom the
   * reader had set. Zoom in to read a definition, tap the square, and you are
   * back to the whole grid with the text too small again. That is both halves of
   * what was reported: definitions that stay unreadable "even when zooming", and
   * a zoom that needs two or three attempts. A box that changes size now only
   * pulls the grid back inside its bounds.
   */
  const fittedFor = useRef('')
  useEffect(() => {
    if (!viewport.w) return
    const key = `${puzzle.id}:${puzzle.rows}x${puzzle.cols}`
    if (fittedFor.current === key) {
      setTransform((current) => {
        const next = clamp(current)
        return next.zoom === current.zoom && next.x === current.x && next.y === current.y
          ? current
          : next
      })
      return
    }
    fittedFor.current = key
    setTransform(clamp({ zoom: minZoom, x: 0, y: 0 }))
    setTextZoom(minZoom)
  }, [puzzle.id, puzzle.rows, puzzle.cols, viewport, minZoom, clamp])

  /* ------------------------------------------------------- pointer handling */

  /*
   * One record per finger on the glass, and one gesture built from them.
   *
   * Whether a finger travelled is kept on the finger rather than on the gesture.
   * It used to live on the gesture, and the gesture was only cleared once every
   * pointer had been released — so one release that never arrived (a touch the
   * browser cancels, a capture lost when the page re-renders under the finger, a
   * second finger the phone stops reporting) left a gesture standing with
   * "moved" set, and from then on taps were read as the tail of a drag and
   * thrown away. Nothing here outlives the finger it belongs to now, and a
   * finger whose release never arrived is dropped when the browser says a new
   * touch has begun.
   */
  interface Finger {
    x: number
    y: number
    /** Travelled far enough to be a drag rather than a tap. */
    moved: boolean
    /** Shared the glass with another finger, so it is part of a pinch. */
    multi: boolean
    at: number
  }

  const pointers = useRef(new Map<number, Finger>())
  const gesture = useRef<{
    pinch: boolean
    startDistance: number
    startCentre: { x: number; y: number }
    startTransform: Transform
  } | null>(null)

  // Handlers run between renders, so they cannot read `transform` from the
  // closure and be sure it is current.
  const live = useRef(transform)
  live.current = transform

  const seedPan = (x: number, y: number) => {
    gesture.current = {
      pinch: false,
      startDistance: 0,
      startCentre: { x, y },
      startTransform: live.current,
    }
  }

  const onPointerDown = (event: React.PointerEvent) => {
    const now = Date.now()
    // `isPrimary` is the browser saying this is the first finger of a new touch
    // — so anything still on the books is a finger whose release never arrived,
    // and keeping it would make this touch look like part of a pinch.
    if (event.isPrimary) pointers.current.clear()
    for (const [id, finger] of pointers.current) {
      if (now - finger.at > 3000) pointers.current.delete(id)
    }
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
    const multi = pointers.current.size > 0
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      moved: false,
      multi,
      at: now,
    })
    if (pointers.current.size === 1) {
      seedPan(event.clientX, event.clientY)
      return
    }
    // A second finger turns whatever was happening into a pinch, and neither
    // finger can end as a tap.
    for (const finger of pointers.current.values()) finger.multi = true
    const [a, b] = [...pointers.current.values()]
    if (!a || !b) return
    gesture.current = {
      pinch: true,
      startDistance: Math.hypot(a.x - b.x, a.y - b.y),
      startCentre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      startTransform: live.current,
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const finger = pointers.current.get(event.pointerId)
    if (!finger) return
    finger.x = event.clientX
    finger.y = event.clientY
    finger.at = Date.now()
    const current = gesture.current
    if (!current) return
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return

    if (current.pinch && pointers.current.size >= 2 && current.startDistance > 0) {
      const [a, b] = [...pointers.current.values()]
      if (!a || !b) return
      const zoom =
        current.startTransform.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / current.startDistance)
      /*
       * Keep whatever was between the fingers when the pinch began between them
       * now — so the pinch carries the grid along as the hand moves, which every
       * real pinch does. Anchoring to the midpoint the pinch *started* at, as
       * this did, scales correctly and refuses to move an inch.
       */
      const held = {
        x: (current.startCentre.x - rect.left - current.startTransform.x) / current.startTransform.zoom,
        y: (current.startCentre.y - rect.top - current.startTransform.y) / current.startTransform.zoom,
      }
      setTransform(
        clamp({
          zoom,
          x: (a.x + b.x) / 2 - rect.left - held.x * zoom,
          y: (a.y + b.y) / 2 - rect.top - held.y * zoom,
        }),
      )
      return
    }
    if (current.pinch) return

    const dx = event.clientX - current.startCentre.x
    const dy = event.clientY - current.startCentre.y
    if (!finger.moved && Math.hypot(dx, dy) > 8) finger.moved = true
    if (!finger.moved) return
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
    if (pointers.current.size === 0) {
      gesture.current = null
      return
    }
    // A pinch that loses a finger becomes a drag by the one left behind. Without
    // re-seeding it, the remaining finger keeps working from the midpoint of a
    // pinch that is over, and the grid jumps.
    const [only] = [...pointers.current.values()]
    if (only) seedPan(only.x, only.y)
  }

  /** True when this pointer was a drag or part of a pinch, not a tap. */
  const wasDrag = (event: React.PointerEvent) => {
    const finger = pointers.current.get(event.pointerId)
    return !finger || finger.moved || finger.multi
  }

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
  const clueLayout = useMemo(() => {
    const sizes = new Map<string, number>()
    const boxes = new Map<string, { w: number; h: number }>()
    for (const cell of puzzle.cells) {
      if (cell.kind !== 'clue') continue
      const clues = cell.clues ?? []
      const shares = clueBoxes(clues.map((clue) => clue.text))
      clues.forEach((clue, k) => {
        const box = shares[k]
        if (!box) return
        boxes.set(clue.id, box)
        // A stacked half is capped below the full-square maximum too, so the two
        // definitions in one square are never set at wildly different sizes.
        const max = Math.min(CLUE_MAX, box.h * 0.62)
        sizes.set(clue.id, fitClueSize(clue.text, box.w, box.h, 3, max))
      })
    }
    return { sizes, boxes }
  }, [puzzle])
  const clueSizes = clueLayout.sizes

  /*
   * The zoom the *text* is laid out for, which lags the zoom the grid is drawn
   * at.
   *
   * Deciding what each definition says means measuring text, and doing that
   * inside the render means doing it on every frame of a pinch: a definition
   * that has to be shortened is re-measured each time the threshold moves, and
   * the frames where that happens run two to three times as long as the rest —
   * a hitch you feel as the zoom stuttering. Nothing needs it to be that
   * current. Between settling points the text simply scales with the grid like
   * everything else, which reads better than reflowing under the fingers, and a
   * beat after the gesture stops it is laid out again for where the zoom landed.
   */
  const [textZoom, setTextZoom] = useState(1)
  useEffect(() => {
    const id = setTimeout(() => setTextZoom(transform.zoom), 120)
    return () => clearTimeout(id)
  }, [transform.zoom])

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
  const floorSize = Math.ceil((LEGIBLE_PX / textZoom) * 4) / 4

  /*
   * The zoom at which nothing in this grid is cut short any more.
   *
   * This has to come from the definitions, not from the cell size. A fixed
   * "comfortable" zoom was picked once by eye at 1.2, and on a real page —
   * thirteen columns, most squares holding two definitions of about fifteen
   * characters — 1.2 still left every long definition ending in an ellipsis.
   * Reading is what the zoom is for, so the stop is the zoom at which the
   * smallest definition on the page clears the legibility floor, which for that
   * page is about 1.7. The cap keeps one monstrous definition from dragging the
   * whole grid in to a keyhole.
   */
  const readZoom = useMemo(() => {
    let smallest = Infinity
    for (const size of clueSizes.values()) smallest = Math.min(smallest, size)
    if (!Number.isFinite(smallest) || smallest <= 0) return Math.max(minZoom * 1.6, 1.4)
    return Math.min(2.6, Math.max(minZoom * 1.3, LEGIBLE_PX / smallest))
  }, [clueSizes, minZoom])

  /*
   * The stops the buttons move between: whole grid, reading, and closer still.
   *
   * This was one button that toggled between fitted and one zoom level, marked
   * with a plus. Pressing a plus twice took you in and then straight back out,
   * which reads as the control not having worked — and the way out of that is to
   * press it again, and again. Two buttons that always move in the direction
   * they are marked cannot do that.
   */
  const zoomStops = useMemo(() => {
    const stops = [minZoom, readZoom, Math.min(4, readZoom * 1.7)]
    return stops.filter((stop, i) => i === 0 || stop > stops[i - 1]! * 1.08)
  }, [minZoom, readZoom])

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

  /** Move to the next stop in one direction, from wherever a pinch left things. */
  const stepZoom = useCallback(
    (direction: 1 | -1) => {
      const current = transform.zoom
      const next =
        direction > 0
          ? zoomStops.find((stop) => stop > current * 1.04)
          : [...zoomStops].reverse().find((stop) => stop < current * 0.96)
      zoomTo(next ?? (direction > 0 ? Math.min(4, current * 1.5) : Math.max(minZoom, current / 1.5)))
    },
    [transform.zoom, zoomStops, zoomTo, minZoom],
  )

  const canZoomIn = transform.zoom < 3.98
  const canZoomOut = transform.zoom > minZoom * 1.02

  /*
   * There is deliberately no double-tap-to-zoom.
   *
   * It was tried and taken out. Two taps on one square already mean something
   * here — usePlayState switches to the crossing answer, which is how you change
   * direction — and two taps on *neighbouring* squares are simply how a grid
   * gets filled in, with a square only 27 px across when the grid is fitted. A
   * zoom gesture laid over either of those turns ordinary play into the grid
   * jumping about. The buttons do this job without ambiguity.
   */

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

            const handleTap = (event: React.PointerEvent) => {
              if (wasDrag(event)) return
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
                      const box = clueLayout.boxes.get(clue.id)!
                      let size = clueSizes.get(clue.id) ?? 0
                      let text: string | null = clue.text.trim()
                      if (!text) {
                        size = Math.min(CLUE_MAX, box.h * 0.6)
                        text = '—'
                      } else if (size < floorSize) {
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
      <div
        className="grid-zoom"
        // The grid itself listens on pointer events, so the controls have to
        // keep their own out of the pan/tap machinery.
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => stepZoom(1)}
          disabled={!canZoomIn}
          aria-label="Agrandir"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => stepZoom(-1)}
          disabled={!canZoomOut}
          aria-label="Réduire"
        >
          −
        </button>
      </div>
    </div>
  )
}
