import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * A stamp identifying the build, shown in the app's About card.
 *
 * A service-worker app can be a version behind without looking like it, so
 * "which build am I actually running" has to be answerable from the phone
 * itself — otherwise a bug report and the code cannot be lined up.
 */
const buildId = (() => {
  // Overridable so the update test can build two provably different bundles;
  // without that its two builds land in the same minute on the same commit and
  // come out byte-identical, which would make it pass by measuring nothing.
  if (process.env.VITE_BUILD_ID) return process.env.VITE_BUILD_ID
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    return `${stamp} · ${sha.toString().trim()}`
  } catch {
    return stamp
  }
})()

// GitHub Pages serves the app from /<repo>/. Override with VITE_BASE when
// deploying elsewhere (e.g. VITE_BASE=/ for a custom domain).
const base = process.env.VITE_BASE ?? '/Ocr_crosswords/'

export default defineConfig({
  base,
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    react(),
    VitePWA({
      // Not 'autoUpdate': that reloads the page the moment a new worker
      // activates, which can land in the middle of a review and take the
      // corrections with it. main.tsx applies the update when the app is put
      // away instead. See the comment there.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Grilles — mots fléchés',
        short_name: 'Grilles',
        description:
          'Photographie tes mots fléchés de magazine, digitalise-les et remplis-les partout, hors-ligne.',
        lang: 'fr',
        dir: 'ltr',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#12151c',
        theme_color: '#12151c',
        categories: ['games', 'puzzle'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        /*
         * Take control at once, but never replace a running version unasked.
         *
         * These two are independent and only one of them is wanted. `clientsClaim`
         * makes a freshly activated worker adopt the page that is already open,
         * which on a first visit is what makes the app work offline straight away
         * rather than after a reload. `skipWaiting` is the one that swaps the code
         * out from under a running session. That is wanted too — a page left on
         * old code against a new cache reaches for chunks that have been purged —
         * but *when* the page reloads to catch up is main.tsx's decision, so that
         * a review in progress is never thrown away.
         */
        clientsClaim: true,
        skipWaiting: true,
        // The OCR engine (~7 MB) is deliberately kept OUT of the precache so
        // the first visit stays light; it is cached on first use instead, and
        // can be primed on demand from the settings screen.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        globIgnores: ['**/tesseract/**'],
        navigateFallback: `${base}index.html`,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/tesseract/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-engine-v1',
              expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
              rangeRequests: true,
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    // Tesseract's wasm loader is large; keep the warning threshold realistic.
    chunkSizeWarningLimit: 1200,
  },
})
