#!/usr/bin/env node
/**
 * Checks the update guard holds, and lets go.
 *
 * A guard that is merely present is worse than none, because it reads as
 * protection. This is a plain module with no DOM in it, so it can be exercised
 * directly rather than inferred from a browser's behaviour.
 *
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/dev-guard.mjs
 */
import { holdReload, whenSafeToReload } from '../src/lib/updateGuard.ts'

const failures = []
const check = (name, ok) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) failures.push(name)
}

// Nothing at stake: the update applies at once.
let applied = 0
whenSafeToReload(() => applied++)
check('applies immediately when nothing is held', applied === 1)

// Work in progress: the update waits, then lands when the work is done.
applied = 0
const release = holdReload()
whenSafeToReload(() => applied++)
check('waits while a review is unsaved', applied === 0)
release()
check('applies once the review is saved', applied === 1)

// Two screens holding at once: the last one out releases it.
applied = 0
const a = holdReload()
const b = holdReload()
whenSafeToReload(() => applied++)
a()
check('still waits while a second holder remains', applied === 0)
b()
check('applies when the last holder lets go', applied === 1)

// Releasing twice must not fire a second reload.
applied = 0
const once = holdReload()
whenSafeToReload(() => applied++)
once()
once()
check('a repeated release does not reload twice', applied === 1)

console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nguard holds and lets go')
process.exit(failures.length ? 1 : 0)
