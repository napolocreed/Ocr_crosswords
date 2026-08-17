#!/usr/bin/env node
/**
 * End-to-end smoke test in a real browser: serves the production build, walks
 * the import flow with a real magazine photo, and checks that solving works.
 *
 *   node scripts/smoke.mjs [--headed]
 *
 * Screenshots land in .debug/smoke-*.png.
 */
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { chromium } from 'playwright'

const BASE = '/Ocr_crosswords/'
const dist = resolve('dist')
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
}

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (path.startsWith(BASE)) path = path.slice(BASE.length - 1)
    if (path === '/' || path === '') path = '/index.html'
    const file = join(dist, path)
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
await new Promise((r) => server.listen(4173, r))
const url = `http://localhost:4173${BASE}`
console.log(`serving dist at ${url}`)

await mkdir('.debug', { recursive: true })
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: !process.argv.includes('--headed'),
  args: ['--no-sandbox'],
})
// A realistic small phone: this is the layout that has to work.
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: 'fr-FR',
})
const page = await context.newPage()

const failures = []
const problems = []
page.on('console', (msg) => {
  if (msg.type() === 'error') problems.push(`console: ${msg.text()}`)
})
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

const shot = (name) => page.screenshot({ path: `.debug/smoke-${name}.png` })

console.log('\n1. library')
await page.goto(url, { waitUntil: 'networkidle' })
await check('empty state visible', async () => {
  await page.getByText('Ta bibliothèque est vide').waitFor({ timeout: 10000 })
})
await check('new grid button visible', async () => {
  await page.getByRole('button', { name: /Nouvelle grille/ }).waitFor({ timeout: 5000 })
})
await shot('1-library')

console.log('\n2. import: pick a photo')
await page.getByRole('button', { name: /Nouvelle grille/ }).click()
await page.getByText('Photographie la grille').waitFor({ timeout: 5000 })
await page.setInputFiles('input[type=file]', 'fixtures/sport-cerebral-42.jpg')

await check('crop screen with a detected grid', async () => {
  await page.getByText(/Cadre la grille/).waitFor({ timeout: 20000 })
  // Wait for the debounced analysis to report a size.
  await page.waitForFunction(
    () => /\d+ × \d+ · \d+ définitions/.test(document.body.innerText),
    null,
    { timeout: 30000 },
  )
})
const detected = await page.locator('.topbar .subtitle').first().innerText()
console.log(`       detected: ${detected}`)
await shot('2-crop')

console.log('\n3. orientation')
await check('sideways photo is called out', async () => {
  // The fixture is a portrait page shot in landscape, so the app must notice.
  await page.getByText(/la photo est couchée/i).waitFor({ timeout: 30000 })
})
await check('rotating clears the warning and re-detects', async () => {
  // The fixture has EXIF orientation 3 (180°), which the browser applies on
  // decode, so three quarter turns are needed to bring the page upright.
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Pivoter' }).first().click()
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(1200)
  await page.waitForFunction(
    () => /\d+ × \d+ · \d+ définitions/.test(document.body.innerText),
    null,
    { timeout: 30000 },
  )
  if (await page.getByText(/la photo est couchée/i).isVisible().catch(() => false)) {
    throw new Error('still reported as sideways after rotating')
  }
  console.log(`       now: ${(await page.locator('.topbar .subtitle').first().innerText()).trim()}`)
})
await shot('2b-rotated')

console.log('\n4. OCR pass')
await page.getByRole('button', { name: 'Lire', exact: true }).click()
await check('OCR runs and reaches review', async () => {
  await page.getByText('Lecture en cours').waitFor({ timeout: 10000 })
  await shot('3-ocr')
  await page.getByText('Relecture').waitFor({ timeout: 240000 })
})
await shot('4-review-structure')

console.log('\n5. review')
await check('definitions pass lists clues with crops', async () => {
  await page.getByRole('button', { name: /2\. Définitions/ }).click()
  await page.locator('.review-row').first().waitFor({ timeout: 10000 })
  const rows = await page.locator('.review-row').count()
  if (rows === 0) throw new Error('no clue rows')
  const crops = await page.locator('.review-row img.crop').count()
  console.log(`       ${rows} rows, ${crops} with a crop image`)
  const texts = await page.locator('.review-row input').evaluateAll((els) =>
    els.map((el) => el.value).filter(Boolean),
  )
  console.log(`       sample OCR: ${JSON.stringify(texts.slice(0, 8))}`)
  // Real definitions are words, not stray glyphs: require a decent share of the
  // results to look like actual French text.
  const wordy = texts.filter((t) => /^[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ' -]{4,}$/.test(t) && /[AEIOUY]/.test(t))
  console.log(`       ${wordy.length}/${texts.length} non-empty results look like words`)
  if (wordy.length < 30) throw new Error(`only ${wordy.length} word-like results out of ${texts.length}`)
})

await check('arrow assignment keeps every definition it is given', async () => {
  // Guards the padding rule: a square with two stacked definitions must yield
  // two clue rows, never one. 74 is the measured baseline for this fixture in
  // Chromium — Node reaches ~98 on the same photo, and that gap is a known open
  // issue in hairline detection, tracked in the README rather than here.
  const rows = await page.locator('.review-row').count()
  console.log(`       ${rows} definition rows`)
  if (rows < 74) throw new Error(`only ${rows} definition rows — a regression`)
})

await check('bent arrows are read from the page', async () => {
  // Both bent labels read "... puis ...", so one selector covers them.
  const bent = await page
    .locator('.arrow-picker button[aria-pressed="true"][aria-label*="puis"]')
    .count()
  const total = await page.locator('.arrow-picker').count()
  console.log(`       ${bent} bent of ${total} definitions shown`)
  if (bent < 3) throw new Error(`expected several bent arrows, found ${bent}`)
})
await shot('5-review-definitions')

console.log('\n5b. mystery word')
await check('numbering squares builds the mystery answer', async () => {
  await page.getByRole('button', { name: /3\. Mystère/ }).click()
  await page.locator('#mystery-clue').fill('Tropique, signe astrologique et coléoptère')
  // Tap three fillable squares, in order.
  const fillable = page.locator('.grid .cell:not(.clue):not(.block)')
  for (let i = 0; i < 3; i++) await fillable.nth(i + 2).click()
  await page.waitForTimeout(200)
  const chips = await page.locator('.mystery-order-chip').count()
  if (chips !== 3) throw new Error(`expected 3 numbered squares, got ${chips}`)
  // Badges must appear in the grid itself.
  const badges = await page.locator('.cell .mystery-badge').count()
  if (badges !== 3) throw new Error(`expected 3 badges in the grid, got ${badges}`)
  console.log(`       3 squares numbered, ${badges} badges shown`)
})
await check('undo removes the last numbered square', async () => {
  await page.getByRole('button', { name: /↩ Annuler/ }).click()
  await page.waitForTimeout(150)
  const chips = await page.locator('.mystery-order-chip').count()
  if (chips !== 2) throw new Error(`expected 2 after undo, got ${chips}`)
})
await shot('5c-review-mystery')

console.log('\n6. play')
await check('saving the review opens the grid', async () => {
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await page.locator('.keyboard').waitFor({ timeout: 10000 })
  await page.locator('.cluebar').waitFor({ timeout: 5000 })
})
await shot('6-play')

await check('mystery bar shows the answer taking shape', async () => {
  await page.locator('.mystery-bar').waitFor({ timeout: 5000 })
  const slots = await page.locator('.mystery-bar .mystery-slot').count()
  if (slots !== 2) throw new Error(`expected 2 mystery slots, got ${slots}`)
  await page.locator('.mystery-bar').click()
  await page.getByText(/Tropique, signe astrologique/).waitFor({ timeout: 5000 })
  await page.locator('.sheet-backdrop').click({ position: { x: 5, y: 5 } })
  await page.waitForTimeout(200)
  console.log('       bar renders and opens the clue')
})

await check('typing letters fills squares', async () => {
  const before = await page.locator('.topbar .subtitle').first().innerText()
  for (const letter of ['A', 'B', 'C']) {
    await page.locator('.keyboard .key', { hasText: new RegExp(`^${letter}$`) }).first().click()
  }
  await page.waitForTimeout(200)
  const after = await page.locator('.topbar .subtitle').first().innerText()
  if (before === after) throw new Error(`counter did not move (${before})`)
  console.log(`       ${before.trim()} -> ${after.trim()}`)
})

await check('draft mode writes small grey candidates', async () => {
  await page.getByRole('button', { name: /Brouillon/ }).click()
  await page.locator('.keyboard .key', { hasText: /^Z$/ }).first().click()
  await page.locator('.keyboard .key', { hasText: /^E$/ }).first().click()
  await page.waitForTimeout(200)
  const drafts = await page.locator('.cell .drafts').count()
  if (drafts === 0) throw new Error('no draft cell rendered')
  console.log(`       ${drafts} square(s) holding candidates`)
})
await shot('7-play-drafts')

await check('confirmed letters persist alongside drafts', async () => {
  // Leave draft mode and fill a different answer, so the library has a
  // confirmed letter to report (a draft alone is deliberately not progress).
  await page.getByRole('button', { name: /Brouillon/ }).click()
  await page.getByRole('button', { name: 'Mot suivant' }).click()
  for (const letter of ['T', 'E']) {
    await page.locator('.keyboard .key', { hasText: new RegExp(`^${letter}$`) }).first().click()
  }
  await page.waitForTimeout(200)
  const filled = await page.locator('.topbar .subtitle').first().innerText()
  if (/^0\//.test(filled.trim())) throw new Error(`nothing confirmed: ${filled.trim()}`)
  console.log(`       ${filled.trim()}`)
})

await check('progress survives a reload', async () => {
  await page.waitForTimeout(700) // let the autosave debounce fire
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('.library-item').first().waitFor({ timeout: 10000 })
  const text = await page.locator('.library-item').first().innerText()
  if (!/%|terminée/.test(text)) throw new Error(`no progress badge: ${text.replace(/\n/g, ' | ')}`)
  console.log(`       ${text.replace(/\n/g, ' | ')}`)
})
await shot('8-library-after')

console.log('\n9. export / import round trip')
await check('pack export produces a downloadable file', async () => {
  await page.getByRole('button', { name: 'Sélectionner' }).click()
  await page.locator('.library-item').first().click()
  const download = page.waitForEvent('download', { timeout: 15000 })
  await page.getByRole('button', { name: /Exporter/ }).click()
  const file = await download
  const path = `.debug/${file.suggestedFilename()}`
  await file.saveAs(path)
  const pack = JSON.parse(await readFile(path, 'utf8'))
  if (pack.format !== 'grilles.pack' || pack.puzzles.length !== 1) {
    throw new Error('unexpected pack contents')
  }
  console.log(`       ${file.suggestedFilename()}: ${pack.puzzles[0].cols}x${pack.puzzles[0].rows}, ${pack.progress?.length ?? 0} progress record(s)`)
})

await browser.close()
server.close()

const realProblems = problems.filter((p) => !/favicon|manifest|404/i.test(p))
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILURE(S)`}`)
for (const failure of failures) console.log(`  - ${failure}`)
if (realProblems.length) {
  console.log('page errors:')
  for (const problem of [...new Set(realProblems)].slice(0, 10)) console.log(`  - ${problem}`)
}
process.exit(failures.length === 0 ? 0 : 1)
