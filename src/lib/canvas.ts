import type { RgbaImage } from './image'

/**
 * Browser-side bridge between DOM images and the pure pixel helpers in
 * `image.ts`. Kept separate so the pipeline logic stays testable in Node.
 */

/** Decodes a picked file, honouring EXIF orientation where the browser does. */
export async function decodeImageFile(file: Blob): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable')
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    return { data: data.data, width: data.width, height: data.height }
  } finally {
    bitmap.close()
  }
}

/** Longest-side-limited decode, to keep memory sane on large phone photos. */
export async function decodeImageFileScaled(
  file: Blob,
  maxDim: number,
): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable')
    ctx.drawImage(bitmap, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h)
    return { data: data.data, width: data.width, height: data.height }
  } finally {
    bitmap.close()
  }
}

/**
 * Wraps pixels in an ImageData. The copy is deliberate: our buffers may be
 * backed by a SharedArrayBuffer, which ImageData does not accept.
 */
export function toImageData(img: RgbaImage): ImageData {
  const bytes = new Uint8ClampedArray(img.width * img.height * 4)
  bytes.set(img.data.subarray(0, bytes.length))
  return new ImageData(bytes, img.width, img.height)
}

function toCanvas(img: RgbaImage): OffscreenCanvas {
  const canvas = new OffscreenCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable')
  ctx.putImageData(toImageData(img), 0, 0)
  return canvas
}

export async function toBlob(img: RgbaImage, quality = 0.8): Promise<Blob> {
  return toCanvas(img).convertToBlob({ type: 'image/jpeg', quality })
}

/** Data URL of an image, downscaled to `maxDim` — used for cell crops. */
export async function toDataUrl(
  img: RgbaImage,
  maxDim = 320,
  quality = 0.72,
): Promise<string> {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const source = toCanvas(img)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable')
  ctx.drawImage(source, 0, 0, w, h)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return blobToDataUrl(blob)
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Lecture impossible'))
    reader.readAsDataURL(blob)
  })
}

/** Yields to the event loop so long pipelines keep the UI responsive. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
}
