#!/usr/bin/env node
/**
 * Reports what the boundary chain actually found, per photo: how many rules it
 * saw versus reconstructed, the pitch it settled on, and how much of the image
 * the resulting grid spans.
 *
 * The span is the telling number. A chain that stops short leaves the printed grid
 * partly outside the detected one, and no amount of good alignment on the cells
 * it did find will show that up — those cells are all correctly placed.
 */
import { readFileSync } from 'node:fs'
import jpeg from 'jpeg-js'
import { toGray, downscaleGray, grayToRgba, adaptiveThreshold, warpPerspectiveRgba } from '../src/lib/image.ts'
import { detectBoundaries } from '../src/lib/gridGeometry.ts'
import { suggestQuad } from '../src/lib/importPipeline.ts'

for (const file of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
  const decoded = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true })
  let photo = { data: decoded.data, width: decoded.width, height: decoded.height }
  const source = `${photo.width}x${photo.height}`
  if (Math.max(photo.width, photo.height) > 2400) photo = grayToRgba(downscaleGray(toGray(photo), 2400))
  const quad = suggestQuad(photo)
  const qw = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y)
  const qh = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y)
  const s = 1400 / Math.max(qw, qh)
  const w = Math.round(qw * s)
  const h = Math.round(qh * s)
  const gray = toGray(warpPerspectiveRgba(photo, quad, w, h))
  const bin = adaptiveThreshold(gray, 0.05, 0.12)

  const rows = detectBoundaries(bin, 'rows')
  const cols = detectBoundaries(bin, 'cols')
  const span = (b, extent) => {
    if (!b.curves.length) return '—'
    const first = Math.min(...b.curves[0])
    const last = Math.max(...b.curves[b.curves.length - 1])
    return `${first.toFixed(0)}..${last.toFixed(0)} of ${extent} (${(((last - first) / extent) * 100).toFixed(0)}%)`
  }
  console.log(
    `${file.split('/').pop()}  source ${source}, straightened ${w}x${h}\n` +
      `  rows  ${String(rows.curves.length).padStart(3)} boundaries, ` +
      `${rows.hits} seen / ${rows.curves.length - rows.hits} reconstructed, ` +
      `pitch ${rows.pitch.toFixed(1)}, tilt ${((rows.tilt * 180) / Math.PI).toFixed(2)}deg\n` +
      `        spans ${span(rows, h)}\n` +
      `  cols  ${String(cols.curves.length).padStart(3)} boundaries, ` +
      `${cols.hits} seen / ${cols.curves.length - cols.hits} reconstructed, ` +
      `pitch ${cols.pitch.toFixed(1)}, tilt ${((cols.tilt * 180) / Math.PI).toFixed(2)}deg\n` +
      `        spans ${span(cols, w)}`,
  )
}
