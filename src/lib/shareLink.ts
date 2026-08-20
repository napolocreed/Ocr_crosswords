import type { Puzzle } from '../types'

/**
 * A grid folded into a URL, so sharing needs no server at all.
 *
 * The app is a static page on GitHub Pages, and the grids live in each phone's
 * own storage — there is nowhere to upload anything to. But a scanned and
 * corrected grid is small once its photo is left behind, and a URL fragment can
 * carry kilobytes: so the link *is* the grid. Deflate then base64url in the
 * `#g=` fragment; a 13×17 grid with its definitions comes out around 2–3 KB of
 * URL, comfortably inside what messaging apps pass along intact. The fragment
 * rather than a query string on purpose: fragments are never sent to the
 * server, so GitHub Pages serves the app exactly as always and the data stays
 * between the two phones.
 *
 * What travels is the puzzle alone — no photo, no thumbnail, and none of the
 * sender's answers. The photo is copyrighted magazine content and enormous;
 * the answers are the whole point of the game.
 */

const PARAM = '#g='

/** Bumped if the payload shape ever changes incompatibly. */
const LINK_VERSION = 1

interface LinkPayload {
  v: number
  puzzle: Puzzle
}

/* ------------------------------------------------------------- byte plumbing */

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function pump(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return pump(stream)
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return pump(stream)
}

/* ------------------------------------------------------------------ the link */

/**
 * The full URL to hand to a friend.
 *
 * Compression is skipped when the browser has no CompressionStream (it has been
 * everywhere since 2023, but a puzzle must never be unshareable): the payload is
 * then plain JSON behind a `-` marker, bigger but always openable.
 */
export async function buildShareLink(puzzle: Puzzle): Promise<string> {
  const { thumbnail: _dropped, ...bare } = puzzle
  const payload: LinkPayload = { v: LINK_VERSION, puzzle: bare }
  const json = new TextEncoder().encode(JSON.stringify(payload))
  const base = `${location.origin}${location.pathname}`
  if (typeof CompressionStream === 'undefined') {
    return `${base}${PARAM}-${toBase64Url(json)}`
  }
  return `${base}${PARAM}${toBase64Url(await deflate(json))}`
}

/**
 * The puzzle inside a `#g=` fragment, or null when the hash is not ours.
 *
 * Anything malformed throws with a message fit to show: a truncated paste is
 * the likely cause, and "invalid" alone would send the sender hunting through
 * the app instead of re-copying the link.
 */
export async function parseShareLink(hash: string): Promise<Puzzle | null> {
  if (!hash.startsWith(PARAM)) return null
  const raw = hash.slice(PARAM.length)
  try {
    const plain = raw.startsWith('-')
    const bytes = fromBase64Url(plain ? raw.slice(1) : raw)
    const json = plain ? bytes : await inflate(bytes)
    const payload = JSON.parse(new TextDecoder().decode(json)) as Partial<LinkPayload>
    if ((payload.v ?? 0) > LINK_VERSION) {
      throw new Error('Ce lien vient d’une version plus récente de l’application — mets-la à jour.')
    }
    const puzzle = payload.puzzle
    if (!isSharedPuzzle(puzzle)) throw new Error('bad shape')
    return puzzle
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Ce lien')) throw error
    throw new Error(
      'Ce lien de grille est incomplet — il a sans doute été tronqué en route. Demande à l’expéditeur de le renvoyer.',
    )
  }
}

/**
 * Puts the link in the friend's hands: the system share sheet where there is
 * one, the clipboard everywhere else.
 */
export async function offerShareLink(url: string, title: string): Promise<'shared' | 'copied'> {
  if (navigator.share) {
    try {
      await navigator.share({ title, url })
      return 'shared'
    } catch (error) {
      // Dismissing the sheet is not a request to copy instead.
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared'
    }
  }
  await navigator.clipboard.writeText(url)
  return 'copied'
}

/**
 * A drawn stand-in for the photo thumbnail a shared grid left behind.
 *
 * The photo never travels (it is copyrighted magazine content, and it is huge),
 * so a received grid would sit in the library as a blank placeholder among the
 * photographed ones. Its shape is its face: paint the cells.
 */
export function gridThumbnail(puzzle: Puzzle): string | undefined {
  const canvas = document.createElement('canvas')
  canvas.width = 112
  canvas.height = 144
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  ctx.fillStyle = '#e9edf3'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const cell = Math.min((canvas.width - 8) / puzzle.cols, (canvas.height - 8) / puzzle.rows)
  const left = (canvas.width - cell * puzzle.cols) / 2
  const top = (canvas.height - cell * puzzle.rows) / 2
  puzzle.cells.forEach((one, i) => {
    const r = Math.floor(i / puzzle.cols)
    const c = i % puzzle.cols
    ctx.fillStyle = one.kind === 'block' ? '#39414f' : one.kind === 'clue' ? '#aab4c4' : '#ffffff'
    ctx.fillRect(left + c * cell + 0.5, top + r * cell + 0.5, cell - 1, cell - 1)
  })
  return canvas.toDataURL('image/jpeg', 0.8)
}

/** Sanity for data that arrives from outside: shape, bounds, and cell kinds. */
function isSharedPuzzle(value: unknown): value is Puzzle {
  if (!value || typeof value !== 'object') return false
  const puzzle = value as Partial<Puzzle>
  if (
    typeof puzzle.id !== 'string' ||
    typeof puzzle.title !== 'string' ||
    !Number.isInteger(puzzle.rows) ||
    !Number.isInteger(puzzle.cols) ||
    (puzzle.rows ?? 0) < 1 ||
    (puzzle.cols ?? 0) < 1 ||
    (puzzle.rows ?? 0) > 40 ||
    (puzzle.cols ?? 0) > 40 ||
    !Array.isArray(puzzle.cells) ||
    puzzle.cells.length !== (puzzle.rows ?? 0) * (puzzle.cols ?? 0)
  ) {
    return false
  }
  return puzzle.cells.every(
    (cell) =>
      !!cell &&
      typeof cell === 'object' &&
      (cell.kind === 'letter' || cell.kind === 'clue' || cell.kind === 'block'),
  )
}
