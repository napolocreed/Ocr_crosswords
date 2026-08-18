#!/usr/bin/env node
/**
 * Runs one photo through the real app in a real browser and prints what it read.
 *
 *   node scripts/dev-browser.mjs fixtures/photo.jpg [--turns 3]
 *
 * The Node harnesses measure the shared library; this measures the *app*, which
 * is not the same thing. The browser decodes and downscales images with its own
 * code, and applies EXIF orientation before the app ever sees the pixels — so a
 * result that reproduces in Node may not reproduce here, and the other way round.
 * When a user reports something the harness cannot reproduce, this is the tool
 * that says whether the difference is the browser.
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const photo = args.find((a) => !a.startsWith('--')) ?? 'fixtures/fleches-niveau2-p43.jpg'
const turnsArg = args.indexOf('--turns')
const turns = turnsArg >= 0 ? Number(args[turnsArg + 1]) : 0

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
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
await new Promise((r) => server.listen(4174, r))
await mkdir('.debug', { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: true,
  args: ['--no-sandbox'],
})
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
})
const page = await context.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log(`  [browser] ${m.text()}`) })
await page.goto(`http://localhost:4174${BASE}`, { waitUntil: 'networkidle' })

await page.getByRole('button', { name: /Nouvelle grille/ }).click()
await page.getByText('Ajoute une grille').waitFor({ timeout: 10000 })
await page.setInputFiles('input[data-role=library]', photo)
await page.getByText(/Cadre la grille/).waitFor({ timeout: 30000 })
await page.waitForFunction(() => /\d+ × \d+ · \d+ définitions/.test(document.body.innerText), null, { timeout: 40000 })

for (let i = 0; i < turns; i++) {
  await page.getByRole('button', { name: 'Pivoter' }).first().click()
  await page.waitForTimeout(600)
}
await page.waitForTimeout(1500)
console.log(`photo   ${photo}  (+${turns} quarter turns)`)
console.log(`crop    ${(await page.locator('.topbar .subtitle').first().innerText()).trim()}`)
await page.screenshot({ path: '.debug/probe-crop.png' })

await page.getByRole('button', { name: 'Lire', exact: true }).click()
await page.getByRole('button', { name: /2\. Définitions/ }).waitFor({ timeout: 300000 })
await page.getByRole('button', { name: /2\. Définitions/ }).click()
await page.waitForTimeout(800)
// Show every definition, not just the flagged ones.
await page.locator('.seg button', { hasText: 'Toutes' }).first().click().catch(() => {})
await page.waitForTimeout(600)
const rows = await page.locator('.review-row').evaluateAll((els) =>
  els.map((el) => ({
    text: el.querySelector('textarea')?.value ?? '',
    flagged: el.classList.contains('flagged'),
  })),
)
const texts = rows.map((r) => r.text)
console.log(`review  ${texts.length} definitions, ${rows.filter((r) => r.flagged).length} flagged`)
await page.screenshot({ path: '.debug/probe-review.png', fullPage: false })

const truthPath = photo.replace(/\.[^.]+$/, '.truth.json')
if (existsSync(truthPath)) {
  const truth = JSON.parse(readFileSync(truthPath, 'utf8'))
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const got = texts.map(norm).filter(Boolean)
  const missing = truth.definitions.filter((d) => !got.includes(norm(d)))
  console.log(`truth   ${truth.definitions.length} definitions, ${missing.length} not read exactly`)
  for (const m of missing) console.log(`  missing: ${m}`)

  /*
   * How well the review flag predicts a reading that is actually wrong.
   *
   * The flag exists to spend the reader's attention where it is needed. A false
   * alarm is not free — it is a row they read, compare and dismiss — and the
   * complaint that "90% of the flagged ones are fine" is a statement about this
   * table, so it is the table to tune against rather than the threshold.
   */
  const wanted = truth.definitions.map(norm)
  const pool = wanted.slice()
  const judged = rows.map((r) => {
    const key = norm(r.text)
    const at = pool.indexOf(key)
    if (key && at >= 0) {
      pool.splice(at, 1)
      return { ...r, right: true }
    }
    return { ...r, right: false }
  })
  const count = (f, ok) => judged.filter((j) => j.flagged === f && j.right === ok).length
  console.log(
    `flags   raised ${count(true, false)} on wrong, ${count(true, true)} on right ` +
      `(false alarms) | silent on ${count(false, false)} wrong, ${count(false, true)} right`,
  )
  await writeFile('.debug/probe-rows.json', JSON.stringify(judged, null, 2))
}
await writeFile('.debug/probe-definitions.json', JSON.stringify(texts, null, 2))
await browser.close()
server.close()
