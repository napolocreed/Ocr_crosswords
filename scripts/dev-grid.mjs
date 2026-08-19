#!/usr/bin/env node
/**
 * Photographs the playing grid, so how it reads can be judged rather than argued.
 *
 *   node scripts/dev-grid.mjs
 *
 * Everything the grid has to get right — definitions small enough to fit but
 * large enough to read, arrows in the squares the answers start in, two
 * definitions stacked in one square, an arrow pointing nowhere — is a question
 * about pixels, and the only honest way to answer it is to look. This builds a
 * grid with all of those cases in it, imports it through the app's own pack
 * reader, and shoots the play screen fitted, part-way in, and close up.
 *
 * The grid is synthetic on purpose: a magazine photo would have to be OCR'd
 * first, which takes minutes and puts the pipeline's mistakes in the picture
 * alongside the layout's.
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { chromium } from 'playwright'

/* ------------------------------------------------------------ a test grid */

const DEFINITIONS = [
  'NOTE', 'ÎLE', 'EAU', 'DEMONSTRATIF', 'COURS D\'EAU DE SUISSE', 'PRONOM',
  'ARTICLE', 'RIVIÈRE DE FRANCE', 'IL EST TOUJOURS PRESSÉ', 'PARFOIS',
  'MÉTAL PRÉCIEUX', 'FIN DE SOIRÉE', 'BOUT DE BOIS', 'DÉCHIFFRÉ',
  'ON Y VA POUR SE FAIRE VOIR', 'TÊTU', 'ANCIEN', 'PAS FRAIS', 'CÉRÉALE',
  'VIEILLE COLÈRE', 'AU BOUT DU FIL', 'MIS DE CÔTÉ', 'PETIT COURS',
  'PIÈCE DE CHARRUE', 'CRIA COMME UN CERF', 'ÉTAT DES ÉTATS-UNIS',
  'SYMBOLE DU SODIUM', 'REFUS', 'LAC', 'RUSÉ', 'AGENT DE LIAISON',
  'DANS LA GAMME', 'PRÉPOSITION', 'ELLE FAIT TOURNER LES TÊTES',
  'FLEUVE CÔTIER', 'TRÈS ANCIEN', 'CONJONCTION', 'AVANT LA MATIÈRE',
  'MESURE CHINOISE', 'SE DIT D\'UN BON VIN', 'MOT DE LIAISON', 'DIEU DU SOLEIL',
]
const ARROWS = ['right', 'down', 'rightDown', 'downRight']

/** A tiny deterministic generator: the same grid every run, so runs compare. */
let seed = 20250819
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

const rows = 17
const cols = 13
const cells = Array.from({ length: rows * cols }, () => ({ kind: 'letter' }))
let n = 0
for (let r = 0; r < rows; r += 1) {
  for (let c = 0; c < cols; c += 1) {
    const i = r * cols + c
    // Keep definitions off each other's shoulders, roughly as a magazine does.
    const left = c > 0 && cells[i - 1].kind === 'clue'
    const up = r > 0 && cells[i - cols].kind === 'clue'
    if (left || up || random() > 0.22) continue
    const stacked = random() < 0.3
    const clues = Array.from({ length: stacked ? 2 : 1 }, (_, k) => ({
      id: `c${i}-${k}`,
      text: DEFINITIONS[(n++ * 13 + k * 5) % DEFINITIONS.length],
      // The last row and column are where arrows end up pointing off the grid,
      // which is the case that has to stay visible.
      arrow: ARROWS[Math.floor(random() * 4)],
    }))
    cells[i] = { kind: 'clue', clues }
  }
}
// A couple of dead squares, and a mystery word reading off numbered squares.
cells[rows * cols - 1] = { kind: 'block' }
const slots = [22, 48, 91, 137, 160].map((i) => `${Math.floor(i / cols)},${i % cols}`)
for (const key of slots) {
  const [r, c] = key.split(',').map(Number)
  cells[r * cols + c] = { kind: 'letter' }
}

const puzzle = {
  id: 'dev-grid',
  title: 'Grille de contrôle',
  rows,
  cols,
  cells,
  createdAt: 1755600000000,
  updatedAt: 1755600000000,
  reviewed: true,
  mystery: { clue: 'CAPITALE EUROPÉENNE', slots },
}
const pack = {
  format: 'grilles.pack',
  version: 1,
  exportedAt: 1755600000000,
  puzzles: [puzzle],
}
const defs = cells.reduce((sum, cell) => sum + (cell.clues?.length ?? 0), 0)
await mkdir('.debug', { recursive: true })
const packPath = resolve('.debug/dev-grid.json')
await writeFile(packPath, JSON.stringify(pack))
console.log(`grid ${cols} × ${rows} · ${defs} définitions`)

/* --------------------------------------------------------------- the app */

const BASE = '/Ocr_crosswords/'
const dist = resolve('dist')
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.traineddata': 'application/octet-stream',
}
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (path.startsWith(BASE)) path = path.slice(BASE.length - 1)
    if (path === '/' || path === '') path = '/index.html'
    const body = await readFile(join(dist, path))
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
await new Promise((r) => server.listen(4176, r))

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: true,
  args: ['--no-sandbox'],
})
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'fr-FR',
})
const page = await context.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log(`  [browser] ${m.text()}`) })
page.on('pageerror', (e) => console.log(`  [browser] ${e.message}`))

await page.goto(`http://localhost:4176${BASE}`, { waitUntil: 'networkidle' })
await page.setInputFiles('input[type=file][accept*=json]', packPath)
await page.locator('.library-item', { hasText: 'Grille de contrôle' }).click({ timeout: 10000 })
await page.locator('.grid .cell').first().waitFor({ timeout: 10000 })
await page.waitForTimeout(700)

/** How much text the fitted grid actually shows — the number that was zero. */
const shown = async () =>
  page.locator('.grid .clue-text').evaluateAll((els) =>
    els.reduce(
      (acc, el) => {
        const size = Number.parseFloat(getComputedStyle(el).fontSize)
        return { count: acc.count + 1, min: Math.min(acc.min, size), max: Math.max(acc.max, size) }
      },
      { count: 0, min: Infinity, max: 0 },
    ),
  )

const zoom = () =>
  page.locator('.grid-pan').evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
    return m.a
  })

const report = async (label, file) => {
  const { count, min, max } = await shown()
  const z = await zoom()
  console.log(
    `${label.padEnd(12)} zoom ${z.toFixed(2)}  ·  ${count}/${defs} définitions affichées` +
      (count ? `  ·  ${(min * z).toFixed(1)}–${(max * z).toFixed(1)} px réels` : ''),
  )
  await page.screenshot({ path: `.debug/grid-${file}.png` })
}

await report('fitted', 'fit')

// Which definitions the fitted grid gives up on. A square showing nothing is
// the failure the whole change is about, so name the ones that still do.
const drawn = await page.locator('.grid .cell').evaluateAll((els) =>
  els.map((el) => el.querySelectorAll('.clue-text').length),
)
const mute = cells.flatMap((cell, i) =>
  (cell.clues ?? []).slice(drawn[i] ?? 0).map((clue) => clue.text),
)
if (mute.length) console.log(`             muettes: ${mute.join(' | ')}`)

/*
 * Where the arrows ended up. The whole point of the change is that they are no
 * longer inside the shaded squares, so count them: every arrow should be in a
 * letter square, and the only ones left in a definition are the ones pointing
 * at no square at all.
 */
const placed = await page.locator('.grid .cell:not(.clue) .grid-arrow').count()
const stranded = await page.locator('.grid .cell.clue .grid-arrow').count()
const wrong = await page.locator('.grid .cell.clue .grid-arrow:not(.orphan)').count()
console.log(
  `arrows       ${placed} dans les cases à remplir · ${stranded} sans case (signalées)` +
    (wrong ? `  ← ${wrong} DANS UNE DÉFINITION SANS RAISON` : ''),
)
if (placed + stranded !== defs) {
  console.log(`  FAIL ${defs} définitions mais ${placed + stranded} flèches dessinées`)
}

/*
 * The two ways in and back out again. Both exist because one is discoverable
 * and the other is quick, and a shortcut that only works one way is a trap:
 * getting close is useless if getting the whole grid back needs a pinch.
 */
const fittedZoom = await zoom()
const doubleTap = async () => {
  for (let i = 0; i < 2; i += 1) {
    await page.mouse.move(195, 400)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(400)
}
await doubleTap()
const tappedIn = await zoom()
await doubleTap()
const tappedOut = await zoom()
console.log(
  `double tap   ${fittedZoom.toFixed(2)} → ${tappedIn.toFixed(2)} → ${tappedOut.toFixed(2)}` +
    (tappedIn > fittedZoom * 1.3 && Math.abs(tappedOut - fittedZoom) < 0.02 ? '' : '  ← FAIL'),
)

await page.locator('.grid-zoom').click()
await page.waitForTimeout(500)
const buttonIn = await zoom()
await page.locator('.grid-zoom').click()
await page.waitForTimeout(500)
const buttonOut = await zoom()
console.log(
  `bouton       ${fittedZoom.toFixed(2)} → ${buttonIn.toFixed(2)} → ${buttonOut.toFixed(2)}` +
    (buttonIn > fittedZoom * 1.3 && Math.abs(buttonOut - fittedZoom) < 0.02 ? '' : '  ← FAIL'),
)
await page.locator('.grid-zoom').click()
await page.waitForTimeout(500)
await report('bouton zoom', 'zoomed')

/*
 * Write into a square that has an arrow in it. On paper the letter is written
 * over the arrow, and the two have to stay apart enough to read — looking is
 * the only way to tell whether they do.
 *
 * The square is chosen by where it is on screen rather than by its index: the
 * grid is panned and scaled inside its own transform, so most of it is off the
 * viewport and Playwright cannot click what it cannot reach.
 */
const spot = await page.evaluate(() => {
  for (const cell of document.querySelectorAll('.grid .cell:not(.clue)')) {
    if (!cell.querySelector('.grid-arrow')) continue
    const box = cell.getBoundingClientRect()
    if (box.top > 200 && box.bottom < 620 && box.left > 30 && box.right < 360) {
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }
  }
  return null
})
if (!spot) console.log('  (aucune case fléchée visible où écrire)')
else {
  await page.mouse.click(spot.x, spot.y)
  for (const letter of ['A', 'M', 'S', 'T', 'E', 'R']) {
    await page.getByRole('button', { name: letter, exact: true }).first().click().catch(() => {})
  }
  await page.waitForTimeout(400)
}

// And right in, where the definitions are meant to be plainly readable.
await page.mouse.move(spot?.x ?? 195, spot?.y ?? 300)
for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, -120)
await page.waitForTimeout(500)
await report('rapproché', 'close')

/*
 * What a pinch costs. Shortening a definition means measuring text, and it runs
 * while the grid renders, so a careless version re-measures every definition on
 * every frame. That is invisible on a desktop and ruinous on a phone, so the
 * frames are timed rather than reasoned about: this walks the zoom across the
 * range where shortening switches on and off, and reports the worst frame.
 */
await page.evaluate(() => {
  window.__frames = []
  let last = performance.now()
  const tick = () => {
    const now = performance.now()
    window.__frames.push(now - last)
    last = now
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})
// No pause between steps: a pinch does not give the browser time to catch up
// between frames either, and a sweep with gaps in it measures nothing.
for (let i = 0; i < 80; i += 1) await page.mouse.wheel(0, i % 40 < 20 ? 120 : -120)
await page.waitForTimeout(200)
const frames = await page.evaluate(() => window.__frames.slice(5))
frames.sort((a, b) => a - b)
const worst = frames[frames.length - 1] ?? 0
const median = frames[Math.floor(frames.length / 2)] ?? 0
console.log(
  `zoom fluide  ${frames.length} images · médiane ${median.toFixed(1)} ms · pire ${worst.toFixed(1)} ms` +
    (worst > 60 ? '  ← SACCADE' : ''),
)

await browser.close()
server.close()
