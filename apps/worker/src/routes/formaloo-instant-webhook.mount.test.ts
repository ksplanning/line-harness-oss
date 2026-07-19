import { describe, expect, test } from 'vitest';
import { app } from '../index.js';

describe('Formaloo instant webhook route mount', () => {
  const routes = app.routes.map((route) => `${route.method} ${route.path}`);

  test('form 設定 API と公開 callback が実 app に登録済み', () => {
    expect(routes).toContain('GET /api/forms-advanced/:id/instant-webhook');
    expect(routes).toContain('PUT /api/forms-advanced/:id/instant-webhook');
    expect(routes).toContain('POST /formaloo/instant/:formId/:secret');
  });
});
