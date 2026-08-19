/**
 * How much of each definition survives at the fitted zoom, under variants of the
 * measurement constants. Pure simulation of clueTypography + GridView's render
 * branch, run inside chromium so canvas + DOM metrics are the real ones.
 */
import { chromium } from 'playwright'
import { readFileSync, readdirSync } from 'node:fs'

const CORPUS = readdirSync('fixtures')
  .filter((f) => f.endsWith('truth.json'))
  .flatMap((f) => JSON.parse(readFileSync('fixtures/' + f, 'utf8')).definitions)

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'fr-FR' })
const page = await ctx.newPage()
await page.setContent(`<!doctype html><meta charset=utf-8><style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px}
.cell{position:relative;display:grid;place-items:center;overflow:hidden;line-height:1;width:44px;height:44px;font-size:22.88px;align-content:start;justify-items:stretch;padding:1px}
.clue-text{font-weight:600;line-height:1.06;text-align:left;letter-spacing:-0.02em;overflow:hidden;word-break:break-word;padding-top:0.12em}
.clue-half + .clue-half{border-top:1px solid #888;margin-top:2px}
</style><div id=host></div>`)

const res = await page.evaluate(({ CORPUS }) => {
  const FONT = "600 $px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
  const LINE_HEIGHT = 1.06, ACCENT_ROOM = 0.12, MIN_USEFUL_CHARS = 3, ELLIPSIS = '…'
  const ctx = document.createElement('canvas').getContext('2d')
  const font = (s) => FONT.replace('$', String(s))
  const lineCount = (text, size, width, ls) => {
    ctx.font = font(size)
    if (ls) ctx.letterSpacing = (-0.02 * size) + 'px'; else ctx.letterSpacing = '0px'
    const words = text.split(/\s+/).filter(Boolean)
    if (!words.length) return 0
    let lines = 1, current = ''
    for (const w of words) {
      const cand = current ? current + ' ' + w : w
      if (ctx.measureText(cand).width <= width) { current = cand; continue }
      if (current) { lines++; current = '' }
      if (ctx.measureText(w).width <= width) { current = w; continue }
      let chunk = ''
      for (const ch of w) { if (ctx.measureText(chunk + ch).width <= width) { chunk += ch; continue } lines++; chunk = ch }
      current = chunk
    }
    ctx.letterSpacing = '0px'
    return lines
  }
  const unbroken = (text, width, ls) => {
    ctx.font = font(100)
    if (ls) ctx.letterSpacing = '-2px'; else ctx.letterSpacing = '0px'
    let widest = 0
    for (const w of text.split(/\s+/)) if (w) widest = Math.max(widest, ctx.measureText(w).width)
    ctx.letterSpacing = '0px'
    return widest > 0 ? (width * 100) / widest : Infinity
  }
  const measureShortened = (text, size, width, height, SW, SH, ls) => {
    const boxW = width * SW, boxH = height * SH
    const lines = Math.floor((boxH - size * ACCENT_ROOM) / (size * LINE_HEIGHT))
    if (lines < 1) return null
    const fitsWhole = (c) => unbroken(c, boxW, ls) >= size && lineCount(c, size, boxW, ls) <= lines
    if (fitsWhole(text)) return { text, whole: true, lines }
    const words = text.split(/\s+/).filter(Boolean)
    for (let n = words.length - 1; n >= 1; n--) {
      const c = words.slice(0, n).join(' ') + ELLIPSIS
      if (fitsWhole(c) && c.length - 1 >= MIN_USEFUL_CHARS) return { text: c, whole: true, lines }
    }
    const first = words[0] ?? ''
    ctx.font = font(size)
    if (ls) ctx.letterSpacing = (-0.02 * size) + 'px'; else ctx.letterSpacing = '0px'
    let take = 0
    for (let n = 1; n <= first.length; n++) { if (ctx.measureText(first.slice(0, n) + ELLIPSIS).width > boxW) break; take = n }
    ctx.letterSpacing = '0px'
    return take >= MIN_USEFUL_CHARS ? { text: first.slice(0, take) + ELLIPSIS, whole: false, lines } : null
  }
  const shorten = (text, w, h, size, floor, SW, SH, ls) => {
    const steps = [size, (size + floor) / 2, floor]
    let best = null
    for (const step of steps) {
      const c = measureShortened(text.trim(), step, w, h, SW, SH, ls)
      if (!c) continue
      const rank = (c.whole ? 10000 : 0) + c.text.length
      if (!best || rank > best.rank) best = { text: c.text, size: step, rank, lines: c.lines }
    }
    return best
  }

  const W = 42, H = 19.5
  const variants = [
    { name: 'actuel            SAFETY 0.94 w+h, floor 0.84', SW: 0.94, SH: 0.94, FL: 0.84, ls: false },
    { name: 'hauteur non rognée SAFETY w0.94 h1.00',        SW: 0.94, SH: 1.00, FL: 0.84, ls: false },
    { name: 'letter-spacing pris en compte',                 SW: 0.94, SH: 0.94, FL: 0.84, ls: true },
    { name: 'les deux (h1.00 + letter-spacing)',             SW: 1.00, SH: 1.00, FL: 0.84, ls: true },
    { name: 'floor 0.80 seulement',                          SW: 0.94, SH: 0.94, FL: 0.80, ls: false },
  ]
  const zooms = [0.6412, 0.55, 0.45]
  const out = []
  for (const z of zooms) {
    const floorSize = Math.ceil((6.5 / z) * 4) / 4
    for (const v of variants) {
      let chars = 0, blank = 0, whole = 0, twoLine = 0
      const ex = []
      for (const t of CORPUS) {
        const s = shorten(t, W, H, floorSize, floorSize * v.FL, v.SW, v.SH, v.ls)
        if (!s) { blank++; continue }
        chars += s.text.length
        if (s.text === t) whole++
        if (s.lines >= 2) twoLine++
        if (ex.length < 5) ex.push(s.text)
      }
      out.push({ z, floorSize, v: v.name, avgChars: +(chars / CORPUS.length).toFixed(2), blank, whole, twoLine, n: CORPUS.length, ex })
    }
  }
  return out
}, { CORPUS })

let lastZ = null
for (const r of res) {
  if (r.z !== lastZ) { console.log(`\n=== zoom ${r.z}  floorSize ${r.floorSize}  (${r.n} définitions du corpus réel) ===`); lastZ = r.z }
  console.log(`${r.v.padEnd(46)} car./déf ${String(r.avgChars).padStart(6)}  entières ${String(r.whole).padStart(3)}  vides ${String(r.blank).padStart(3)}  sur-2-lignes ${String(r.twoLine).padStart(3)}   ex. ${r.ex.join(' ')}`)
}
await browser.close()
