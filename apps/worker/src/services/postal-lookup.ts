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
const MAX_CACHE_ENTRIES = 1_000;

function parsePostalCandidate(candidate: unknown, expectedZip: string): PostalAddress {
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('address1' in candidate) ||
    typeof candidate.address1 !== 'string' ||
    !('address2' in candidate) ||
    typeof candidate.address2 !== 'string' ||
    !('address3' in candidate) ||
    typeof candidate.address3 !== 'string' ||
    !('zipcode' in candidate) ||
    candidate.zipcode !== expectedZip
  ) {
    throw new PostalLookupUpstreamError();
  }
  return {
    pref: candidate.address1,
    city: candidate.address2,
    town: candidate.address3,
  };
}

export function createPostalLookupService(options: PostalLookupOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: PostalAddress | null; expiresAt: number }>();

  function setCached(zip: string, value: PostalAddress | null, ttlMs: number): void {
    cache.delete(zip);
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldestZip = cache.keys().next().value;
      if (oldestZip === undefined) break;
      cache.delete(oldestZip);
    }
    cache.set(zip, { value, expiresAt: now() + ttlMs });
  }

  return async (zip: string): Promise<PostalAddress | null> => {
    if (!/^\d{7}$/.test(zip)) throw new PostalLookupInputError();

    const cached = cache.get(zip);
    if (cached && cached.expiresAt > now()) {
      cache.delete(zip);
      cache.set(zip, cached);
      return cached.value;
    }
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
      setCached(zip, null, NOT_FOUND_CACHE_TTL_MS);
      return null;
    }
    if (!Array.isArray(body.results)) throw new PostalLookupUpstreamError();
    if (body.results.length === 0) throw new PostalLookupUpstreamError();

    const address = parsePostalCandidate(body.results[0], zip);
    for (const candidate of body.results.slice(1)) {
      const otherAddress = parsePostalCandidate(candidate, zip);
      if (
        otherAddress.pref !== address.pref ||
        otherAddress.city !== address.city ||
        otherAddress.town !== address.town
      ) {
        throw new PostalLookupAmbiguousError();
      }
    }
    setCached(zip, address, FOUND_CACHE_TTL_MS);
    return address;
  };
}
