#!/usr/bin/env node
/**
 * Vendors every Tesseract runtime asset into public/tesseract/ so the PWA can
 * run OCR with no network at all (the default tesseract.js CDN is never hit).
 *
 * - worker script + wasm cores are copied out of node_modules
 * - fra.traineddata is downloaded once from tessdata_fast and then cached
 *
 * Safe to run repeatedly: existing files are left alone.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, copyFile, stat, rename, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'tesseract')
const langDir = join(outDir, 'lang')

/**
 * Files copied from node_modules.
 *
 * All three LSTM cores are vendored, not just one: tesseract.js probes the
 * browser at runtime and loads whichever it supports — relaxed SIMD on current
 * Chrome and Safari, plain SIMD on older builds, scalar as a last resort. Each
 * core needs its emscripten glue (`.wasm.js`) alongside the binary; omitting it
 * fails only at runtime, inside the worker, with an opaque importScripts error.
 * Only the one variant a given device picks is ever downloaded.
 */
const CORE_VARIANTS = [
  'tesseract-core-relaxedsimd-lstm',
  'tesseract-core-simd-lstm',
  'tesseract-core-lstm',
]

const COPIES = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ...CORE_VARIANTS.flatMap((variant) =>
    ['.js', '.wasm', '.wasm.js'].map((extension) => [
      `tesseract.js-core/${variant}${extension}`,
      `${variant}${extension}`,
    ]),
  ),
]

/** Language data. Uncompressed, so tesseract.js must be created with gzip:false. */
const LANGS = [
  {
    file: 'fra.traineddata',
    url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/fra.traineddata',
    minBytes: 500_000,
  },
]

async function exists(p, minBytes = 1) {
  try {
    const s = await stat(p)
    return s.isFile() && s.size >= minBytes
  } catch {
    return false
  }
}

async function download(url, dest, minBytes) {
  const tmp = `${dest}.part`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  await pipeline(res.body, createWriteStream(tmp))
  const s = await stat(tmp)
  if (s.size < minBytes) {
    await rm(tmp, { force: true })
    throw new Error(`${url} returned only ${s.size} bytes (expected >= ${minBytes})`)
  }
  await rename(tmp, dest)
  return s.size
}

async function main() {
  await mkdir(langDir, { recursive: true })

  for (const [from, to] of COPIES) {
    const src = join(root, 'node_modules', from)
    const dest = join(outDir, to)
    if (!(await exists(src))) {
      throw new Error(`Missing ${from} in node_modules — run npm install first.`)
    }
    await copyFile(src, dest)
  }
  console.log(`[ocr-assets] copied ${COPIES.length} runtime files into public/tesseract/`)

  for (const lang of LANGS) {
    const dest = join(langDir, lang.file)
    if (await exists(dest, lang.minBytes)) {
      console.log(`[ocr-assets] ${lang.file} already present, skipping download`)
      continue
    }
    process.stdout.write(`[ocr-assets] downloading ${lang.file} ... `)
    const size = await download(lang.url, dest, lang.minBytes)
    console.log(`${(size / 1024 / 1024).toFixed(2)} MB`)
  }
}

main().catch((err) => {
  console.error(`[ocr-assets] FAILED: ${err.message}`)
  process.exit(1)
})
