/**
 * Load the REAL built app with a real 13x18 grid and read back:
 *  - .grid-wrap size, minZoom, the fitted transform
 *  - every rendered .clue-text: its text, computed font-size, and whether the
 *    DOM box actually clips it (scrollHeight/scrollWidth vs client*)
 * at several zooms.
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { chromium } from 'playwright'

const FIX = process.argv[2] ?? 'fixtures/fleches-n2-p57.truth.json'
const truth = JSON.parse(readFileSync(FIX, 'utf8'))
const rows = truth.grid.rows
const cols = truth.grid.cols
const DEFINITIONS = truth.definitions

let seed = 20250819
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const ARROWS = ['right', 'down', 'rightDown', 'downRight']
const cells = Array.from({ length: rows * cols }, () => ({ kind: 'letter' }))
let n = 0
for (let r = 0; r < rows; r += 1) {
  for (let c = 0; c < cols; c += 1) {
    const i = r * cols + c
    const left = c > 0 && cells[i - 1].kind === 'clue'
    const up = r > 0 && cells[i - cols].kind === 'clue'
    if (left || up || random() > 0.24) continue
    if (n >= DEFINITIONS.length) continue
    const stacked = random() < 0.7 && n + 1 < DEFINITIONS.length
    const clues = Array.from({ length: stacked ? 2 : 1 }, () => ({
      id: `c${i}-${n}`, text: DEFINITIONS[n++], arrow: ARROWS[Math.floor(random() * 4)],
    }))
    cells[i] = { kind: 'clue', clues }
  }
}
const puzzle = {
  id: 'dbg', title: 'Grille de contrôle', rows, cols, cells,
  createdAt: 1755600000000, updatedAt: 1755600000000, reviewed: true,
}
const pack = { format: 'grilles.pack', version: 1, exportedAt: 1755600000000, puzzles: [puzzle] }
await mkdir('.debug', { recursive: true })
const packPath = resolve('.debug/dbg.json')
await writeFile(packPath, JSON.stringify(pack))
const wanted = cells.flatMap((c) => (c.clues ?? []).map((q) => q.text))
console.log(`${FIX}  ${cols}x${rows}  ${wanted.length} définitions placées`)

const BASE = '/Ocr_crosswords/'
const dist = resolve('dist')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.traineddata': 'application/octet-stream' }
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (path.startsWith(BASE)) path = path.slice(BASE.length - 1)
    if (path === '/' || path === '') path = '/index.html'
    const body = await readFile(join(dist, path))
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch { res.writeHead(404).end('not found') }
})
await new Promise((r) => server.listen(4177, r))

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'fr-FR' })
const page = await context.newPage()
page.on('pageerror', (e) => console.log('  [browser]', e.message))
await page.goto(`http://localhost:4177${BASE}`, { waitUntil: 'networkidle' })
await page.setInputFiles('input[type=file][accept*=json]', packPath)
await page.locator('.library-item', { hasText: 'Grille de contrôle' }).click({ timeout: 10000 })
await page.locator('.grid .cell').first().waitFor({ timeout: 10000 })
await page.waitForTimeout(800)

const geom = await page.evaluate(() => {
  const w = document.querySelector('.grid-wrap')
  const r = w.getBoundingClientRect()
  const pan = document.querySelector('.grid-pan')
  const m = new DOMMatrixReadOnly(getComputedStyle(pan).transform)
  return { wrapW: r.width, wrapH: r.height, zoom: m.a, dpr: devicePixelRatio }
})
const gridW = cols * 44 + cols + 1
const gridH = rows * 44 + rows + 1
console.log(`grid-wrap ${geom.wrapW.toFixed(1)} x ${geom.wrapH.toFixed(1)} css px, dpr ${geom.dpr}`)
console.log(`gridW ${gridW}  gridH ${gridH}  ->  minZoom = min(${(geom.wrapW/gridW).toFixed(4)}, ${(geom.wrapH/gridH).toFixed(4)}) = ${Math.min(geom.wrapW/gridW, geom.wrapH/gridH).toFixed(4)}`)
console.log(`fitted transform zoom = ${geom.zoom.toFixed(4)}`)

const snapshot = async (label) => {
  const data = await page.evaluate(() => {
    const pan = document.querySelector('.grid-pan')
    const z = new DOMMatrixReadOnly(getComputedStyle(pan).transform).a
    const out = []
    document.querySelectorAll('.grid .cell.clue').forEach((cell) => {
      const halves = [...cell.querySelectorAll('.clue-text')]
      halves.forEach((t) => {
        const cs = getComputedStyle(t)
        out.push({
          text: t.textContent,
          size: Number.parseFloat(cs.fontSize),
          clientH: t.clientHeight, scrollH: t.scrollHeight,
          clientW: t.clientWidth, scrollW: t.scrollWidth,
          cellClientH: cell.clientHeight,
          sumH: halves.reduce((a, h) => a + h.offsetHeight, 0) + (halves.length > 1 ? 3 : 0),
        })
      })
    })
    return { z, out }
  })
  const z = data.z
  let whole = 0, cut = 0, clipH = 0, clipW = 0, cellOver = 0
  const cutExamples = []
  const byText = new Map()
  for (const t of wanted) byText.set(t, (byText.get(t) ?? 0) + 1)
  for (const r of data.out) {
    if (byText.has(r.text)) whole++
    else { cut++; if (cutExamples.length < 8) cutExamples.push(`"${r.text}"@${r.size.toFixed(2)}`) }
    if (r.scrollH > r.clientH + 0.5) clipH++
    if (r.scrollW > r.clientW + 0.5) clipW++
    if (r.sumH > r.cellClientH + 0.5) cellOver++
  }
  const sizes = data.out.map((r) => r.size).sort((a, b) => a - b)
  console.log(
    `\n[${label}] zoom ${z.toFixed(3)}  rendus ${data.out.length}/${wanted.length}  ` +
    `ENTIERS ${whole}  coupés ${cut}  vides ${wanted.length - data.out.length}\n` +
    `   font-size css px: min ${sizes[0]?.toFixed(2)} med ${sizes[sizes.length>>1]?.toFixed(2)} max ${sizes[sizes.length-1]?.toFixed(2)}` +
    `   -> à l'écran min ${(sizes[0]*z).toFixed(2)} css px / ${(sizes[0]*z*3).toFixed(1)} device px\n` +
    `   clipped by overflow:hidden -> hauteur ${clipH}, largeur ${clipW}, cellule débordée ${cellOver}`,
  )
  if (cutExamples.length) console.log('   ex.: ' + cutExamples.join('  '))
  return { z, whole, cut, total: wanted.length }
}

await snapshot('ajusté (départ)')

// Drive zoom by wheel to specific values and re-snapshot.
const zoomTo = async (target) => {
  await page.mouse.move(195, 300)
  for (let i = 0; i < 80; i += 1) {
    const z = await page.evaluate(() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.grid-pan')).transform).a)
    if (Math.abs(z - target) / target < 0.03) break
    await page.mouse.wheel(0, z < target ? -120 : 120)
    await page.waitForTimeout(20)
  }
  await page.waitForTimeout(250)
}
for (const t of [0.8, 1.0, 1.2, 1.4, 1.7, 2.0, 2.6, 3.5]) {
  await zoomTo(t)
  await snapshot(`zoom ~${t}`)
}

await browser.close()
server.close()
