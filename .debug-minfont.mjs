/**
 * Does a UA minimum-font-size (Android WebView default 8, Chrome "text scaling"
 * / accessibility font size) clamp an inline `font-size: 5.5px`?  If it does,
 * every measurement clueTypography made is void: the type comes out bigger than
 * the box it was fitted to, and the surplus lines are cut with no ellipsis.
 */
import { chromium } from 'playwright'

const run = async (args, label) => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, args: ['--no-sandbox', ...args] })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.setContent(`<!doctype html><meta charset=utf-8><style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px;-webkit-text-size-adjust:100%}
.cell{position:relative;display:grid;overflow:hidden;line-height:1;width:44px;height:44px;font-size:22.88px;align-content:start;justify-items:stretch;padding:1px;background:#d5dbe6}
.clue-text{font-weight:600;line-height:1.06;text-align:left;letter-spacing:-0.02em;overflow:hidden;word-break:break-word;padding-top:0.12em}
.clue-half + .clue-half{border-top:1px solid #6b7689;margin-top:2px}
</style><div id=host style="display:flex;flex-wrap:wrap"></div>`)
  const r = await page.evaluate(() => {
    const host = document.getElementById('host')
    const rows = []
    for (const [text, size] of [
      ['ACCROISSEMENT DE LA VITESSE', 4.15],
      ['EMPLOYÉ D’UNE BANQUE', 5.54],
      ['VENT CHAUD ET SEC', 5.54],
      ['CERCLE LUMINEUX', 6.71],
      ['PISTÉ', 12.09],
    ]) {
      const cell = document.createElement('div'); cell.className = 'cell'
      const sp = document.createElement('span'); sp.className = 'clue-text clue-half'
      sp.style.fontSize = size + 'px'; sp.textContent = text
      cell.appendChild(sp); host.appendChild(cell)
      const cs = getComputedStyle(sp)
      const range = document.createRange(); range.selectNodeContents(sp)
      const rects = [...range.getClientRects()]
      const top = sp.getBoundingClientRect().top
      rows.push({
        text, asked: size, computed: Number.parseFloat(cs.fontSize),
        lines: rects.length,
        contentBottom: +(Math.max(...rects.map((q) => q.bottom)) - top).toFixed(2),
        clientH: sp.clientHeight,
      })
      cell.remove()
    }
    return rows
  })
  console.log(`\n--- ${label} ---`)
  for (const x of r) {
    const lost = x.contentBottom > x.clientH + 0.5
    console.log(`  "${x.text}" demandé ${x.asked} -> calculé ${x.computed}  ${x.lines} lignes  bas du texte ${x.contentBottom} vs boîte ${x.clientH}${lost ? '   *** COUPÉ' : ''}`)
  }
  await browser.close()
}

await run([], 'par défaut (minimumFontSize=0)')
await run(['--blink-settings=minimumFontSize=8,minimumLogicalFontSize=8'], 'minimumFontSize=8 (défaut WebView Android)')
await run(['--blink-settings=minimumLogicalFontSize=6'], 'minimumLogicalFontSize=6')
await run(['--force-device-scale-factor=3', '--blink-settings=fontScaleFactor=1.3,textAutosizingEnabled=true'], 'fontScaleFactor 1.3 (Chrome « taille du texte » 130 %)')
