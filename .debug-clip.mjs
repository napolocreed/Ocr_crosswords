/** Which definitions are actually clipped, and by how much — line boxes, not scrollHeight. */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { chromium } from 'playwright'

const FIX = process.argv[2] ?? 'fixtures/fleches-n2-p57.truth.json'
const truth = JSON.parse(readFileSync(FIX, 'utf8'))
const rows = truth.grid.rows, cols = truth.grid.cols
const DEFINITIONS = truth.definitions
let seed = 20250819
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const ARROWS = ['right', 'down', 'rightDown', 'downRight']
const cells = Array.from({ length: rows * cols }, () => ({ kind: 'letter' }))
let n = 0
for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) {
  const i = r * cols + c
  if ((c > 0 && cells[i-1].kind === 'clue') || (r > 0 && cells[i-cols].kind === 'clue') || random() > 0.24) continue
  if (n >= DEFINITIONS.length) continue
  const stacked = random() < 0.7 && n + 1 < DEFINITIONS.length
  cells[i] = { kind: 'clue', clues: Array.from({ length: stacked ? 2 : 1 }, () => ({ id: `c${i}-${n}`, text: DEFINITIONS[n++], arrow: ARROWS[Math.floor(random()*4)] })) }
}
const puzzle = { id: 'dbg', title: 'Grille de contrôle', rows, cols, cells, createdAt: 1, updatedAt: 1, reviewed: true }
await mkdir('.debug', { recursive: true })
const packPath = resolve('.debug/dbg2.json')
await writeFile(packPath, JSON.stringify({ format: 'grilles.pack', version: 1, exportedAt: 1, puzzles: [puzzle] }))
const wanted = new Set(cells.flatMap((c) => (c.clues ?? []).map((q) => q.text)))

const BASE = '/Ocr_crosswords/'
const dist = resolve('dist')
const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml','.wasm':'application/wasm','.traineddata':'application/octet-stream' }
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (p.startsWith(BASE)) p = p.slice(BASE.length - 1)
    if (p === '/' || p === '') p = '/index.html'
    const body = await readFile(join(dist, p))
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch { res.writeHead(404).end('nf') }
})
await new Promise((r) => server.listen(4178, r))
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, args: ['--no-sandbox'] })
const ctx0 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'fr-FR' })
const page = await ctx0.newPage()
await page.goto(`http://localhost:4178${BASE}`, { waitUntil: 'networkidle' })
await page.setInputFiles('input[type=file][accept*=json]', packPath)
await page.locator('.library-item', { hasText: 'Grille de contrôle' }).click({ timeout: 10000 })
await page.locator('.grid .cell').first().waitFor({ timeout: 10000 })
await page.waitForTimeout(700)

const zoomTo = async (target) => {
  await page.mouse.move(195, 300)
  for (let i = 0; i < 90; i += 1) {
    const z = await page.evaluate(() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.grid-pan')).transform).a)
    if (Math.abs(z - target) / target < 0.03) break
    await page.mouse.wheel(0, z < target ? -120 : 120)
    await page.waitForTimeout(15)
  }
  await page.waitForTimeout(300)
}

const probe = async (label) => {
  const data = await page.evaluate(() => {
    const z = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.grid-pan')).transform).a
    const rows = []
    document.querySelectorAll('.grid .cell.clue').forEach((cell) => {
      const halves = [...cell.querySelectorAll('.clue-text')]
      const cellRect = cell.getBoundingClientRect()
      const cellCS = getComputedStyle(cell)
      halves.forEach((t) => {
        const cs = getComputedStyle(t)
        const size = Number.parseFloat(cs.fontSize)
        const node = t.firstChild
        let lineTops = []
        if (node) {
          const r = document.createRange()
          r.selectNodeContents(t)
          lineTops = [...r.getClientRects()].map((q) => ({ top: q.top, bottom: q.bottom, left: q.left, right: q.right }))
        }
        const tr = t.getBoundingClientRect()
        const padTop = Number.parseFloat(cs.paddingTop)
        // client box in *unscaled* units: divide by z
        const contentBottom = lineTops.length ? Math.max(...lineTops.map((q) => q.bottom)) : tr.top
        rows.push({
          text: t.textContent,
          size,
          lines: lineTops.length,
          clientH: t.clientHeight,
          elemH: tr.height / z,
          neededH: (contentBottom - tr.top) / z,
          padTop,
          lineH: Number.parseFloat(cs.lineHeight),
          widest: lineTops.length ? Math.max(...lineTops.map((q) => (q.right - q.left) / z)) : 0,
          contentW: t.clientWidth,
          cellH: cell.clientHeight,
          cellBottom: (cellRect.bottom - cellRect.top) / z,
          overflowBelowCell: (contentBottom - cellRect.bottom) / z,
        })
      })
    })
    return { z, rows }
  })
  const bad = data.rows.filter((r) => r.neededH > r.clientH + 0.3 || r.overflowBelowCell > 0.3 || r.widest > r.contentW + 0.3)
  console.log(`\n[${label}] zoom ${data.z.toFixed(3)}  n=${data.rows.length}  suspects=${bad.length}`)
  for (const r of bad.slice(0, 25)) {
    console.log(
      `   "${r.text}" size=${r.size.toFixed(2)} lines=${r.lines} lineH=${r.lineH.toFixed(3)} ` +
      `elemH=${r.elemH.toFixed(2)} clientH=${r.clientH} neededH=${r.neededH.toFixed(2)} ` +
      `widest=${r.widest.toFixed(2)}/${r.contentW} overflowBelowCell=${r.overflowBelowCell.toFixed(2)}`,
    )
  }
  // how many lines are entirely hidden
  const hidden = data.rows.filter((r) => r.neededH - r.clientH > r.size * 0.5)
  console.log(`   lignes entièrement perdues sur ${hidden.length} définitions`)
  for (const r of hidden.slice(0, 10)) console.log(`     >>> "${r.text}" ${r.lines} lignes, besoin ${r.neededH.toFixed(2)} > ${r.clientH}`)
  return data
}

await probe('ajusté')
for (const t of [1.2, 2.0, 3.5]) { await zoomTo(t); await probe(`zoom ~${t}`) }

await browser.close(); server.close()
