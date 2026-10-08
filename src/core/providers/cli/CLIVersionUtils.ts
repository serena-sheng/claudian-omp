/**
 * CLI version comparison and registry lookup.
 *
 * Local probing lives in `CLIInstallationProbe`; this module compares version
 * strings and fetches the latest published version from the npm registry. The
 * registry fetch is network I/O, so callers treat it as non-blocking and
 * injectable (see `fetchLatestCLIVersion`).
 */

interface VersionParts {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(value: string): VersionParts | null {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u);
  if (!match) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const aNumeric = /^\d+$/u.test(a[index]);
    const bNumeric = /^\d+$/u.test(b[index]);
    if (aNumeric && bNumeric) {
      const delta = Number(a[index]) - Number(b[index]);
      if (delta !== 0) {
        return delta < 0 ? -1 : 1;
      }
    } else if (aNumeric) {
      return -1;
    } else if (bNumeric) {
      return 1;
    } else if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Compare two semver strings. Returns >0 when `a > b`, <0 when `a < b`, and 0
 * when equal or either cannot be parsed.
 */
export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA || !parsedB) {
    return 0;
  }
  for (let index = 0; index < 3; index++) {
    const delta = parsedA.core[index] - parsedB.core[index];
    if (delta !== 0) {
      return delta < 0 ? -1 : 1;
    }
  }
  return comparePre(parsedA.pre, parsedB.pre);
}

/**
 * Whether an update is available: `latest` is strictly greater than `current`.
 */
export function isUpdateAvailable(
  current: string | null | undefined,
  latest: string | null | undefined,
): boolean {
  if (!current || !latest) {
    return false;
  }
  // A prerelease of the same base version is not behind the stable release
  // (e.g. current=1.2.3-next.1, latest=1.2.3).
  if (current !== latest && current.startsWith(latest)) {
    return false;
  }
  return compareVersions(latest, current) > 0;
}

/** Minimal shape of an npm registry `/latest` response. */
export interface CLIRegistryResponse {
  status: number;
  json: unknown;
}

export type CLIRegistryFetcher = (url: string) => Promise<CLIRegistryResponse>;

async function defaultRegistryFetcher(url: string): Promise<CLIRegistryResponse> {
  // Lazy import so Node-side consumers (unit tests, smoke scripts) never load
  // the Obsidian runtime just to compare versions.
  const { requestUrl } = await import('obsidian');
  const response = await requestUrl({ url, method: 'GET', throw: false });
  return { status: response.status, json: response.json };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Registry request timed out')), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Fetch the latest published version of an npm package, or null when the
 * registry is unreachable or the package is unknown. Never throws.
 */
export async function fetchLatestCLIVersion(
  packageName: string,
  options: { fetcher?: CLIRegistryFetcher; timeoutMs?: number } = {},
): Promise<string | null> {
  const fetcher = options.fetcher ?? defaultRegistryFetcher;
  const timeoutMs = options.timeoutMs ?? 10_000;
  try {
    const response = await withTimeout(
      fetcher(`https://registry.npmjs.org/${packageName}/latest`),
      timeoutMs,
    );
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    const data = response.json;
    if (typeof data !== 'object' || data === null || !('version' in data)) {
      return null;
    }
    const version = (data as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}
