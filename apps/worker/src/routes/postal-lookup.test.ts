import { describe, expect, test, vi } from 'vitest';
import { createPostalLookupRoutes } from './postal-lookup.js';
import {
  PostalLookupAmbiguousError,
  PostalLookupInputError,
  PostalLookupUpstreamError,
} from '../services/postal-lookup.js';
import { app } from '../index.js';

describe('GET /api/postal-lookup', () => {
  test('実在する郵便番号の住所を直接返す', async () => {
    const lookup = vi.fn().mockResolvedValue({
      pref: '大阪府',
      city: '高槻市',
      town: '',
    });
    const app = createPostalLookupRoutes(lookup);

    const response = await app.request('/api/postal-lookup?zip=5690000');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pref: '大阪府',
      city: '高槻市',
      town: '',
    });
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(lookup).toHaveBeenCalledWith('5690000');
  });

  test('形式不正を 400 で返す', async () => {
    const lookup = vi.fn().mockRejectedValue(new PostalLookupInputError());
    const app = createPostalLookupRoutes(lookup);

    const response = await app.request('/api/postal-lookup?zip=569-00a0');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid postal code' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test('存在しない郵便番号を正直に 404 で返す', async () => {
    const app = createPostalLookupRoutes(vi.fn().mockResolvedValue(null));

    const response = await app.request('/api/postal-lookup?zip=0000000');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Postal code not found' });
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  test('複数の住所候補を誤選択せず 409 で返す', async () => {
    const lookup = vi.fn().mockRejectedValue(new PostalLookupAmbiguousError());
    const app = createPostalLookupRoutes(lookup);

    const response = await app.request('/api/postal-lookup?zip=0790177');

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Postal code has multiple address candidates',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test('upstream 障害を再試行可能な 503 で返す', async () => {
    const lookup = vi.fn().mockRejectedValue(new PostalLookupUpstreamError());
    const app = createPostalLookupRoutes(lookup);

    const response = await app.request('/api/postal-lookup?zip=5690000');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Postal lookup temporarily unavailable',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBe('60');
  });
});

describe('postal lookup route mount', () => {
  test('Worker app に GET route が登録されている', () => {
    expect(
      app.routes.some(
        (route) => route.method === 'GET' && route.path === '/api/postal-lookup',
      ),
    ).toBe(true);
  });
});
