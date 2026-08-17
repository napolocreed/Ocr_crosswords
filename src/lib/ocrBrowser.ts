import { OcrEngine } from './ocr'
import { getSetting } from './db'

/**
 * Browser wiring for the OCR engine: every asset is served from our own origin
 * under `public/tesseract/`, so recognition works with no network at all.
 */

const base = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`

export const OCR_ASSETS = {
  worker: `${base}tesseract/worker.min.js`,
  core: `${base}tesseract/`,
  lang: `${base}tesseract/lang`,
} as const

export async function createBrowserOcrEngine(): Promise<OcrEngine> {
  const uppercase = await getSetting('ocr.uppercase', true)
  return new OcrEngine({
    workerPath: OCR_ASSETS.worker,
    corePath: OCR_ASSETS.core,
    langPath: OCR_ASSETS.lang,
    uppercase,
  })
}

/**
 * Warms the cache by actually starting the engine once.
 *
 * Fetching a hard-coded file list would be wrong here: tesseract.js probes the
 * browser and loads one of three wasm cores depending on the SIMD support it
 * finds, so only a real initialisation pulls in exactly the right variant — and
 * proves it works, rather than assuming it.
 */
export async function primeOcrEngine(onProgress?: (ratio: number) => void): Promise<void> {
  const engine = await createBrowserOcrEngine()
  try {
    await engine.init((ratio) => onProgress?.(Math.min(0.9, ratio * 0.9)))
    // One trivial recognition, so the language data is loaded too.
    const canvas = new OffscreenCanvas(8, 8)
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, 8, 8)
      await engine.recognize(await canvas.convertToBlob({ type: 'image/png' }))
    }
    onProgress?.(1)
  } finally {
    await engine.terminate()
  }
}

/** Files the engine always needs, whichever wasm core the browser picks. */
const ALWAYS_NEEDED = ['tesseract/worker.min.js', 'tesseract/lang/fra.traineddata']

/**
 * Whether the engine looks usable offline: the worker and the language data are
 * cached, plus at least one wasm core.
 */
export async function isOcrEngineCached(): Promise<boolean> {
  if (!('caches' in globalThis)) return false
  try {
    for (const key of await caches.keys()) {
      const cache = await caches.open(key)
      const essentials = await Promise.all(
        ALWAYS_NEEDED.map((file) => cache.match(`${base}${file}`)),
      )
      if (!essentials.every(Boolean)) continue
      const entries = await cache.keys()
      const hasCore = entries.some((request) => /tesseract-core-.*\.wasm$/.test(request.url))
      if (hasCore) return true
    }
  } catch {
    return false
  }
  return false
}
