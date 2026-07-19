import { describe, expect, test } from 'vitest';
import { app } from '../index.js';

describe('Formaloo recurring submissions route mount', () => {
  const routes = app.routes.map((route) => `${route.method} ${route.path}`);

  test('CRUD/status routes are registered under the existing forms-advanced permission scope', () => {
    expect(routes).toContain('GET /api/forms-advanced/:id/recurring-submissions');
    expect(routes).toContain('POST /api/forms-advanced/:id/recurring-submissions');
    expect(routes).toContain('PUT /api/forms-advanced/:id/recurring-submissions/:slug');
    expect(routes).toContain('PATCH /api/forms-advanced/:id/recurring-submissions/:slug');
    expect(routes).toContain('DELETE /api/forms-advanced/:id/recurring-submissions/:slug');
  });
});
