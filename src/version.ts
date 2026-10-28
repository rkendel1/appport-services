import { readFileSync } from 'node:fs';

/**
 * The installed package's own version, read once from its `package.json`.
 *
 * It is read rather than copied into source so it cannot drift from the
 * published manifest: the compiled module lives at `dist/src/version.js`,
 * two directories below the package root, in the repository and in an
 * installed package alike. `@appport/services/package.json` is also exported
 * for consumers that want the whole manifest.
 */
function readPackageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { name?: unknown; version?: unknown };
  if (manifest.name !== '@appport/services' || typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('@appport/services could not read its own package.json version');
  }
  return manifest.version;
}

/** The `@appport/services` version, exactly as declared in its `package.json`. */
export const VERSION: string = readPackageVersion();
