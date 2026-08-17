import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves the app from /<repo>/. Override with VITE_BASE when
// deploying elsewhere (e.g. VITE_BASE=/ for a custom domain).
const base = process.env.VITE_BASE ?? '/Ocr_crosswords/'

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
