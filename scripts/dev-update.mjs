#!/usr/bin/env node
/**
 * Does a deployed update actually reach a phone that already has the app?
 *
 *   node scripts/dev-update.mjs
 *
 * A service-worker app can serve yesterday's code from cache indefinitely, and
 * the failure is invisible: the page loads, it just is not the page that was
 * shipped. Reasoning about workbox's configuration does not settle it, because
 * the answer depends on the browser's own update timing. So this serves one
 * build, loads it the way a returning visitor would, swaps the directory for a
 * newer build, and counts the reloads until the new one is running.
 *
 * The served copy is a snapshot rather than `dist` itself, so a rebuild halfway
 * through mirrors a deploy landing while someone has the app open.
 */
import { createServer } from 'node:http'
import { readFile, mkdir, rm, cp } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { extname, join, resolve } from 'node:path'
import { chromium } from 'playwright'

const BASE = '/Ocr_crosswords/'
const served = resolve('.debug/served')
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.traineddata': 'application/octet-stream',
}

/**
 * Caching headers close to what GitHub Pages sends: hashed assets are immutable,
 * everything else is revalidated. Serving no-store instead would hide exactly the
 * class of staleness this test is looking for.
 */
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (path.startsWith(BASE)) path = path.slice(BASE.length - 1)
    if (path === '/' || path === '') path = '/index.html'
    const file = join(served, path)
    const body = await readFile(file)
    const hashed = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(path)
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=600',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
await new Promise((r) => server.listen(4175, r))
const url = `http://localhost:4175${BASE}`

const snapshot = async () => {
  await rm(served, { recursive: true, force: true })
  await mkdir(served, { recursive: true })
  await cp(resolve('dist'), served, { recursive: true })
}

const build = (id) =>
  execFileSync('npm', ['run', 'build'], { stdio: 'ignore', env: { ...process.env, VITE_BUILD_ID: id } })

console.log('build A …')
build('A-old')
await snapshot()

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: true,
  args: ['--no-sandbox'],
})
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await context.newPage()

/** The build the running page reports, read from the About card. */
const runningBuild = async () => {
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.locator('[data-role=build]').waitFor({ timeout: 10000 })
  const text = (await page.locator('[data-role=build]').innerText()).trim()
  await page.goBack().catch(() => {})
  return text
}

await page.goto(url, { waitUntil: 'networkidle' })
// Let the first service worker install and take control.
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 })
const first = await runningBuild()
console.log(`visitor is running: ${first}`)

console.log('\nbuild B (a deploy lands while the app is open) …')
build('B-new')
await snapshot()

/*
 * Two ways a person meets a new version, and both have to work.
 *
 * Reloading is the obvious one. The other is the one an installed app actually
 * does: it is never reloaded, only put away and opened again — so the check has
 * to happen when it comes back to the foreground, and the update has to apply
 * while it is away.
 */
const failures = []

let seen = first
for (let reload = 1; reload <= 3 && seen === first; reload++) {
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  seen = await runningBuild()
  console.log(`  reload ${reload}: ${seen}${seen === first ? '  (still old)' : '  ← updated'}`)
}
if (seen === first) failures.push('reloading three times did not bring the new build')

// A second visitor, still on the old build, who never reloads.
console.log('\nan installed app that is only ever backgrounded and reopened:')
const away = await context.newPage()
await away.goto(url, { waitUntil: 'networkidle' })
await away.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 })
await away.waitForTimeout(1500)

for (let round = 1; round <= 3; round++) {
  // Put it away: the update is applied to a hidden page, costing nobody anything.
  await away.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await away.waitForTimeout(2500)
  // And bring it back, which is also when a fresh check should fire.
  await away.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await away.waitForTimeout(2500)
  const now = (await away.locator('[data-role=build]').count())
    ? (await away.locator('[data-role=build]').innerText()).trim()
    : await (async () => {
        await away.getByRole('button', { name: 'Réglages' }).first().click()
        await away.locator('[data-role=build]').waitFor({ timeout: 10000 })
        return (await away.locator('[data-role=build]').innerText()).trim()
      })()
  console.log(`  away and back ${round}: ${now}${now === first ? '  (still old)' : '  ← updated'}`)
  if (now !== first) break
  if (round === 3) failures.push('backgrounding and reopening never picked the new build up')
}

console.log(
  failures.length === 0
    ? '\nBoth paths update.'
    : `\nFAIL:\n  - ${failures.join('\n  - ')}`,
)
await browser.close()
server.close()
