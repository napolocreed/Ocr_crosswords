/** Predicted vs real line count over the whole corpus, and which squares go blank. */
import { chromium } from 'playwright'
import { readFileSync, readdirSync } from 'node:fs'

const CORPUS = [...new Set(readdirSync('fixtures').filter((f) => f.endsWith('truth.json'))
  .flatMap((f) => JSON.parse(readFileSync('fixtures/' + f, 'utf8')).definitions))]

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'fr-FR' })
const page = await ctx.newPage()
await page.setContent(`<!doctype html><meta charset=utf-8><style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px}
.cell{position:relative;display:grid;overflow:hidden;line-height:1;width:44px;height:44px;font-size:22.88px;align-items:center;justify-items:stretch;align-content:start;padding:1px;background:#d5dbe6}
.clue-text{font-weight:600;line-height:1.06;text-align:left;letter-spacing:-0.02em;overflow:hidden;word-break:break-word;padding-top:0.12em}
.clue-half + .clue-half{border-top:1px solid #6b7689;margin-top:2px}
</style><div id=host style="display:flex;flex-wrap:wrap"></div>`)

const res = await page.evaluate((CORPUS) => {
  const FONT = "600 $px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
  const LINE_HEIGHT = 1.06, ACCENT_ROOM = 0.12, SAFETY = 0.94, MIN_USEFUL_CHARS = 3, ELLIPSIS = '…'
  const ctx = document.createElement('canvas').getContext('2d')
  const font = (s) => FONT.replace('$', String(s))
  const lineCount = (text, size, width) => {
    ctx.font = font(size)
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
    return lines
  }
  const unbroken = (text, width) => {
    ctx.font = font(100); let widest = 0
    for (const w of text.split(/\s+/)) if (w) widest = Math.max(widest, ctx.measureText(w).width)
    return widest > 0 ? (width * 100) / widest : Infinity
  }
  const fitsIn = (t, s, w, h) => s > 0 && lineCount(t, s, w) * s * LINE_HEIGHT + s * ACCENT_ROOM <= h
  const fitClueSize = (text, width, height, min, max) => {
    const boxW = width * SAFETY, boxH = height * SAFETY
    const u = unbroken(text, boxW)
    const ceiling = u >= min ? Math.min(max, u) : max
    if (fitsIn(text, ceiling, boxW, boxH)) return ceiling
    let lo = min, hi = ceiling
    for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (fitsIn(text, m, boxW, boxH)) lo = m; else hi = m }
    return lo
  }
  const measureShortened = (text, size, width, height) => {
    const boxW = width * SAFETY, boxH = height * SAFETY
    const lines = Math.floor((boxH - size * ACCENT_ROOM) / (size * LINE_HEIGHT))
    if (lines < 1) return { null: true, why: 'lines<1' }
    const fitsWhole = (c) => unbroken(c, boxW) >= size && lineCount(c, size, boxW) <= lines
    if (fitsWhole(text)) return { text, whole: true }
    const words = text.split(/\s+/).filter(Boolean)
    for (let n = words.length - 1; n >= 1; n--) {
      const c = words.slice(0, n).join(' ') + ELLIPSIS
      if (fitsWhole(c) && c.length - 1 >= MIN_USEFUL_CHARS) return { text: c, whole: true }
    }
    const first = words[0] ?? ''
    ctx.font = font(size)
    let take = 0
    for (let n = 1; n <= first.length; n++) { if (ctx.measureText(first.slice(0, n) + ELLIPSIS).width > boxW) break; take = n }
    if (take >= MIN_USEFUL_CHARS) return { text: first.slice(0, take) + ELLIPSIS, whole: false }
    return { null: true, why: `premier mot "${first}" (${first.length} car.), take=${take}` }
  }

  const W = 42, H = 19.5, MAX = Math.min(44 * 0.34, H * 0.62)
  const host = document.getElementById('host')
  const under = [], over = []
  const blanks = []
  let n = 0
  for (const t of CORPUS) {
    const size = fitClueSize(t, W, H, 3, MAX)
    const pred = lineCount(t, size, W * SAFETY)
    const cell = document.createElement('div'); cell.className = 'cell'
    const sp = document.createElement('span'); sp.className = 'clue-text clue-half'
    sp.style.fontSize = size + 'px'; sp.textContent = t
    cell.appendChild(sp); host.appendChild(cell)
    const r = document.createRange(); r.selectNodeContents(sp)
    const rects = [...r.getClientRects()]
    const real = rects.length
    const inkBottom = rects.length ? Math.max(...rects.map((q) => q.bottom)) - sp.getBoundingClientRect().top : 0
    const needed = real * size * LINE_HEIGHT + size * ACCENT_ROOM
    if (real > pred) under.push({ t, size: +size.toFixed(2), pred, real, needed: +needed.toFixed(2), inkBottom: +inkBottom.toFixed(2) })
    if (real < pred) over.push({ t, size: +size.toFixed(2), pred, real })
    cell.remove()
    // blank check at fitted zoom of a 13x18 grid
    const floorSize = 10.25
    const steps = [floorSize, (floorSize + floorSize * 0.84) / 2, floorSize * 0.84]
    let any = null
    for (const s of steps) { const c = measureShortened(t, s, W, H); if (!c.null) { any = c; break } }
    if (!any) blanks.push({ t, why: measureShortened(t, floorSize * 0.84, W, H).why })
    n++
  }
  return { under, over, blanks, n }
}, CORPUS)

console.log(`corpus ${res.n} définitions uniques`)
console.log(`\nlignes SOUS-estimées par lineCount (le texte déborderait) : ${res.under.length}`)
for (const u of res.under.slice(0, 20)) console.log('  ', u)
console.log(`\nlignes SUR-estimées (type inutilement petit) : ${res.over.length}`)
for (const o of res.over.slice(0, 12)) console.log('  ', o)
console.log(`\ncarrés VIDES au zoom d'ouverture (floorSize 10.25) : ${res.blanks.length}`)
for (const b of res.blanks.slice(0, 30)) console.log(`   "${b.t}"  ->  ${b.why}`)
await browser.close()
