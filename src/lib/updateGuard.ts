/**
 * Lets a screen say that reloading right now would lose work.
 *
 * A new version has to be applied by reloading, and the app cannot keep running
 * the old code once the new service worker has taken over — the outdated chunks
 * it might reach for are purged. So the reload happens immediately, except while
 * something is genuinely at stake.
 *
 * Exactly one thing is: corrections typed into the review screen live in memory
 * until the grid is saved. Everything else is already persisted as it is entered
 * — letters, drafts and progress all go to IndexedDB on each keystroke — so a
 * reload there costs nothing at all.
 */
let holders = 0
let onRelease: (() => void) | null = null

/** Marks work in progress. Call the returned function when it is safe again. */
export function holdReload(): () => void {
  holders++
  let released = false
  return () => {
    if (released) return
    released = true
    holders--
    if (holders === 0 && onRelease) {
      const run = onRelease
      onRelease = null
      run()
    }
  }
}

/** Runs `apply` now, or as soon as nothing is at stake. */
export function whenSafeToReload(apply: () => void): void {
  if (holders === 0) {
    apply()
    return
  }
  onRelease = apply
}
