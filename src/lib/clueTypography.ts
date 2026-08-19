/**
 * How large a definition can be printed inside its square, and what to show
 * when even the smallest useful size will not fit.
 *
 * Every definition used to be drawn at one size — 15% of the cell — picked so
 * that the longest of them would fit. Most definitions are far shorter than the
 * longest, so most squares were set several points smaller than they had room
 * for, and fitted to a phone screen the result was below the legibility floor
 * everywhere: the grid came up with no text in it at all. Measuring each
 * definition against its own box instead lets "NOTE" be set three times larger
 * than "COURS D'EAU DE SUISSE", which is what the magazines do as well.
 *
 * Measurement is done with a canvas rather than by counting characters, because
 * French definitions vary enormously in width for the same length (ÎLE against
 * MMM). Canvas metrics and CSS line-breaking are close but not identical, so
 * everything here fits into slightly less than the real box.
 */

/** Matches the cell rule in styles.css; the two have to agree to measure anything. */
const FONT = "600 $px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

/** Also from styles.css: `.cell .clue-text { line-height: 1.06 }`. */
const LINE_HEIGHT = 1.06

/**
 * And its `padding-top`, which keeps the accents on the first line's capitals
 * from being clipped away by the square.
 */
const ACCENT_ROOM = 0.12

/** Canvas metrics run a little narrow against real layout. Give the box some slack. */
const SAFETY = 0.94

/** Below this a shortened definition says nothing at all, so nothing is drawn. */
const MIN_USEFUL_CHARS = 3

const ELLIPSIS = '…'

let measurer: CanvasRenderingContext2D | null | undefined

function context(): CanvasRenderingContext2D | null {
  if (measurer !== undefined) return measurer
  try {
    measurer = document.createElement('canvas').getContext('2d')
  } catch {
    measurer = null
  }
  return measurer
}

const font = (size: number) => FONT.replace('$', String(size))

/**
 * Lines a greedy wrap needs for `text` at `size` in a box `width` wide.
 *
 * Mirrors `word-break: break-word`: a word wider than the box is split across
 * lines rather than allowed to overflow.
 */
function lineCount(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
  width: number,
): number {
  ctx.font = font(size)
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return 0
  let lines = 1
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (ctx.measureText(candidate).width <= width) {
      current = candidate
      continue
    }
    if (current) {
      lines += 1
      current = ''
    }
    if (ctx.measureText(word).width <= width) {
      current = word
      continue
    }
    let chunk = ''
    for (const character of word) {
      if (ctx.measureText(chunk + character).width <= width) {
        chunk += character
        continue
      }
      lines += 1
      chunk = character
    }
    current = chunk
  }
  return lines
}

function fitsIn(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
  width: number,
  height: number,
): boolean {
  if (size <= 0) return false
  return lineCount(ctx, text, size, width) * size * LINE_HEIGHT + size * ACCENT_ROOM <= height
}

/**
 * The largest size at which no word has to be broken across lines.
 *
 * Text that merely *fits* is not the goal. Set at the largest size its box would
 * take, "RIVIÈRE DE FRANCE" came out as RIVIERE / DE / FRANC / E — inside the
 * square, and unreadable at a glance, because a break with nothing marking it
 * reads as a different word. A step or two smaller, the same square holds
 * RIVIÈRE / DE / FRANCE: smaller type, and far quicker to read.
 */
function unbrokenSize(ctx: CanvasRenderingContext2D, text: string, width: number): number {
  ctx.font = font(100)
  let widest = 0
  for (const word of text.split(/\s+/)) {
    if (word) widest = Math.max(widest, ctx.measureText(word).width)
  }
  return widest > 0 ? (width * 100) / widest : Infinity
}

const fittedCache = new Map<string, number>()

/**
 * The largest size, in the grid's own units, at which the whole of `text` fits
 * in a `width` by `height` box without breaking a word. Bounded so a two-letter
 * definition does not turn into a headline.
 *
 * When even `min` would break a word — one long word in a narrow square — the
 * no-breaking rule is dropped rather than shrinking the definition to nothing.
 */
export function fitClueSize(
  text: string,
  width: number,
  height: number,
  min: number,
  max: number,
): number {
  const key = [text, width, height, min, max].join('|')
  const cached = fittedCache.get(key)
  if (cached !== undefined) return cached
  const ctx = context()
  let size = min
  if (ctx && text.trim()) {
    const boxW = width * SAFETY
    const boxH = height * SAFETY
    const unbroken = unbrokenSize(ctx, text, boxW)
    const ceiling = unbroken >= min ? Math.min(max, unbroken) : max
    if (fitsIn(ctx, text, ceiling, boxW, boxH)) {
      size = ceiling
    } else {
      // Eight bisections put the answer inside a hundredth of the range, which
      // is finer than the difference is visible.
      let lo = min
      let hi = ceiling
      for (let i = 0; i < 8; i += 1) {
        const mid = (lo + hi) / 2
        if (fitsIn(ctx, text, mid, boxW, boxH)) lo = mid
        else hi = mid
      }
      size = lo
    }
  }
  if (fittedCache.size > 6000) fittedCache.clear()
  fittedCache.set(key, size)
  return size
}

const shortenedCache = new Map<string, { text: string; size: number } | null>()

/**
 * As much of `text` as fits at a size that has already been fixed, cut short
 * with an ellipsis.
 *
 * This is the zoomed-out case: the definition cannot be shown whole at a size
 * anyone could read, and the choice is between its first words and a blank grey
 * square. The first words are worth a great deal — COURS D'EAU… is most of a
 * clue — so the square keeps them and gives up the rest. Whole words are kept
 * wherever possible, since a word broken without a mark reads as a different
 * word; only when the very first word is too wide for the square is it cut
 * inside, and then the ellipsis says so.
 *
 * Returns null when not even a few characters fit, which is the one case where
 * a blank square is the honest answer. `floor` is how far below `size` it may
 * go to keep a whole word.
 */
export function shortenClue(
  text: string,
  width: number,
  height: number,
  size: number,
  floor: number,
): { text: string; size: number } | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const key = [trimmed, width, height, size.toFixed(2), floor.toFixed(2)].join('|')
  const cached = shortenedCache.get(key)
  if (cached !== undefined) return cached

  /*
   * Try a few sizes across the allowed range and keep whichever shows the most.
   *
   * There is no single right size here, because the two things worth having
   * pull against each other. Whole words beat fragments: SYMBOLE DU… tells you
   * what the clue is and SYM… does not. But bigger type beats smaller, and one
   * of these squares is only wide enough for about four characters a line, so
   * going a step down can be the difference between DÉC… and DÉCHIF… Ranking
   * complete-word results above every fragment, and longer fragments above
   * shorter ones, settles it without a rule for each case.
   */
  const steps = [size, (size + floor) / 2, floor]
  let best: { text: string; size: number; rank: number } | null = null
  for (const step of steps) {
    const candidate = measureShortened(trimmed, step, width, height)
    if (!candidate) continue
    const rank = (candidate.whole ? 10000 : 0) + candidate.text.length
    // Strictly greater, and the steps run large to small, so an equally good
    // result keeps the larger type.
    if (!best || rank > best.rank) best = { text: candidate.text, size: step, rank }
  }
  const answer = best ? { text: best.text, size: best.size } : null

  if (shortenedCache.size > 6000) shortenedCache.clear()
  shortenedCache.set(key, answer)
  return answer
}

/** The shortened text, and whether it stops on a word boundary or inside one. */
function measureShortened(
  text: string,
  size: number,
  width: number,
  height: number,
): { text: string; whole: boolean } | null {
  const ctx = context()
  if (!ctx) return { text, whole: true }
  const boxW = width * SAFETY
  const boxH = height * SAFETY
  const lines = Math.floor((boxH - size * ACCENT_ROOM) / (size * LINE_HEIGHT))
  if (lines < 1) return null

  const fitsWhole = (candidate: string) =>
    unbrokenSize(ctx, candidate, boxW) >= size && lineCount(ctx, candidate, size, boxW) <= lines

  if (fitsWhole(text)) return { text, whole: true }

  // Longest run of whole words that still fits once the ellipsis is added.
  const words = text.split(/\s+/).filter(Boolean)
  for (let n = words.length - 1; n >= 1; n -= 1) {
    const candidate = words.slice(0, n).join(' ') + ELLIPSIS
    if (fitsWhole(candidate) && candidate.length - 1 >= MIN_USEFUL_CHARS) {
      return { text: candidate, whole: true }
    }
  }

  // Not even the first word fits the width, so cut inside it.
  const first = words[0] ?? ''
  ctx.font = font(size)
  let take = 0
  for (let n = 1; n <= first.length; n += 1) {
    if (ctx.measureText(first.slice(0, n) + ELLIPSIS).width > boxW) break
    take = n
  }
  return take >= MIN_USEFUL_CHARS ? { text: first.slice(0, take) + ELLIPSIS, whole: false } : null
}
