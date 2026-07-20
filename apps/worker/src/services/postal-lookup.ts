export interface PostalAddress {
  pref: string;
  city: string;
  town: string;
}

export class PostalLookupInputError extends Error {
  constructor() {
    super('Postal code must be 7 digits');
    this.name = 'PostalLookupInputError';
  }
}

export class PostalLookupUpstreamError extends Error {
  constructor() {
    super('Postal lookup upstream unavailable');
    this.name = 'PostalLookupUpstreamError';
  }
}

export class PostalLookupAmbiguousError extends Error {
  constructor() {
    super('Postal code has multiple address candidates');
    this.name = 'PostalLookupAmbiguousError';
  }
}

interface PostalLookupOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const ZIPCLOUD_ENDPOINT = 'https://zipcloud.ibsnet.co.jp/api/search';
const POSTAL_LOOKUP_TIMEOUT_MS = 2_000;
const FOUND_CACHE_TTL_MS = 60 * 60 * 1_000;
const NOT_FOUND_CACHE_TTL_MS = 5 * 60 * 1_000;

export function createPostalLookupService(options: PostalLookupOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: PostalAddress | null; expiresAt: number }>();

  return async (zip: string): Promise<PostalAddress | null> => {
    if (!/^\d{7}$/.test(zip)) throw new PostalLookupInputError();

    const cached = cache.get(zip);
    if (cached && cached.expiresAt > now()) return cached.value;
    cache.delete(zip);

    let upstream: Response;
    try {
      upstream = await fetchImpl(
        `${ZIPCLOUD_ENDPOINT}?zipcode=${encodeURIComponent(zip)}`,
        { signal: AbortSignal.timeout(POSTAL_LOOKUP_TIMEOUT_MS) },
      );
    } catch {
      throw new PostalLookupUpstreamError();
    }
    if (!upstream.ok) throw new PostalLookupUpstreamError();

    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch {
      throw new PostalLookupUpstreamError();
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new PostalLookupUpstreamError();
    }

    const body = payload as Record<string, unknown>;
    if (body.status !== 200) throw new PostalLookupUpstreamError();
    if (body.results === null) {
      cache.set(zip, { value: null, expiresAt: now() + NOT_FOUND_CACHE_TTL_MS });
      return null;
    }
    if (!Array.isArray(body.results)) throw new PostalLookupUpstreamError();

    const result = body.results[0] as Record<string, unknown> | undefined;
    if (!result) {
      cache.set(zip, { value: null, expiresAt: now() + NOT_FOUND_CACHE_TTL_MS });
      return null;
    }
    if (
      typeof result.address1 !== 'string' ||
      typeof result.address2 !== 'string' ||
      typeof result.address3 !== 'string'
    ) {
      throw new PostalLookupUpstreamError();
    }
    for (const candidate of body.results.slice(1)) {
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        candidate.address1 !== result.address1 ||
        candidate.address2 !== result.address2 ||
        candidate.address3 !== result.address3
      ) {
        throw new PostalLookupAmbiguousError();
      }
    }
    const address = {
      pref: result.address1,
      city: result.address2,
      town: result.address3,
    };
    cache.set(zip, { value: address, expiresAt: now() + FOUND_CACHE_TTL_MS });
    return address;
  };
}
