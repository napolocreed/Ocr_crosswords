/**
 * Lets the dev harnesses import the app's extensionless TypeScript modules the
 * same way Vite does, so src/ stays free of tooling-specific import paths.
 *
 * Two shapes, because Vite resolves both: `./thing` may be `./thing.ts` or a
 * folder with an `index.ts` in it. Node's ESM resolver refuses the second
 * outright, which meant a module perfectly happy in the app could not be
 * reached by a test — the one place it most needs reaching.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await next(candidate, context)
      } catch {
        // try the next shape, then the default resolution below
      }
    }
  }
  return next(specifier, context)
}
