import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Point, Quad, RgbaImage } from '../lib/image'
import { toImageData } from '../lib/canvas'

/**
 * The crop step: the photo with four draggable corners and four draggable edges.
 *
 * This is the one place where a few seconds of human input removes several hard
 * computer-vision problems at once — page tilt, perspective, the magazine's
 * header and logo, and the dark background around the page. Detection copes
 * without it, but it copes far better with it.
 *
 * It is also the only step that asks a person for precision, which on a phone is
 * asking a lot, so three things are done about that. The photo is inset from the
 * stage rather than filling it, because a handle sitting on the screen's own edge
 * is unreachable: on Android an inward swipe from there is the system's back
 * gesture, and the drag never reaches the page at all. A loupe shows the corner
 * being placed, because a fingertip covers roughly the area that needs to be seen
 * to place it. And the edges drag too, which is what most adjustments actually
 * want — a crop is usually one side too wide, not one corner out of place.
 *
 * Deliberately *not* done: cropping automatically to the grid the detector finds.
 * That was built and measured, and it is unsafe — on two of five test photos it
 * cut the grid down (one from 17 columns to 8), because the detector's own extent
 * is what the crop would be trusting, and where that extent is already short,
 * tightening onto it bakes the mistake into the pixels where no later pass can
 * recover it. The slack it reacts to measures 8.1%, 8.9% and 9.4% on photos where
 * the outcome is catastrophic, harmful and helpful respectively, so no threshold
 * separates the cases either. The title bar reports what was detected instead, so
 * a good-enough crop is visible rather than guessed at.
 */

interface Props {
  image: RgbaImage
  quad: Quad
  onChange: (quad: Quad) => void
}

/** Touch target radius, in CSS pixels. */
const HANDLE = 28

/**
 * Gap kept between the photo and the stage's edges, in CSS pixels.
 *
 * Sized against Android's back-gesture strip, which claims the outer 20–24dp of
 * each side: a corner handle inside that strip cannot be dragged inward, because
 * the swipe leaves the app instead. The photo used to be scaled to fit exactly,
 * which put two of the four corners right in it.
 */
const GUTTER = 34

/** Magnification of the loupe, and its radius in CSS pixels. */
const LOUPE_ZOOM = 3
const LOUPE_R = 52

type Grab = { kind: 'corner'; index: number } | { kind: 'edge'; index: number }

export function CropStage({ image, quad, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const loupeRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState({ scale: 1, width: 0, height: 0 })
  const grab = useRef<Grab | null>(null)
  const start = useRef<{ quad: Quad; x: number; y: number } | null>(null)
  const [loupe, setLoupe] = useState<Point | null>(null)

  // Paint the photo once per image; the outline is a separate SVG overlay so
  // dragging never repaints pixels.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.putImageData(toImageData(image), 0, 0)
  }, [image])

  useLayoutEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      const room = {
        width: Math.max(32, rect.width - GUTTER * 2),
        height: Math.max(32, rect.height - GUTTER * 2),
      }
      const scale = Math.min(room.width / image.width, room.height / image.height)
      setLayout({ scale, width: image.width * scale, height: image.height * scale })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [image.width, image.height])

  const toView = (point: Point) => ({ x: point.x * layout.scale, y: point.y * layout.scale })

  /** Pointer position in the photo's own pixels, clamped to it. */
  const toImage = (clientX: number, clientY: number): Point | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(image.width, (clientX - rect.left) / layout.scale)),
      y: Math.max(0, Math.min(image.height, (clientY - rect.top) / layout.scale)),
    }
  }

  /** Redraws the loupe around a point of the photo. */
  const drawLoupe = (at: Point) => {
    const source = canvasRef.current
    const canvas = loupeRef.current
    if (!source || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const side = LOUPE_R * 2
    // The window shown is the loupe's own size divided by the zoom, in photo
    // pixels, so the magnification is honest whatever the fit scale is.
    const window = side / (LOUPE_ZOOM * layout.scale)
    canvas.width = side
    canvas.height = side
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#0a0c11'
    ctx.fillRect(0, 0, side, side)
    ctx.drawImage(source, at.x - window / 2, at.y - window / 2, window, window, 0, 0, side, side)
    // Crosshair, so the corner can be placed on a rule rather than near it.
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(side / 2, side / 2 - 12)
    ctx.lineTo(side / 2, side / 2 + 12)
    ctx.moveTo(side / 2 - 12, side / 2)
    ctx.lineTo(side / 2 + 12, side / 2)
    ctx.stroke()
  }

  const apply = (clientX: number, clientY: number) => {
    const held = grab.current
    const from = start.current
    const at = toImage(clientX, clientY)
    if (!held || !from || !at) return

    const next = from.quad.map((point) => ({ ...point })) as Quad
    if (held.kind === 'corner') {
      next[held.index] = at
      setLoupe(at)
    } else {
      // An edge carries its two corners, moved by the same amount — so widening
      // one side does not tilt the other three.
      const dx = at.x - from.x
      const dy = at.y - from.y
      const pair = [held.index, (held.index + 1) % 4]
      for (const i of pair) {
        next[i] = {
          x: Math.max(0, Math.min(image.width, from.quad[i]!.x + dx)),
          y: Math.max(0, Math.min(image.height, from.quad[i]!.y + dy)),
        }
      }
      setLoupe(next[held.index]!)
    }
    onChange(next)
  }

  const onPointerDown = (held: Grab) => (event: React.PointerEvent) => {
    event.preventDefault()
    const at = toImage(event.clientX, event.clientY)
    if (!at) return
    grab.current = held
    start.current = { quad: quad.map((p) => ({ ...p })) as Quad, x: at.x, y: at.y }
    setLoupe(held.kind === 'corner' ? quad[held.index]! : at)
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!grab.current) return
    event.preventDefault()
    apply(event.clientX, event.clientY)
  }

  const onPointerUp = () => {
    grab.current = null
    start.current = null
    setLoupe(null)
  }

  useEffect(() => {
    if (loupe) drawLoupe(loupe)
  })

  const view = quad.map(toView)
  const path = view.map((point) => `${point.x},${point.y}`).join(' ')
  /** Midpoints, where the edge handles sit. */
  const mids = view.map((point, i) => {
    const next = view[(i + 1) % 4]!
    return { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 }
  })

  // Keep the loupe away from the finger: it sits at the top unless the corner
  // being dragged is itself near the top.
  const loupeView = loupe ? toView(loupe) : null
  const loupeTop = loupeView !== null && loupeView.y < layout.height * 0.4

  return (
    <div className="stage" ref={wrapRef}>
      <div className="crop-frame" style={{ width: layout.width, height: layout.height }}>
        <canvas ref={canvasRef} style={{ width: layout.width, height: layout.height }} />
        <svg
          className="crop-layer"
          width={layout.width}
          height={layout.height}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ touchAction: 'none' }}
        >
          {/* Everything outside the quad is dimmed, so the crop reads at a glance. */}
          <defs>
            <mask id="crop-mask">
              <rect width={layout.width} height={layout.height} fill="white" />
              <polygon points={path} fill="black" />
            </mask>
          </defs>
          <rect
            width={layout.width}
            height={layout.height}
            fill="rgba(6,8,12,0.62)"
            mask="url(#crop-mask)"
          />
          <polygon
            points={path}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeDasharray="7 5"
          />
          {mids.map((point, index) => (
            <g
              key={`edge-${index}`}
              onPointerDown={onPointerDown({ kind: 'edge', index })}
              style={{ cursor: 'move' }}
            >
              <circle cx={point.x} cy={point.y} r={HANDLE} fill="transparent" />
              <rect
                x={point.x - 9}
                y={point.y - 9}
                width={18}
                height={18}
                rx={5}
                fill="rgba(10,18,28,0.85)"
                stroke="var(--accent)"
                strokeWidth={2}
              />
            </g>
          ))}
          {view.map((point, index) => (
            <g
              key={`corner-${index}`}
              onPointerDown={onPointerDown({ kind: 'corner', index })}
              style={{ cursor: 'grab' }}
            >
              {/* Invisible disc widens the touch target well past the visible dot. */}
              <circle cx={point.x} cy={point.y} r={HANDLE} fill="transparent" />
              <circle
                cx={point.x}
                cy={point.y}
                r={11}
                fill="var(--accent)"
                stroke="#04121f"
                strokeWidth={2}
              />
            </g>
          ))}
        </svg>
        {loupe && (
          <canvas
            ref={loupeRef}
            className="crop-loupe"
            style={{
              width: LOUPE_R * 2,
              height: LOUPE_R * 2,
              top: loupeTop ? undefined : 8,
              bottom: loupeTop ? 8 : undefined,
              left: 8,
            }}
          />
        )}
      </div>
    </div>
  )
}
