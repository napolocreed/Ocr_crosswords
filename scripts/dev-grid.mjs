#!/usr/bin/env node
/**
 * Is the playing grid actually readable, and does zooming actually work?
 *
 *   node scripts/dev-grid.mjs
 *
 * Everything the grid has to get right — definitions small enough to fit but
 * large enough to read, arrows in the squares the answers start in, two
 * definitions stacked in one square, an arrow pointing nowhere — is a question
 * about pixels, and the only honest way to answer it is to look. So this builds
 * a grid with all of those cases in it, imports it through the app's own pack
 * reader, and shoots the play screen at three zooms in `.debug/grid-*.png`.
 *
 * It also counts what a screenshot cannot: how many definitions are shown *in
 * full* rather than cut short, at the zooms a reader can actually reach; where
 * every arrow ended up; and whether the gestures do what they are asked, using
 * real multi-touch rather than mouse events, because a pinch and a tap on a
 * dense grid interfere in ways a mouse never reproduces.
 *
 * The layout is synthetic — a magazine photo would have to be OCR'd first,
 * which takes minutes and mixes the pipeline's mistakes into the picture — but
 * the definitions come from a hand transcription when one is present, because
 * how long they are is the whole question.
 */
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { chromium } from 'playwright'

/* ------------------------------------------------------------ a test grid */

/** Real definitions from a hand-transcribed page; their length is the point. */
const TRANSCRIBED = 'fixtures/fleches-niveau2-p43.truth.json'
const FALLBACK = [
  'NOTE', 'ÎLE', 'DEMONSTRATIF', "COURS D'EAU DE SUISSE", 'PRONOM', 'ARTICLE',
  'RIVIÈRE DE FRANCE', 'IL EST TOUJOURS PRESSÉ', 'PARFOIS', 'MÉTAL PRÉCIEUX',
  'FIN DE SOIRÉE', 'BOUT DE BOIS', 'DÉCHIFFRÉ', 'ON Y VA POUR SE FAIRE VOIR',
  'TÊTU', 'ANCIEN', 'PAS FRAIS', 'CÉRÉALE', 'VIEILLE COLÈRE', 'AU BOUT DU FIL',
  'MIS DE CÔTÉ', 'PETIT COURS', 'PIÈCE DE CHARRUE', 'CRIA COMME UN CERF',
  'ÉTAT DES ÉTATS-UNIS', 'REFUS', 'LAC', 'RUSÉ', 'AGENT DE LIAISON',
  'DANS LA GAMME', 'PRÉPOSITION', 'ELLE FAIT TOURNER LES TÊTES',
  'FLEUVE CÔTIER', 'TRÈS ANCIEN', 'AVANT LA MATIÈRE', 'MESURE CHINOISE',
]
const SOURCE = existsSync(TRANSCRIBED)
  ? JSON.parse(readFileSync(TRANSCRIBED, 'utf8')).definitions
  : FALLBACK

/*
 * The magazines hyphenate long words to fit their squares — ABAN-DONNÉE,
 * CONS-TRUCTION on the real pages — and the OCR keeps those hyphens, so the
 * grid has to treat them as the line-break helpers they are. The transcription
 * writes the words out whole, so re-create the OCR's view on a slice of the
 * corpus: every fourth definition gets its longest word hyphenated at the
 * middle, deterministically.
 */
const DEFINITIONS = SOURCE.map((text, i) => {
  if (i % 4 !== 1) return text
  const words = text.split(' ')
  let longest = 0
  for (let k = 1; k < words.length; k += 1) {
    if (words[k].length > words[longest].length) longest = k
  }
  const word = words[longest]
  if (word.length < 8 || word.includes('-')) return text
  const mid = Math.ceil(word.length / 2)
  words[longest] = word.slice(0, mid) + '-' + word.slice(mid)
  return words.join(' ')
})
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
    // Most squares on a real page hold two definitions, which is the hard case:
    // each half gets barely a fifth of the square's height.
    const stacked = random() < 0.6
    const clues = Array.from({ length: stacked ? 2 : 1 }, () => ({
      id: `c${i}-${n}`,
      text: DEFINITIONS[n++ % DEFINITIONS.length],
      arrow: ARROWS[Math.floor(random() * 4)],
    }))
    cells[i] = { kind: 'clue', clues }
  }
}
// A dead square, and a mystery word reading off numbered squares.
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
const pack = { format: 'grilles.pack', version: 1, exportedAt: 1755600000000, puzzles: [puzzle] }
const wanted = cells.flatMap((cell) => (cell.clues ?? []).map((clue) => clue.text))
await mkdir('.debug', { recursive: true })
const packPath = resolve('.debug/dev-grid.json')
await writeFile(packPath, JSON.stringify(pack))
const lengths = wanted.map((t) => t.length).sort((a, b) => a - b)
const withHyphen = wanted.filter((t) => t.includes('-')).length
console.log(
  `grille ${cols} × ${rows} · ${wanted.length} définitions (${withHyphen} avec trait d'union) · ` +
    `${lengths[0]}–${lengths[lengths.length - 1]} caractères, médiane ${lengths[lengths.length >> 1]}` +
    (existsSync(TRANSCRIBED) ? '  (transcription réelle)' : '  (jeu de secours)'),
)

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

const failures = []

const zoom = () =>
  page.locator('.grid-pan').evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)

/**
 * What the grid is showing: not just how many definitions have text, but how
 * many have ALL of their text. A square reading ACCROIS… is not a definition,
 * and counting it as one is how the fitted grid came to look solved when it
 * was not.
 */
const legibility = async () => {
  const shown = await page.locator('.grid .cell').evaluateAll((els) =>
    els.map((el) =>
      [...el.querySelectorAll('.clue-text')].map((t) => ({
        text: t.textContent,
        size: Number.parseFloat(getComputedStyle(t).fontSize),
      })),
    ),
  )
  const z = await zoom()
  let drawn = 0
  let whole = 0
  let smallest = Infinity
  const cut = []
  cells.forEach((cell, i) => {
    ;(cell.clues ?? []).forEach((clue, k) => {
      const rendered = shown[i]?.[k]
      if (!rendered) return
      drawn += 1
      smallest = Math.min(smallest, rendered.size * z)
      if (rendered.text === clue.text) whole += 1
      else cut.push(`${clue.text} → ${rendered.text}`)
    })
  })
  return { z, drawn, whole, smallest, cut }
}

const report = async (label, file) => {
  const { z, drawn, whole, smallest } = await legibility()
  console.log(
    `${label.padEnd(13)}zoom ${z.toFixed(2)}  ·  ${drawn}/${wanted.length} affichées  ·  ` +
      `${whole}/${wanted.length} ENTIÈRES  ·  plus petite ${smallest.toFixed(1)} px`,
  )
  if (file) await page.screenshot({ path: `.debug/grid-${file}.png` })
  return { z, drawn, whole }
}

/** Wheel the zoom until it reaches `target`, or give up. */
const zoomToward = async (target) => {
  await page.mouse.move(195, 400)
  for (let i = 0; i < 60; i += 1) {
    const z = await zoom()
    if (Math.abs(z - target) < 0.02 || (target > z ? false : true) === (z < target)) {
      if (target > z ? z >= target : z <= target) break
    }
    if ((target > z && z >= target) || (target < z && z <= target)) break
    await page.mouse.wheel(0, target > z ? -120 : 120)
  }
  await page.waitForTimeout(250)
  return zoom()
}

console.log('\n— lisibilité —')
const fitted = await report('ajusté', 'fit')

/*
 * Do the accents survive?
 *
 * French definitions are set in capitals and thick with É È Ê Î Ô Ç, and a line
 * tighter than the font's own box clips the accents off the first line of each
 * square — silently, and unpredictably, since it depends on how the size
 * rounds. EMPLOYÉ becomes EMPLOYE, which is a different word. Nothing in the
 * text counts catches it, because the text is right; only the paint is wrong.
 * So this measures the ink: how far an accented capital reaches above the
 * baseline, against the room the layout actually leaves above it.
 */
const accents = await page.evaluate(() => {
  const sample = document.querySelector('.grid .clue-text')
  if (!sample) return []
  const style = getComputedStyle(sample)
  const base = Number.parseFloat(style.fontSize)
  const room = Number.parseFloat(style.paddingTop) / base
  const leading = Number.parseFloat(style.lineHeight) / base
  // The sizes actually painted on this grid, not a guessed ladder.
  const sizes = [
    ...new Set(
      [...document.querySelectorAll('.grid .clue-text')].map((el) =>
        Number.parseFloat(getComputedStyle(el).fontSize).toFixed(2),
      ),
    ),
  ].map(Number)
  const ctx = document.createElement('canvas').getContext('2d')
  return sizes.map((size) => {
    ctx.font = `${style.fontWeight} ${size}px ${style.fontFamily}`
    const m = ctx.measureText('ÉÈÊÎÔÇÀ')
    const halfLeading = (size * leading - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2
    const above = room * size + halfLeading + m.fontBoundingBoxAscent
    return { size, margin: above - m.actualBoundingBoxAscent }
  })
})
const tightest = accents.reduce((worst, a) => (a.margin < worst.margin ? a : worst), accents[0] ?? { margin: 0, size: 0 })
console.log(
  `accents      marge la plus faible ${tightest.margin.toFixed(2)} px à ${tightest.size} px` +
    (tightest.margin < 0 ? '  ← ROGNÉS' : ''),
)
if (tightest.margin < 0) failures.push('les accents des capitales sont rognés sur la première ligne')

/*
 * Where the arrows ended up. Every arrow should be in a letter square; the only
 * ones left in a definition are the ones pointing at no square at all.
 */
const placed = await page.locator('.grid .cell:not(.clue) .grid-arrow').count()
const stranded = await page.locator('.grid .cell.clue .grid-arrow').count()
const stray = await page.locator('.grid .cell.clue .grid-arrow:not(.orphan)').count()
console.log(
  `flèches      ${placed} dans les cases à remplir · ${stranded} sans case (signalées)`,
)
if (stray) failures.push(`${stray} flèches dessinées dans une définition sans raison`)
if (placed + stranded !== wanted.length) {
  failures.push(`${wanted.length} définitions mais ${placed + stranded} flèches`)
}
// And their size: a mark hugging the border, not a symbol filling the box.
const arrowShare = await page
  .locator('.grid .cell .grid-arrow')
  .first()
  .evaluate((el) => {
    const cell = el.closest('.cell')
    return el.getBoundingClientRect().width / cell.getBoundingClientRect().width
  })
console.log(`             taille : ${(arrowShare * 100).toFixed(0)} % de la case`)
if (arrowShare > 0.34) {
  failures.push(`les flèches occupent ${(arrowShare * 100).toFixed(0)} % de la case`)
}

/*
 * What one press of + gets you. This is the number that matters: a reader who
 * presses zoom once and still sees half-definitions has been told the control
 * does not work.
 */
const zoomIn = page.locator('.grid-zoom button[aria-label=Agrandir]')
const zoomOut = page.locator('.grid-zoom button[aria-label="Réduire"]')
await zoomIn.click()
await page.waitForTimeout(450)
const shortcut = await report('un + ', 'zoomed')
if (shortcut.whole < wanted.length) {
  failures.push(
    `une pression sur + ne montre que ${shortcut.whole}/${wanted.length} définitions entières`,
  )
}

// And pressing + again must go further in, never back out — the failure that
// read as "I have to try two or three times".
const climb = [shortcut.z]
for (let i = 0; i < 3; i += 1) {
  if (!(await zoomIn.isEnabled())) break
  await zoomIn.click()
  await page.waitForTimeout(350)
  climb.push(await zoom())
}
console.log(`+ + +        ${climb.map((z) => z.toFixed(2)).join(' → ')}`)
for (let i = 1; i < climb.length; i += 1) {
  if (climb[i] <= climb[i - 1]) failures.push('une pression sur + a réduit le zoom')
}
const descend = [await zoom()]
for (let i = 0; i < 4; i += 1) {
  if (!(await zoomOut.isEnabled())) break
  await zoomOut.click()
  await page.waitForTimeout(350)
  descend.push(await zoom())
}
console.log(`− − −        ${descend.map((z) => z.toFixed(2)).join(' → ')}`)
for (let i = 1; i < descend.length; i += 1) {
  if (descend[i] >= descend[i - 1]) failures.push('une pression sur − a agrandi le zoom')
}
if (Math.abs(descend[descend.length - 1] - fitted.z) > 0.02) {
  failures.push('à force de réduire on ne revient pas à la grille entière')
}

/*
 * The zoom a reader actually needs. This is the number the shortcut has to
 * land on: below it the squares are full of half-definitions, and guessing it
 * from the cell size rather than from the definitions is how the shortcut came
 * to stop short of being useful.
 */
const ladder = []
for (const target of [0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.4]) {
  const z = await zoomToward(target)
  const { whole } = await legibility()
  ladder.push(`${z.toFixed(1)}:${whole}`)
}
console.log(`entières par zoom  ${ladder.join('  ')}  (sur ${wanted.length})`)

await zoomToward(4)
const deepest = await report('zoom maxi', 'close')
if (deepest.whole < wanted.length) {
  const { cut } = await legibility()
  failures.push(`même au zoom maximum, ${wanted.length - deepest.whole} définitions restent coupées`)
  console.log(`             ex.: ${cut.slice(0, 3).join(' | ')}`)
}

/* ------------------------------------------------------------- gestures */

console.log('\n— gestes (vrai multi-touch) —')
const cdp = await context.newCDPSession(page)
const touch = (type, points) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 12, radiusY: 12 })),
  })

/** A two-finger pinch about (cx, cy), fingers going from `from` apart to `to`. */
const pinch = async (cx, cy, from, to) => {
  const at = (gap) => [
    { x: cx - gap / 2, y: cy },
    { x: cx + gap / 2, y: cy },
  ]
  await touch('touchStart', at(from))
  for (let i = 1; i <= 14; i += 1) {
    await touch('touchMove', at(from + ((to - from) * i) / 14))
    await page.waitForTimeout(16)
  }
  await touch('touchEnd', [])
  await page.waitForTimeout(300)
}

const tap = (x, y) => page.touchscreen.tap(x, y)
const selected = () =>
  page.evaluate(() => {
    const all = [...document.querySelectorAll('.grid .cell')]
    const active = document.querySelector('.grid .cell.active')
    return active ? String(all.indexOf(active)) : ''
  })

await zoomToward(fitted.z)
let before = await zoom()
await pinch(195, 420, 80, 300)
let after = await zoom()
console.log(`pincer +     ${before.toFixed(2)} → ${after.toFixed(2)}`)
if (after < before * 1.5) failures.push('un pincement pour agrandir ne change presque rien')

before = after
await pinch(195, 420, 300, 90)
after = await zoom()
console.log(`pincer −     ${before.toFixed(2)} → ${after.toFixed(2)}`)
if (after > before * 0.75) failures.push('un pincement pour réduire ne change presque rien')

// Three pinches in a row: the reported symptom is having to try again, so a
// single successful one proves nothing. Each starts from the fitted grid, or
// the last of them would only be measuring the zoom ceiling.
for (let i = 0; i < 3; i += 1) {
  await zoomToward(fitted.z)
  const was = await zoom()
  await pinch(195, 420, 90, 240)
  const now = await zoom()
  if (i === 0) console.log(`pincements   ${was.toFixed(2)} → ${now.toFixed(2)} (×3)`)
  if (now < was * 1.3) failures.push(`le pincement n° ${i + 1} d'une série n'a pas agrandi`)
}

// Filling in letters means tapping neighbouring squares in quick succession.
// That must never be mistaken for a double tap.
await zoomToward(fitted.z)
/*
 * Two squares side by side that can actually be selected. A square no
 * definition leads to is ignored on purpose (usePlayState.selectCell returns
 * early), so picking one of those would make this test pass while measuring
 * nothing — hence trying the candidates until a tap really moves the selection.
 */
const candidates = await page.evaluate(() => {
  const all = [...document.querySelectorAll('.grid .cell')]
  const pairs = []
  for (let i = 0; i < all.length - 1; i += 1) {
    const a = all[i]
    const b = all[i + 1]
    if (a.className !== 'cell' || b.className !== 'cell') continue
    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    if (rb.left < ra.left || Math.abs(rb.top - ra.top) > 1) continue
    if (ra.top < 260 || ra.bottom > 620) continue
    pairs.push([
      { x: ra.left + ra.width / 2, y: ra.top + ra.height / 2, i },
      { x: rb.left + rb.width / 2, y: rb.top + rb.height / 2, i: i + 1 },
    ])
  }
  return pairs
})

let neighbours = null
for (const pair of candidates) {
  // Both squares have to be selectable, not just the first: half the point of
  // the test is that the second tap lands where it was aimed.
  await tap(pair[0].x, pair[0].y)
  await page.waitForTimeout(150)
  if ((await selected()) !== String(pair[0].i)) continue
  await tap(pair[1].x, pair[1].y)
  await page.waitForTimeout(150)
  if ((await selected()) !== String(pair[1].i)) continue
  neighbours = pair
  break
}

await page.waitForTimeout(700)

if (!neighbours) console.log('  (aucune paire de cases voisines sélectionnable)')
else {
  const was = await zoom()
  const before = await page.locator('.grid-pan').evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
    return `${m.e.toFixed(1)},${m.f.toFixed(1)}`
  })
  await tap(neighbours[0].x, neighbours[0].y)
  await page.waitForTimeout(140)
  const first = await selected()
  // Selecting a square nudges the grid to keep it in view. At fitted zoom the
  // whole grid is on screen, so it must not move at all — a grid that shifts
  // under the finger makes the next tap land somewhere else.
  const after = await page.locator('.grid-pan').evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
    return `${m.e.toFixed(1)},${m.f.toFixed(1)}`
  })
  if (before !== after) failures.push(`toucher une case déplace la grille (${before} → ${after})`)
  await tap(neighbours[1].x, neighbours[1].y)
  await page.waitForTimeout(400)
  const second = await selected()
  const now = await zoom()
  const gap = Math.hypot(neighbours[1].x - neighbours[0].x, neighbours[1].y - neighbours[0].y)
  console.log(
    `2 cases voisines  ${gap.toFixed(0)} px d'écart · zoom ${was.toFixed(2)} → ${now.toFixed(2)}` +
      `  (visée ${neighbours[0].i}/${neighbours[1].i}, atteinte ${first || 'aucune'}/${second || 'aucune'})`,
  )
  // A test that silently failed to tap anything would pass the zoom check while
  // measuring nothing, so the selection has to have followed the fingers.
  if (first !== String(neighbours[0].i) || second !== String(neighbours[1].i)) {
    failures.push('un toucher sur une case ne la sélectionne pas')
  }
  if (Math.abs(now - was) > 0.02) {
    failures.push('toucher deux cases voisines coup sur coup déclenche le zoom')
  }

  // Two taps on one square already mean "switch to the crossing answer". The
  // zoom must keep its hands off it.
  const before2 = await zoom()
  await tap(neighbours[0].x, neighbours[0].y)
  await page.waitForTimeout(120)
  await tap(neighbours[0].x, neighbours[0].y)
  await page.waitForTimeout(500)
  const after2 = await zoom()
  console.log(`2× la même case   zoom ${before2.toFixed(2)} → ${after2.toFixed(2)}`)
  if (Math.abs(after2 - before2) > 0.02) {
    failures.push('toucher deux fois la même case déclenche le zoom')
  }
}

/*
 * The zoom has to survive playing.
 *
 * Selecting a word re-flows the clue bar below the grid, which resizes the grid's
 * own box by a pixel or two. If that is treated as "the grid needs fitting
 * again", zooming in to read and then tapping the square you were reading throws
 * you straight back out — and the definitions are cut again. That is the loop
 * the report describes, so it is worth a test of its own.
 */
/*
 * Press + until it has actually gone in. Starting from the rubber-band band
 * just below the fitted size — where a wheel or a pinch can easily leave it —
 * the first press only snaps back to fitted, and measuring there would be
 * measuring the fitted view again.
 */
for (let i = 0; i < 4; i += 1) {
  if ((await zoom()) > fitted.z * 1.2) break
  await zoomIn.click()
  await page.waitForTimeout(400)
}
const readingZoom = await zoom()
const somewhere = await page.evaluate(() => {
  for (const cell of document.querySelectorAll('.grid .cell')) {
    if (cell.className !== 'cell') continue
    const r = cell.getBoundingClientRect()
    if (r.top > 220 && r.bottom < 560 && r.left > 40 && r.right < 350) {
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
  }
  return null
})
if (somewhere) {
  await tap(somewhere.x, somewhere.y)
  await page.waitForTimeout(500)
  const kept = await zoom()
  const bar = await page.locator('.cluebar .text').innerText().catch(() => '')
  console.log(
    `zoom conservé  ${readingZoom.toFixed(2)} → ${kept.toFixed(2)} après avoir touché une case` +
      `  (barre : ${bar.slice(0, 34)})`,
  )
  if (Math.abs(kept - readingZoom) > 0.02) {
    failures.push(`toucher une case a ramené le zoom de ${readingZoom.toFixed(2)} à ${kept.toFixed(2)}`)
  }
  const { whole } = await legibility()
  if (whole < wanted.length) {
    failures.push(`après avoir touché une case, ${wanted.length - whole} définitions sont recoupées`)
  }
}

/* -------------------------------------------------------------- smoothness */

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
await page.mouse.move(195, 400)
// No pause between steps: a pinch does not give the browser time to catch up
// between frames either, and a sweep with gaps in it measures nothing.
// Short runs each way, so the zoom keeps moving instead of sitting against a
// limit — parked at the ceiling it is no longer a gesture, and the text
// settling there would be counted as a stutter under the fingers.
for (let i = 0; i < 64; i += 1) await page.mouse.wheel(0, i % 16 < 8 ? 120 : -120)

/*
 * Two numbers, because they mean different things. Frames *while the zoom is
 * moving* are the ones a hand feels; a single long frame once it has stopped —
 * the text being laid out again for where the zoom landed — is barely
 * noticeable, and is the price of not doing that work sixty times a second.
 */
const moving = (await page.evaluate(() => window.__frames.slice(5))).sort((a, b) => a - b)
await page.waitForTimeout(500)
const settling = (await page.evaluate(() => window.__frames)).slice(moving.length + 5)
const worst = moving[moving.length - 1] ?? 0
const settle = Math.max(0, ...settling)
console.log(
  `\nzoom fluide  ${moving.length} images pendant le geste · médiane ` +
    `${(moving[moving.length >> 1] ?? 0).toFixed(1)} ms · pire ${worst.toFixed(1)} ms` +
    ` · reprise après l'arrêt ${settle.toFixed(1)} ms`,
)
if (worst > 45) failures.push(`une image a pris ${worst.toFixed(0)} ms pendant le geste`)
if (settle > 150) failures.push(`la reprise du texte après l'arrêt a pris ${settle.toFixed(0)} ms`)

console.log(
  failures.length === 0
    ? '\nTOUT PASSE.'
    : `\nÉCHECS :\n  - ${failures.join('\n  - ')}`,
)
await browser.close()
server.close()
