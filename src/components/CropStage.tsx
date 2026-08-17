import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Point, Quad, RgbaImage } from '../lib/image'
import { toImageData } from '../lib/canvas'

/**
 * The crop step: the photo with four draggable corners.
 *
 * This is the one place where a few seconds of human input removes several hard
 * computer-vision problems at once — page tilt, perspective, the magazine's
 * header and logo, and the dark background around the page. Detection copes
 * without it, but it copes far better with it, so the interaction is made as
 * cheap as possible: big handles, offset labels, and a live outline.
 */

interface Props {
  image: RgbaImage
  quad: Quad
  onChange: (quad: Quad) => void
}

/** Touch target radius, in CSS pixels. */
const HANDLE = 26

export function CropStage({ image, quad, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState({ scale: 1, width: 0, height: 0 })
  const dragging = useRef<number | null>(null)

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
      const scale = Math.min(rect.width / image.width, rect.height / image.height)
      setLayout({
        scale,
        width: image.width * scale,
        height: image.height * scale,
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [image.width, image.height])

  const toView = (point: Point) => ({ x: point.x * layout.scale, y: point.y * layout.scale })

  const moveCorner = (index: number, clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(image.width, (clientX - rect.left) / layout.scale))
    const y = Math.max(0, Math.min(image.height, (clientY - rect.top) / layout.scale))
    const next = quad.slice() as Quad
    next[index] = { x, y }
    onChange(next)
  }

  const onPointerDown = (index: number) => (event: React.PointerEvent) => {
    event.preventDefault()
    dragging.current = index
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (dragging.current === null) return
    event.preventDefault()
    moveCorner(dragging.current, event.clientX, event.clientY)
  }

  const onPointerUp = () => {
    dragging.current = null
  }

  const view = quad.map(toView)
  const path = view.map((point) => `${point.x},${point.y}`).join(' ')

  return (
    <div className="stage" ref={wrapRef}>
      <div style={{ position: 'relative', width: layout.width, height: layout.height }}>
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
          {view.map((point, index) => (
            <g key={index} onPointerDown={onPointerDown(index)} style={{ cursor: 'grab' }}>
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
      </div>
    </div>
  )
}
