import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { rateLimitMiddleware } from './rate-limit.js';
import type { Env } from '../index.js';

function app() {
  const a = new Hono<Env>();
  a.use('*', rateLimitMiddleware);
  a.get('/api/protected', (c) => c.json({ success: true }));
  a.post('/formaloo/instant/:formId/:secret', (c) => c.json({ success: true }));
  a.get('/formaloo/choices/:formId/:listId', (c) => c.json([]));
  a.post('/integrations/google-sheets/friend-ledger/webhook', (c) => c.json({ success: true }));
  a.get('/api/postal-lookup', (c) => c.json({ pref: '大阪府', city: '高槻市', town: '' }));
  a.post('/api/forms/:id/submit', (c) => c.json({ success: true }));
  return a;
}

const env = {} as Env['Bindings'];

describe('rate-limit IP ceiling (pre-auth token rotation)', () => {
  test('rotating unvalidated session cookies from one IP cannot bypass the limiter', async () => {
    // A unique IP isolates this test from the module-level store. Each request
    // uses a DIFFERENT bogus cookie, so the per-token bucket never trips — only
    // the per-IP ceiling (3000) should eventually return 429.
    const ip = '203.0.113.77';
    const a = app();
    let saw429 = false;

    for (let i = 0; i < 3001; i++) {
      const res = await a.request('/api/protected', {
        headers: {
          'cf-connecting-ip': ip,
          Cookie: `lh_admin_session=bogus-${i}`,
        },
      }, env);
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }

    expect(saw429).toBe(true);
  });

  test('a single legitimate token keeps its full allowance from one IP', async () => {
    const ip = '198.51.100.42';
    const a = app();
    // Well under both AUTHENTICATED_MAX and the IP ceiling.
    for (let i = 0; i < 50; i++) {
      const res = await a.request('/api/protected', {
        headers: { 'cf-connecting-ip': ip, Cookie: 'lh_admin_session=stable-token' },
      }, env);
      expect(res.status).toBe(200);
    }
  });
});

describe('Formaloo instant webhook は常に unauthenticated IP bucket', () => {
  test('bogus Bearer を毎回変えても 101 件目を 429 にする', async () => {
    const ip = '192.0.2.106';
    const a = app();
    let lastStatus = 0;
    for (let i = 0; i < 101; i++) {
      const res = await a.request('/formaloo/instant/fa_safe/path-secret', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': ip,
          Authorization: `Bearer rotating-bogus-${i}`,
        },
      }, env);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe('Formaloo dynamic choices は常に unauthenticated IP bucket', () => {
  test('bogus Bearer を毎回変えても 101 件目を 429 にする', async () => {
    const ip = '192.0.2.108';
    const a = app();
    let lastStatus = 0;
    for (let i = 0; i < 101; i++) {
      const res = await a.request('/formaloo/choices/form_a/list_a', {
        headers: {
          'cf-connecting-ip': ip,
          Authorization: `Bearer rotating-choice-bogus-${i}`,
        },
      }, env);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe('friend ledger webhook は常に unauthenticated IP bucket', () => {
  test('bogus Bearer を毎回変えても 101 件目を 429 にする', async () => {
    const ip = '192.0.2.119';
    const a = app();
    let lastStatus = 0;
    for (let i = 0; i < 101; i++) {
      const res = await a.request('/integrations/google-sheets/friend-ledger/webhook', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': ip,
          Authorization: `Bearer rotating-sheets-bogus-${i}`,
        },
      }, env);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe('postal lookup は常に unauthenticated IP bucket', () => {
  test('bogus Bearer を毎回変えても 101 件目を 429 にする', async () => {
    const ip = '192.0.2.109';
    const a = app();
    let lastStatus = 0;
    for (let i = 0; i < 101; i++) {
      const res = await a.request('/api/postal-lookup?zip=5690000', {
        headers: {
          'cf-connecting-ip': ip,
          Authorization: `Bearer rotating-postal-bogus-${i}`,
        },
      }, env);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  test('postal lookup の連打が同じ IP の既存 form submit 枠を消費しない', async () => {
    const ip = '192.0.2.110';
    const a = app();

    for (let i = 0; i < 100; i++) {
      const res = await a.request('/api/postal-lookup?zip=5690000', {
        headers: { 'cf-connecting-ip': ip },
      }, env);
      expect(res.status).toBe(200);
    }

    const formSubmit = await a.request('/api/forms/form-a/submit', {
      method: 'POST',
      headers: { 'cf-connecting-ip': ip },
    }, env);

    expect(formSubmit.status).toBe(200);
  });
});
