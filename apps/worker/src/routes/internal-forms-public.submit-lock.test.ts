// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { internalFormsPublic } from './internal-forms-public.js';
import type { Env } from '../index.js';

const form = {
  id: 'fa_submit_lock',
  title: '申込フォーム',
  description: null,
  definition_json: JSON.stringify({
    fields: [
      { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
    ],
    logic: [],
  }),
  deleted: 0,
  render_backend: 'internal',
  builder_status: 'published',
  submit_message: null,
  line_account_id: null,
};

function db(): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async first<T>() {
          if (sql === 'SELECT * FROM formaloo_forms WHERE id = ?') {
            return (params[0] === form.id ? form : null) as T | null;
          }
          if (sql.includes('COUNT(*) AS n FROM internal_form_submissions')) {
            return { n: 0 } as T;
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function app(): Hono<Env> {
  const hono = new Hono<Env>();
  hono.route('/', internalFormsPublic);
  return hono;
}

describe('internal public form submit lock', () => {
  test('locks synchronously, turns gray, and rejects a second native submit', async () => {
    const response = await app().request(`/f/${form.id}`, {}, {
      DB: db(),
      FORMALOO_FRIEND_TOKEN_SECRET: 'test-secret',
    } as Env['Bindings']);
    const html = await response.text();
    const page = new DOMParser().parseFromString(html, 'text/html');
    const lockClient = page.querySelector<HTMLScriptElement>(
      'script[data-internal-form-submit-lock]',
    );

    expect(response.status).toBe(200);
    expect(lockClient).not.toBeNull();
    expect(html).toMatch(/button:disabled\s*\{[^}]*background:\s*#[0-9a-f]{6}/i);
    new Function('document', lockClient?.textContent ?? '')(page);
    const renderedForm = page.querySelector<HTMLFormElement>('form')!;
    const button = renderedForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const first = new Event('submit', { bubbles: true, cancelable: true });
    const second = new Event('submit', { bubbles: true, cancelable: true });

    expect(renderedForm.dispatchEvent(first)).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('送信中...');
    expect(renderedForm.dispatchEvent(second)).toBe(false);
  });
});
