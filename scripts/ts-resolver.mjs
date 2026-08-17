/**
 * Lets the dev harnesses import the app's extensionless TypeScript modules the
 * same way Vite does, so src/ stays free of tooling-specific import paths.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context)
    } catch {
      // fall through to the default resolution below
    }
  }
  return next(specifier, context)
}
