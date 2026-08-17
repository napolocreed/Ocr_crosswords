#!/usr/bin/env node
/**
 * Generates the PWA icons with no image dependency: pixels are rasterised by
 * hand and written out as PNG (zlib is in Node core).
 *
 * The mark is a small arrowword fragment — dark clue squares with an arrow,
 * light letter squares — which reads clearly even at 48px.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const iconDir = join(root, 'public', 'icons')

const BG = [0x12, 0x15, 0x1c]
const CLUE = [0x2c, 0x33, 0x42]
const LETTER = [0xf4, 0xf6, 0xfa]
const ACCENT = [0x4c, 0x9f, 0xff]

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0 // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 4x4 layout: 'c' clue square, 'l' letter square, 'a' clue square with arrow. */
const LAYOUT = [
  ['a', 'l', 'l', 'l'],
  ['c', 'l', 'c', 'l'],
  ['l', 'l', 'l', 'l'],
  ['l', 'c', 'l', 'l'],
]

function render(size, { padRatio }) {
  const px = Buffer.alloc(size * size * 4)
  const pad = Math.round(size * padRatio)
  const inner = size - pad * 2
  const cell = inner / 4
  const gap = Math.max(1, Math.round(size * 0.012))
  const radius = Math.round(size * 0.055)

  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = 255
  }

  // Background with rounded corners (transparent outside for maskable safety).
  const rr = Math.round(size * 0.19)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - 1 - x)
      const dy = Math.min(y, size - 1 - y)
      if (dx < rr && dy < rr) {
        const d = Math.hypot(rr - dx, rr - dy)
        if (d > rr) continue
      }
      set(x, y, BG)
    }
  }

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const kind = LAYOUT[row][col]
      const colour = kind === 'l' ? LETTER : CLUE
      const x0 = pad + col * cell + gap / 2
      const y0 = pad + row * cell + gap / 2
      const x1 = pad + (col + 1) * cell - gap / 2
      const y1 = pad + (row + 1) * cell - gap / 2
      for (let y = Math.round(y0); y < Math.round(y1); y++) {
        for (let x = Math.round(x0); x < Math.round(x1); x++) {
          const dx = Math.min(x - x0, x1 - 1 - x)
          const dy = Math.min(y - y0, y1 - 1 - y)
          if (dx < radius && dy < radius && Math.hypot(radius - dx, radius - dy) > radius) continue
          set(x, y, colour)
        }
      }
      if (kind === 'a') {
        // Arrow pointing right, sitting on the clue square's right edge.
        const cy = (y0 + y1) / 2
        const tip = x1 - cell * 0.12
        const len = cell * 0.42
        const half = cell * 0.2
        for (let x = Math.round(tip - len); x < Math.round(tip); x++) {
          const t = (x - (tip - len)) / len
          const h = Math.max(1, half * (1 - t))
          for (let y = Math.round(cy - h); y < Math.round(cy + h); y++) set(x, y, ACCENT)
        }
      }
    }
  }
  return px
}

mkdirSync(iconDir, { recursive: true })
const targets = [
  ['icon-192.png', 192, 0.14],
  ['icon-512.png', 512, 0.14],
  // Maskable icons need their content inside the safe zone (~80% centre).
  ['icon-512-maskable.png', 512, 0.24],
]
for (const [name, size, padRatio] of targets) {
  writeFileSync(join(iconDir, name), encodePng(size, size, render(size, { padRatio })))
  console.log(`[icons] ${name} ${size}x${size}`)
}
