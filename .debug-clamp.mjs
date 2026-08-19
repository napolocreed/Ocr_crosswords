import { chromium } from 'playwright'
import { readFileSync, readdirSync } from 'node:fs'
const CORPUS = [...new Set(readdirSync('fixtures').filter((f) => f.endsWith('truth.json'))
  .flatMap((f) => JSON.parse(readFileSync('fixtures/' + f, 'utf8')).definitions))]
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
await page.setContent(`<!doctype html><meta charset=utf-8><style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px}
.probe{position:absolute;visibility:hidden;font-weight:600;line-height:1.06;letter-spacing:-0.02em;padding-top:0.12em;word-break:break-word;width:42px}
</style>`)
const out = await page.evaluate((CORPUS) => {
  const FONT = "600 $px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
  const LH = 1.06, AR = 0.12, S = 0.94
  const ctx = document.createElement('canvas').getContext('2d')
  const font = (s) => FONT.replace('$', String(s))
  const lineCount = (t, size, w) => {
    ctx.font = font(size)
    const words = t.split(/\s+/).filter(Boolean); if (!words.length) return 0
    let lines = 1, cur = ''
    for (const q of words) {
      const c = cur ? cur + ' ' + q : q
      if (ctx.measureText(c).width <= w) { cur = c; continue }
      if (cur) { lines++; cur = '' }
      if (ctx.measureText(q).width <= w) { cur = q; continue }
      let k = ''
      for (const ch of q) { if (ctx.measureText(k + ch).width <= w) { k += ch; continue } lines++; k = ch }
      cur = k
    }
    return lines
  }
  const unbroken = (t, w) => { ctx.font = font(100); let x = 0; for (const q of t.split(/\s+/)) if (q) x = Math.max(x, ctx.measureText(q).width); return x > 0 ? (w * 100) / x : Infinity }
  const fitsIn = (t, s, w, h) => s > 0 && lineCount(t, s, w) * s * LH + s * AR <= h
  const fit = (t, W, H, min, max) => {
    const bw = W * S, bh = H * S
    const u = unbroken(t, bw), ceil = u >= min ? Math.min(max, u) : max
    if (fitsIn(t, ceil, bw, bh)) return ceil
    let lo = min, hi = ceil
    for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; if (fitsIn(t, m, bw, bh)) lo = m; else hi = m }
    return lo
  }
  const H = 19.5, W = 42, MAX = Math.min(44 * 0.34, H * 0.62)
  const probe = document.createElement('span'); probe.className = 'probe'; document.body.appendChild(probe)
  const realLines = (t, size) => {
    probe.style.fontSize = size + 'px'; probe.textContent = t
    const r = document.createRange(); r.selectNodeContents(probe)
    return [...r.getClientRects()].length
  }
  let below8 = 0, below6 = 0
  let lostLines8 = 0, anyLoss8 = 0, halfKilled = 0
  const worst = []
  const headroom = []
  for (const t of CORPUS) {
    const s = fit(t, W, H, 3, MAX)
    if (s < 8) below8++
    if (s < 6) below6++
    const nFit = realLines(t, s)
    headroom.push(19.5 / (s * (LH * nFit + AR)))
    const c = Math.max(s, 8)
    if (c > s) {
      const nC = realLines(t, c)
      const needed = c * (LH * nC + AR)
      if (needed > 19.5 + 0.3) {
        anyLoss8++
        const shown = Math.max(0, Math.floor((19.5 - c * AR) / (c * LH)))
        lostLines8 += nC - shown
        if (needed > 19.5 * 1.6) halfKilled++
        if (worst.length < 8) worst.push({ t, fitted: +s.toFixed(2), clamped: c, lines: nC, needed: +needed.toFixed(1), shown })
      }
    }
  }
  headroom.sort((a, b) => a - b)
  return { n: CORPUS.length, below8, below6, anyLoss8, lostLines8, halfKilled, worst,
    headMin: headroom[0], headP25: headroom[Math.floor(0.25 * headroom.length)], headMed: headroom[headroom.length >> 1] }
}, CORPUS)
console.log(JSON.stringify({ ...out, worst: undefined }, null, 1))
console.log('\nexemples sous minimumFontSize=8 :')
for (const w of out.worst) console.log(`  "${w.t}" ajusté ${w.fitted} -> forcé ${w.clamped} : ${w.lines} lignes, ${w.needed} unités nécessaires pour une demi-case de 19,5 -> ${w.shown} ligne(s) visible(s)`)
console.log(`\nmarge de hauteur (19,5 / hauteur réellement occupée) : min ${out.headMin.toFixed(3)}  p25 ${out.headP25.toFixed(3)}  médiane ${out.headMed.toFixed(3)}`)
await browser.close()
