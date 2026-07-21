import { describe, expect, test } from 'vitest';
import { app, type Env } from './index.js';

describe('form render backend request fencing CORS', () => {
  test('allows the provider snapshot header on credentialed admin preflight', async () => {
    const origin = 'https://line-crm-admin.pages.dev';
    const response = await app.request('/api/forms-advanced/fa1', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type,x-form-render-backend',
      },
    }, {
      ADMIN_ORIGIN: origin,
      ADMIN_ALLOW_CROSS_SITE: 'true',
    } as Env['Bindings']);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase())
      .toContain('x-form-render-backend');
  });
});
