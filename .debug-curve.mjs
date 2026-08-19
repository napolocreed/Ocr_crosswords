import { chromium } from 'playwright'
import { readFileSync, readdirSync } from 'node:fs'
const CORPUS = [...new Set(readdirSync('fixtures').filter((f) => f.endsWith('truth.json'))
  .flatMap((f) => JSON.parse(readFileSync('fixtures/' + f, 'utf8')).definitions))]
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
await page.setContent('<!doctype html><meta charset=utf-8>')
const out = await page.evaluate((CORPUS) => {
  const FONT = "600 $px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
  const LH = 1.06, AR = 0.12, SAFETY = 0.94
  const ctx = document.createElement('canvas').getContext('2d')
  const font = (s) => FONT.replace('$', String(s))
  const lineCount = (text, size, width) => {
    ctx.font = font(size)
    const words = text.split(/\s+/).filter(Boolean)
    if (!words.length) return 0
    let lines = 1, cur = ''
    for (const w of words) {
      const cand = cur ? cur + ' ' + w : w
      if (ctx.measureText(cand).width <= width) { cur = cand; continue }
      if (cur) { lines++; cur = '' }
      if (ctx.measureText(w).width <= width) { cur = w; continue }
      let ch2 = ''
      for (const ch of w) { if (ctx.measureText(ch2 + ch).width <= width) { ch2 += ch; continue } lines++; ch2 = ch }
      cur = ch2
    }
    return lines
  }
  const unbroken = (t, w) => { ctx.font = font(100); let x = 0; for (const q of t.split(/\s+/)) if (q) x = Math.max(x, ctx.measureText(q).width); return x > 0 ? (w * 100) / x : Infinity }
  const fitsIn = (t, s, w, h) => s > 0 && lineCount(t, s, w) * s * LH + s * AR <= h
  const fit = (text, width, height, min, max) => {
    const bw = width * SAFETY, bh = height * SAFETY
    const u = unbroken(text, bw); const ceil = u >= min ? Math.min(max, u) : max
    if (fitsIn(text, ceil, bw, bh)) return ceil
    let lo = min, hi = ceil
    for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (fitsIn(text, m, bw, bh)) lo = m; else hi = m }
    return lo
  }
  const H = 19.5, W = 42, MAX = Math.min(44 * 0.34, H * 0.62)
  const sizes = CORPUS.map((t) => fit(t, W, H, 3, MAX)).sort((a, b) => a - b)
  const q = (p) => sizes[Math.floor(p * (sizes.length - 1))]
  const curve = [0.64, 0.8, 1.0, 1.2, 1.35, 1.5, 1.8, 2.17, 2.6].map((z) => ({
    z, whole: sizes.filter((s) => s * z >= 6.5).length, n: sizes.length,
  }))
  return { min: sizes[0], p10: q(0.1), p25: q(0.25), med: q(0.5), p75: q(0.75), max: sizes[sizes.length - 1], curve }
}, CORPUS)
console.log('taille ajustée (unités de grille) :', JSON.stringify({ min: +out.min.toFixed(2), p10: +out.p10.toFixed(2), p25: +out.p25.toFixed(2), med: +out.med.toFixed(2), p75: +out.p75.toFixed(2), max: +out.max.toFixed(2) }))
console.log('définitions montrées ENTIÈRES selon le zoom (seuil size*zoom >= 6.5) :')
for (const c of out.curve) console.log(`   zoom ${c.z.toFixed(2)}  ->  ${c.whole}/${c.n}  (${(100 * c.whole / c.n).toFixed(0)} %)`)
await browser.close()
