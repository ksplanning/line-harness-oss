import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  createPostalLookupService,
  PostalLookupAmbiguousError,
  PostalLookupInputError,
  PostalLookupUpstreamError,
  type PostalAddress,
} from '../services/postal-lookup.js';

type PostalLookup = (zip: string) => Promise<PostalAddress | null>;

export function createPostalLookupRoutes(lookup: PostalLookup) {
  const routes = new Hono<Env>();
  routes.get('/api/postal-lookup', async (c) => {
    try {
      const address = await lookup(c.req.query('zip') ?? '');
      if (!address) {
        return c.json(
          { error: 'Postal code not found' },
          { status: 404, headers: { 'Cache-Control': 'public, max-age=300' } },
        );
      }
      c.header('Cache-Control', 'public, max-age=3600');
      return c.json(address);
    } catch (error) {
      if (error instanceof PostalLookupInputError) {
        return c.json(
          { error: 'Invalid postal code' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      if (error instanceof PostalLookupAmbiguousError) {
        return c.json(
          { error: 'Postal code has multiple address candidates' },
          { status: 409, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      if (error instanceof PostalLookupUpstreamError) {
        return c.json(
          { error: 'Postal lookup temporarily unavailable' },
          {
            status: 503,
            headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
          },
        );
      }
      throw error;
    }
  });
  return routes;
}

export const postalLookup = createPostalLookupRoutes(createPostalLookupService());
