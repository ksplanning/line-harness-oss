/**
 * admin-ui-cleanup D-1 — legacy forms の利用実態を deployment-local D1 で判定する。
 * ks / piecemaker の両デプロイで同じ集計を行い、forms と submissions が共に 0 のときだけ
 * sidebar が旧「フォーム回答」を隠せるよう、2 件数を API 契約として返す。
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { forms } from './forms.js';
import type { Env } from '../index.js';

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let DB: D1Database;

function app() {
  const instance = new Hono<Env>();
  instance.route('/', forms);
  return instance;
}

async function usage() {
  return app().request('/api/forms/legacy/usage', {}, { DB } as Env['Bindings']);
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE forms (id TEXT PRIMARY KEY);
    CREATE TABLE form_submissions (id TEXT PRIMARY KEY, form_id TEXT NOT NULL);
  `);
  DB = d1(raw);
});

describe('GET /api/forms/legacy/usage', () => {
  test('forms=0 / submissions=0 を明示して、未使用テナントを判定できる', async () => {
    const response = await usage();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { formCount: 0, submissionCount: 0 },
    });
  });

  test('legacy form が 1 件でもあれば件数を返す', async () => {
    raw.prepare('INSERT INTO forms (id) VALUES (?)').run('legacy-form');

    const response = await usage();
    expect(await response.json()).toMatchObject({
      success: true,
      data: { formCount: 1, submissionCount: 0 },
    });
  });

  test('submission だけが残る不整合時も件数を返し、sidebar を消さない判断材料にする', async () => {
    raw.prepare('INSERT INTO form_submissions (id, form_id) VALUES (?, ?)').run('submission-1', 'missing-form');

    const response = await usage();
    expect(await response.json()).toMatchObject({
      success: true,
      data: { formCount: 0, submissionCount: 1 },
    });
  });
});
