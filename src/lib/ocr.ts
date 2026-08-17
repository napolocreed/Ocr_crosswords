import { createWorker, PSM, type Worker } from 'tesseract.js'

/**
 * OCR of definition cells, French, entirely on-device.
 *
 * Magazine definitions are set in small uppercase type, which is both a
 * difficulty (few pixels per glyph) and an advantage: restricting Tesseract to
 * the uppercase alphabet removes most of its usual confusions. Everything the
 * engine needs is vendored under `public/tesseract/`, so this works with the
 * device in airplane mode.
 */

/** Uppercase French plus the punctuation that shows up in definitions. */
const UPPERCASE_WHITELIST =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÆŒ0123456789'’-.,()/ "

const MIXED_WHITELIST =
  UPPERCASE_WHITELIST + 'abcdefghijklmnopqrstuvwxyzàâäçéèêëîïôöùûüÿæœ'

export interface OcrOptions {
  /** Directory holding `fra.traineddata`, without a trailing slash. */
  langPath: string
  /** Directory holding the wasm cores. */
  corePath?: string
  /** Vendored `worker.min.js`. Omit in Node, where tesseract.js resolves it. */
  workerPath?: string
  /**
   * Restrict recognition to uppercase. True for virtually every French
   * magazine; turning it off helps on the rare lowercase grid.
   */
  uppercase?: boolean
  /**
   * Skip tesseract.js's own cache of the language data. Caching is what you
   * want in the browser — it saves re-downloading megabytes — but it also means
   * a cached copy silently wins over `langPath`, so comparing two models
   * requires turning it off.
   */
  noLanguageCache?: boolean
}

/** Anything tesseract.js accepts: canvas, Blob, Buffer, data URL, path. */
export type OcrInput = Parameters<Worker['recognize']>[0]

export interface OcrLine {
  text: string
  /** Tesseract's 0–100 confidence, rescaled to 0–1. */
  confidence: number
}

export class OcrEngine {
  private worker: Worker | null = null
  private ready: Promise<Worker> | null = null
  private currentPsm: PSM | null = null
  private readonly options: OcrOptions

  constructor(options: OcrOptions) {
    this.options = options
  }

  /** Boots the worker, downloading nothing beyond our own origin. */
  async init(onProgress?: (ratio: number) => void): Promise<void> {
    await this.getWorker(onProgress)
  }

  private getWorker(onProgress?: (ratio: number) => void): Promise<Worker> {
    this.ready ??= (async () => {
      const { langPath, corePath, workerPath, uppercase = true, noLanguageCache } = this.options
      const worker = await createWorker('fra', 1, {
        langPath,
        // `gzip: false` because we vendor the plain .traineddata rather than
        // the .gz the public CDN serves.
        gzip: false,
        ...(noLanguageCache ? { cacheMethod: 'none' as const } : {}),
        ...(corePath ? { corePath } : {}),
        ...(workerPath ? { workerPath } : {}),
        // tesseract.js rejects an explicitly undefined logger, so only set the
        // key when a callback was actually supplied.
        ...(onProgress
          ? {
              logger: (message: { progress?: number }) => {
                if (typeof message.progress === 'number') onProgress(message.progress)
              },
            }
          : {}),
      })
      // The French dictionary is left ON: definitions are made of real words,
      // and it recovers a lot of accents that the raw classifier drops.
      await worker.setParameters({
        tessedit_char_whitelist: uppercase ? UPPERCASE_WHITELIST : MIXED_WHITELIST,
        preserve_interword_spaces: '1',
      })
      this.worker = worker
      return worker
    })()
    return this.ready
  }

  /**
   * Reads one definition region.
   *
   * @param singleLine hint that the region holds a single line of text, which
   *   lets Tesseract skip layout analysis and get noticeably more accurate.
   */
  async recognize(input: OcrInput, singleLine = false): Promise<OcrLine> {
    const worker = await this.getWorker()
    const psm = singleLine ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK
    if (this.currentPsm !== psm) {
      await worker.setParameters({ tessedit_pageseg_mode: psm })
      this.currentPsm = psm
    }
    const { data } = await worker.recognize(input)
    return {
      text: cleanClueText(data.text),
      confidence: Math.max(0, Math.min(1, (data.confidence ?? 0) / 100)),
    }
  }

  async terminate(): Promise<void> {
    const worker = this.worker
    this.worker = null
    this.ready = null
    this.currentPsm = null
    await worker?.terminate()
  }
}

/** Digits Tesseract commonly substitutes for letters in small uppercase type. */
const DIGIT_TO_LETTER: Record<string, string> = {
  '0': 'O',
  '1': 'I',
  '5': 'S',
  '8': 'B',
  '6': 'G',
  '2': 'Z',
}

const STRAY_TO_LETTER: Record<string, string> = {
  '|': 'I',
  '!': 'I',
  '$': 'S',
  '£': 'E',
  '€': 'E',
  '@': 'A',
  '\\': 'I',
  '/': 'I',
  '{': 'C',
  '}': 'D',
  '[': 'C',
  ']': 'D',
  '<': 'C',
  '_': '-',
  '—': '-',
  '–': '-',
  '~': '-',
  '*': '',
  '#': '',
  '+': '',
  '=': '',
  '"': '',
  ';': ',',
  ':': '.',
}

/**
 * Tidies a raw OCR result into something a human can accept with one glance.
 *
 * The subtle part is digits: "1" for "I" is the single most common error, but a
 * definition genuinely can read "EN 2 MOTS". A digit is therefore only
 * rewritten when it sits inside a word, never when it stands alone.
 */
export function cleanClueText(raw: string): string {
  let text = raw
    .replace(/\r/g, '')
    // A definition wraps inside its cell; the line breaks carry no meaning.
    .replace(/[\n\t]+/g, ' ')
    .replace(/ /g, ' ')

  text = [...text].map((ch) => STRAY_TO_LETTER[ch] ?? ch).join('')
  text = text.replace(/’/g, "'")

  // Rewrite digits that are glued to letters.
  text = text.replace(/[0-9]/g, (digit, index) => {
    const before = text[index - 1] ?? ' '
    const after = text[index + 1] ?? ' '
    const isLetter = (ch: string) => /[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÆŒ]/i.test(ch)
    if (isLetter(before) || isLetter(after)) return DIGIT_TO_LETTER[digit] ?? digit
    return digit
  })

  return text
    .replace(/\s*'\s*/g, "'")
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[^A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÆŒ0-9(]+/i, '')
    .replace(/[^A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÆŒ0-9).]+$/i, '')
    .trim()
}

/**
 * Whether a string looks like a real French definition rather than noise.
 *
 * Used to sanity-check a whole import: upside-down type reads as confident
 * gibberish, so per-cell confidence cannot catch it but the shape of the results
 * as a group can.
 */
export function looksLikeWords(text: string): boolean {
  if (text.length < 4) return false
  if (!/^[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÆŒ' -]+$/.test(text)) return false
  return /[AEIOUYÀÂÄÉÈÊËÎÏÔÖÙÛÜ]/.test(text)
}

/**
 * How much to trust an OCR result, combining Tesseract's own confidence with
 * cheap sanity checks on the shape of the string. Definitions that come back
 * empty, single-character, or full of one-letter fragments are the ones worth
 * putting in front of the user first.
 */
export function scoreClueText(text: string, tesseractConfidence: number): number {
  if (!text) return 0
  let score = tesseractConfidence
  const words = text.split(/\s+/).filter(Boolean)
  if (text.length < 3) score *= 0.4
  const lonely = words.filter((w) => w.length === 1 && !/^[AÀYO]$/i.test(w)).length
  if (words.length > 0) score *= 1 - (0.5 * lonely) / words.length
  // Long runs of consonants signal garbage.
  if (/[BCDFGHJKLMNPQRSTVWXZ]{5,}/i.test(text)) score *= 0.6
  return Math.max(0, Math.min(1, score))
}
