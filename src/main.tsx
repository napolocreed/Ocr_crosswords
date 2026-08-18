import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { whenSafeToReload } from './lib/updateGuard'
import './styles.css'

/**
 * How often to ask whether a new version has been deployed, in minutes.
 *
 * A browser only checks when it navigates, so an app that is kept open — which an
 * installed one is, for days — never finds out on its own. This is the gap that
 * made an update feel like it had not arrived.
 */
const UPDATE_CHECK_MINUTES = 30

/*
 * A new version is applied by reloading, at once unless something is at stake.
 *
 * At once, because the alternative is worse than the interruption: once the new
 * worker has taken over, the running page is old code against a new cache, and
 * the chunks it might reach for have been purged. Deferring that leaves a session
 * that looks fine until it breaks.
 *
 * The one thing at stake is a review in progress, whose corrections live in
 * memory until the grid is saved; `updateGuard` holds the reload for exactly that
 * and nothing else. Everything in play — letters, drafts, progress — is written
 * to IndexedDB as it is typed, so reloading there costs nothing.
 */
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return
    const check = () => {
      if (document.visibilityState === 'visible') void registration.update()
    }
    // Coming back to the app is when a check is both cheap and worth making.
    document.addEventListener('visibilitychange', check)
    setInterval(check, UPDATE_CHECK_MINUTES * 60_000)
  },
})

/*
 * Catch up as soon as the new worker takes over.
 *
 * Not `onNeedRefresh`, which never fires here: that reports a worker sitting in
 * *waiting*, and this one is configured to skip that state so a reload is served
 * the new version straight away rather than the one after. What there is to react
 * to is the handover itself. Without this the page keeps running old code until
 * something else reloads it — measured, that was a second reload the person had
 * to think to do, which is the whole complaint.
 */
if ('serviceWorker' in navigator) {
  // A first install claims this page too; that is not an update and reloading for
  // it would restart every first visit for nothing.
  const wasControlled = navigator.serviceWorker.controller !== null
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wasControlled) return
    whenSafeToReload(() => window.location.reload())
  })
}

const container = document.getElementById('root')
if (!container) throw new Error('#root introuvable')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
