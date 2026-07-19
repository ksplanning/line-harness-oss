import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { mapPathToFeature } from '../middleware/permission-map.js';
import { app } from '../index.js';

describe('Formaloo AI chat route mount', () => {
  test('mounts the isolated route without changing existing Formaloo route files', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/import \{ formalooAiChat \} from '\.\/routes\/formaloo-ai-chat\.js';/);
    expect(source).toContain("app.route('/', formalooAiChat);");
  });

  test('places both AI chat endpoints behind the forms_advanced permission', () => {
    expect(mapPathToFeature('/api/forms-advanced/ai-chat/analyze')).toBe('forms_advanced');
    expect(mapPathToFeature('/api/forms-advanced/ai-chat/history')).toBe('forms_advanced');
  });

  test('rejects an unauthenticated credit-consuming request before route work starts', async () => {
    const res = await app.request('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formId: 'fa_1', lineAccountId: 'line-a', prompt: '分析して' }),
    }, {
      DB: {} as D1Database,
      FORMALOO_AI_CHAT_ENABLED: 'true',
    } as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ success: false, error: 'Unauthorized' });
  });
});
