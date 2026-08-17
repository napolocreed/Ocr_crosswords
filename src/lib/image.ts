/**
 * Image primitives for the import pipeline.
 *
 * Everything here is a pure function over plain typed arrays — no canvas, no
 * DOM — so the same code runs in the browser and in the Node test harness
 * (scripts/dev-detect.mjs) against real magazine photos.
 */

export interface GrayImage {
  data: Uint8Array
  width: number
  height: number
}

/** 1 = ink (dark), 0 = paper. */
export interface BinaryImage {
  data: Uint8Array
  width: number
  height: number
}

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

export function toGray(img: RgbaImage): GrayImage {
  const { data, width, height } = img
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // Rec. 601 luma, integer weights.
    out[i] = (data[p]! * 77 + data[p + 1]! * 150 + data[p + 2]! * 29) >> 8
  }
  return { data: out, width, height }
}

export function grayToRgba(img: GrayImage): RgbaImage {
  const out = new Uint8ClampedArray(img.width * img.height * 4)
  for (let i = 0, p = 0; i < img.data.length; i++, p += 4) {
    const v = img.data[i]!
    out[p] = v
    out[p + 1] = v
    out[p + 2] = v
    out[p + 3] = 255
  }
  return { data: out, width: img.width, height: img.height }
}

/** Rotates by a multiple of 90° clockwise. Photos of magazines are very often
 *  taken sideways, so the import flow needs this before anything else. */
export function rotateRgba(img: RgbaImage, quarterTurns: number): RgbaImage {
  const turns = ((quarterTurns % 4) + 4) % 4
  if (turns === 0) return img
  const { width: w, height: h, data } = img
  const swap = turns % 2 === 1
  const ow = swap ? h : w
  const oh = swap ? w : h
  const out = new Uint8ClampedArray(ow * oh * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ox: number
      let oy: number
      if (turns === 1) {
        ox = h - 1 - y
        oy = x
      } else if (turns === 2) {
        ox = w - 1 - x
        oy = h - 1 - y
      } else {
        ox = y
        oy = w - 1 - x
      }
      const src = (y * w + x) * 4
      const dst = (oy * ow + ox) * 4
      out[dst] = data[src]!
      out[dst + 1] = data[src + 1]!
      out[dst + 2] = data[src + 2]!
      out[dst + 3] = data[src + 3]!
    }
  }
  return { data: out, width: ow, height: oh }
}

/** Box-filter downscale so the longest side is at most `maxDim`. */
export function downscaleGray(img: GrayImage, maxDim: number): GrayImage {
  const scale = maxDim / Math.max(img.width, img.height)
  if (scale >= 1) return img
  const ow = Math.max(1, Math.round(img.width * scale))
  const oh = Math.max(1, Math.round(img.height * scale))
  const out = new Uint8Array(ow * oh)
  const xRatio = img.width / ow
  const yRatio = img.height / oh
  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor(oy * yRatio)
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((oy + 1) * yRatio)))
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor(ox * xRatio)
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((ox + 1) * xRatio)))
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        const row = y * img.width
        for (let x = x0; x < x1; x++) {
          sum += img.data[row + x]!
          n++
        }
      }
      out[oy * ow + ox] = (sum / n) | 0
    }
  }
  return { data: out, width: ow, height: oh }
}

/** Summed-area table, one cell of padding on the top/left. */
function integralImage(img: GrayImage): Float64Array {
  const { width: w, height: h, data } = img
  const sat = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    const src = y * w
    const cur = (y + 1) * (w + 1)
    const prev = y * (w + 1)
    for (let x = 0; x < w; x++) {
      rowSum += data[src + x]!
      sat[cur + x + 1] = sat[prev + x + 1]! + rowSum
    }
  }
  return sat
}

/**
 * Bradley–Roth adaptive threshold. Essential here: magazine photos taken by
 * hand have a shadow gradient across the page that a global threshold would
 * turn into a solid black corner.
 *
 * @param windowFraction window side as a fraction of the longest side
 * @param t how far below the local mean a pixel must be to count as ink
 */
export function adaptiveThreshold(
  img: GrayImage,
  windowFraction = 0.05,
  t = 0.12,
): BinaryImage {
  const { width: w, height: h, data } = img
  const sat = integralImage(img)
  const half = Math.max(2, Math.round((Math.max(w, h) * windowFraction) / 2))
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half)
    const y1 = Math.min(h - 1, y + half)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half)
      const x1 = Math.min(w - 1, x + half)
      const area = (x1 - x0 + 1) * (y1 - y0 + 1)
      const sum =
        sat[(y1 + 1) * (w + 1) + x1 + 1]! -
        sat[y0 * (w + 1) + x1 + 1]! -
        sat[(y1 + 1) * (w + 1) + x0]! +
        sat[y0 * (w + 1) + x0]!
      const mean = sum / area
      out[y * w + x] = data[y * w + x]! < mean * (1 - t) ? 1 : 0
    }
  }
  return { data: out, width: w, height: h }
}

export function binaryToRgba(img: BinaryImage): RgbaImage {
  const out = new Uint8ClampedArray(img.width * img.height * 4)
  for (let i = 0, p = 0; i < img.data.length; i++, p += 4) {
    const v = img.data[i] ? 0 : 255
    out[p] = v
    out[p + 1] = v
    out[p + 2] = v
    out[p + 3] = 255
  }
  return { data: out, width: img.width, height: img.height }
}

export type Quad = [Point, Point, Point, Point]
export interface Point {
  x: number
  y: number
}

/**
 * Solves the 8×8 system giving the homography that maps the unit-ish
 * destination rectangle corners to the four source points. Returns the
 * coefficients of the *inverse* mapping (destination → source) so warping is a
 * simple per-pixel lookup.
 */
export function homographyDstToSrc(quad: Quad, outW: number, outH: number): number[] {
  const dst: Point[] = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ]
  // Solve for h in: src = H * dst, with h8 fixed to 1.
  const a: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = dst[i]!
    const { x: u, y: v } = quad[i]!
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u])
    b.push(u)
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v])
    b.push(v)
  }
  return solveLinear(a, b)
}

/** Gaussian elimination with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]!])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r
    }
    const tmp = m[col]!
    m[col] = m[pivot]!
    m[pivot] = tmp
    const pv = m[col]![col]!
    if (Math.abs(pv) < 1e-12) continue
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = m[r]![col]! / pv
      if (factor === 0) continue
      for (let k = col; k <= n; k++) m[r]![k]! -= factor * m[col]![k]!
    }
  }
  return Array.from({ length: n }, (_, i) => {
    const d = m[i]![i]!
    return Math.abs(d) < 1e-12 ? 0 : m[i]![n]! / d
  })
}

/** Straightens the region inside `quad` into an `outW`×`outH` image. */
export function warpPerspectiveRgba(
  src: RgbaImage,
  quad: Quad,
  outW: number,
  outH: number,
): RgbaImage {
  const h = homographyDstToSrc(quad, outW, outH)
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const out = new Uint8ClampedArray(outW * outH * 4)
  const { data, width: sw, height: sh } = src
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const denom = h6 * x + h7 * y + 1
      const sx = (h0 * x + h1 * y + h2) / denom
      const sy = (h3 * x + h4 * y + h5) / denom
      const dst = (y * outW + x) * 4
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
        out[dst] = 255
        out[dst + 1] = 255
        out[dst + 2] = 255
        out[dst + 3] = 255
        continue
      }
      // Bilinear sample.
      const x0 = sx | 0
      const y0 = sy | 0
      const fx = sx - x0
      const fy = sy - y0
      const i00 = (y0 * sw + x0) * 4
      const i10 = i00 + 4
      const i01 = i00 + sw * 4
      const i11 = i01 + 4
      for (let ch = 0; ch < 3; ch++) {
        const top = data[i00 + ch]! * (1 - fx) + data[i10 + ch]! * fx
        const bottom = data[i01 + ch]! * (1 - fx) + data[i11 + ch]! * fx
        out[dst + ch] = top * (1 - fy) + bottom * fy
      }
      out[dst + 3] = 255
    }
  }
  return { data: out, width: outW, height: outH }
}

/** Extracts a sub-rectangle, clamped to the image bounds. */
export function cropRgba(
  src: RgbaImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): RgbaImage {
  const ax = Math.max(0, Math.min(src.width - 1, Math.round(x0)))
  const ay = Math.max(0, Math.min(src.height - 1, Math.round(y0)))
  const bx = Math.max(ax + 1, Math.min(src.width, Math.round(x1)))
  const by = Math.max(ay + 1, Math.min(src.height, Math.round(y1)))
  const w = bx - ax
  const h = by - ay
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const srcStart = ((ay + y) * src.width + ax) * 4
    out.set(src.data.subarray(srcStart, srcStart + w * 4), y * w * 4)
  }
  return { data: out, width: w, height: h }
}

/** Extracts a sub-rectangle of a grayscale image, clamped to its bounds. */
export function cropGray(
  img: GrayImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): GrayImage {
  const ax = Math.max(0, Math.min(img.width - 1, Math.round(x0)))
  const ay = Math.max(0, Math.min(img.height - 1, Math.round(y0)))
  const bx = Math.max(ax + 1, Math.min(img.width, Math.round(x1)))
  const by = Math.max(ay + 1, Math.min(img.height, Math.round(y1)))
  const w = bx - ax
  const h = by - ay
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const start = (ay + y) * img.width + ax
    out.set(img.data.subarray(start, start + w), y * w)
  }
  return { data: out, width: w, height: h }
}

/** Bilinear upscale of a grayscale image by an integer-ish factor. */
export function scaleGray(img: GrayImage, factor: number): GrayImage {
  if (factor === 1) return img
  const ow = Math.max(1, Math.round(img.width * factor))
  const oh = Math.max(1, Math.round(img.height * factor))
  const out = new Uint8Array(ow * oh)
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(img.height - 1, (y + 0.5) / factor - 0.5)
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(img.height - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(img.width - 1, (x + 0.5) / factor - 0.5)
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(img.width - 1, x0 + 1)
      const fx = sx - x0
      const top =
        img.data[y0 * img.width + x0]! * (1 - fx) + img.data[y0 * img.width + x1]! * fx
      const bottom =
        img.data[y1 * img.width + x0]! * (1 - fx) + img.data[y1 * img.width + x1]! * fx
      out[y * ow + x] = top * (1 - fy) + bottom * fy
    }
  }
  return { data: out, width: ow, height: oh }
}

/**
 * Finds the bounding box of the *text* in a cell crop, ignoring printed rules.
 *
 * This is what makes OCR tolerant of the grid geometry being a few percent off:
 * rather than trusting the detected cell bounds, the crop is re-centred on the
 * ink actually present. Long runs are stripped first, so the cell's own frame
 * and any internal hairline do not drag the box out to the full crop.
 *
 * @returns the box, or null when there is too little ink to be text
 */
function inkBounds(
  gray: GrayImage,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const bin = adaptiveThreshold(gray, 0.4, 0.1)
  const { width: w, height: h } = bin
  // A rule spans most of the cell; a letter stroke never does.
  const runLimitX = Math.max(6, Math.round(w * 0.55))
  const runLimitY = Math.max(6, Math.round(h * 0.55))

  const isText = new Uint8Array(w * h)
  isText.set(bin.data)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let start = -1
    for (let x = 0; x <= w; x++) {
      const ink = x < w && bin.data[row + x] === 1
      if (ink) {
        if (start < 0) start = x
      } else if (start >= 0) {
        if (x - start >= runLimitX) isText.fill(0, row + start, row + x)
        start = -1
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let start = -1
    for (let y = 0; y <= h; y++) {
      const ink = y < h && bin.data[y * w + x] === 1
      if (ink) {
        if (start < 0) start = y
      } else if (start >= 0) {
        if (y - start >= runLimitY) {
          for (let yy = start; yy < y; yy++) isText[yy * w + x] = 0
        }
        start = -1
      }
    }
  }

  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  let count = 0
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (!isText[row + x]) continue
      count++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  // Too little ink to be a definition: leave the crop alone.
  if (count < w * h * 0.008 || x1 <= x0 || y1 <= y0) return null
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

/**
 * Prepares a clue-cell crop for OCR: re-centre on the printed text, upscale so
 * the x-height lands in the range Tesseract is trained for, binarise locally to
 * kill the paper's shading, then pad with white so glyphs are not flush against
 * the frame edge.
 *
 * @param targetHeight height in pixels the crop should be scaled up to
 */
export function preprocessForOcr(crop: RgbaImage, targetHeight = 220): RgbaImage {
  let gray = toGray(crop)
  const bounds = inkBounds(gray)
  if (bounds) {
    // A little slack, so accents and descenders are never shaved off.
    const slack = Math.max(2, Math.round(Math.min(gray.width, gray.height) * 0.04))
    gray = cropGray(
      gray,
      bounds.x0 - slack,
      bounds.y0 - slack,
      bounds.x1 + slack,
      bounds.y1 + slack,
    )
  }
  const factor = Math.min(6, Math.max(1, targetHeight / Math.max(1, gray.height)))
  const scaled = scaleGray(gray, factor)
  // A generous window: definition text is dense, so a small window would erase
  // the middle of thick letters.
  const bin = adaptiveThreshold(scaled, 0.35, 0.1)

  const pad = 12
  const w = bin.width + pad * 2
  const h = bin.height + pad * 2
  const out = new Uint8ClampedArray(w * h * 4).fill(255)
  for (let y = 0; y < bin.height; y++) {
    for (let x = 0; x < bin.width; x++) {
      if (!bin.data[y * bin.width + x]) continue
      const p = ((y + pad) * w + (x + pad)) * 4
      out[p] = 0
      out[p + 1] = 0
      out[p + 2] = 0
    }
  }
  return { data: out, width: w, height: h }
}
