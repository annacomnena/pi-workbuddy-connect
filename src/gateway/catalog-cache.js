// The model catalog view the gateway serves.
//
// `/v1/models` must answer quickly and must not spend an upstream request on
// every client poll, so the catalog is cached for a TTL. A stale cache is
// refreshed with one live request, and the live -> saved -> built-in
// degradation chain (catalog/index.js) stays in charge of what happens when
// that request fails. The active rung is always reported.

import { resolveCatalog, saveCatalog } from '../catalog/index.js';

export const DEFAULT_CATALOG_TTL_MS = 10 * 60_000;

/**
 * @param {{ store: object, session: object, client: object, savedPath: string,
 *   appVersion?: string, ttlMs?: number, now?: () => number, logger?: object }} options
 */
export function createCatalogSource({
  session,
  client,
  savedPath,
  appVersion,
  ttlMs = DEFAULT_CATALOG_TTL_MS,
  now = Date.now,
  logger,
}) {
  let cache;

  return {
    /** The current catalog, refreshing live when the cache is cold or forced. */
    async current({ refresh = false } = {}) {
      const at = now();
      if (!refresh && cache !== undefined && at - cache.at < ttlMs) return cache.catalog;
      let credential;
      try {
        const effective = await session.resolve();
        credential = effective.credential;
      } catch (error) {
        logger?.warn?.(`catalog: no usable credential (${error?.code ?? 'error'}); falling back to the saved or built-in list`);
        credential = undefined;
      }
      const catalog = await resolveCatalog({
        client: credential === undefined ? undefined : client,
        credential,
        savedPath,
        network: credential !== undefined,
        fresh: credential !== undefined,
        ...(appVersion === undefined ? {} : { appVersion }),
      });
      if (catalog.source === 'live' && savedPath !== undefined) {
        try {
          saveCatalog(savedPath, catalog);
        } catch {
          /* a cache write must never fail the read */
        }
      }
      cache = { at, catalog };
      return catalog;
    },
    /**
     * The catalog without any upstream contact: the cached one when warm, else
     * the saved/built-in rungs only. `/healthz` uses this so a probe can never
     * spend an upstream request.
     */
    async snapshot() {
      if (cache !== undefined) return cache.catalog;
      return resolveCatalog({ client: undefined, credential: undefined, savedPath, network: false });
    },
    /** Drop the cache (used by tests and by an explicit refresh). */
    invalidate() {
      cache = undefined;
    },
  };
}
