import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createAutoReply,
  getAutoReplyById,
  updateAutoReply,
  type CreateAutoReplyInput,
  type UpdateAutoReplyInput,
} from './auto-replies.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

type ResponseMessage = {
  messageType: string;
  messageContent: string;
  templateId?: string | null;
};

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          params = args;
          return api;
        },
        async first<T>() {
          return (statement.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
        async run() {
          const result = statement.run(...(params as never[]));
          return { meta: { changes: result.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  db = d1(raw);
});

describe('auto-replies response_messages additive persistence', () => {
  test('create and read preserve an ordered three-bubble fixture', async () => {
    const responseMessages: ResponseMessage[] = [
      { messageType: 'text', messageContent: '最初のご案内' },
      { messageType: 'flex', messageContent: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[]}}' },
      { messageType: 'text', messageContent: '最後のご案内' },
    ];
    const input: CreateAutoReplyInput & { responseMessages: ResponseMessage[] } = {
      keyword: '資料',
      responseType: 'text',
      responseContent: '最初のご案内',
      responseMessages,
    };

    const created = await createAutoReply(db, input);
    const loaded = await getAutoReplyById(db, created.id);

    expect(JSON.parse((loaded as unknown as { response_messages: string }).response_messages)).toEqual(responseMessages);
    expect(loaded?.response_type).toBe('text');
    expect(loaded?.response_content).toBe('最初のご案内');
  });

  test('update round-trip accepts the LINE maximum of five bubbles', async () => {
    const created = await createAutoReply(db, {
      keyword: '予約',
      responseType: 'text',
      responseContent: '旧本文',
    });
    const responseMessages: ResponseMessage[] = Array.from({ length: 5 }, (_, index) => ({
      messageType: 'text',
      messageContent: `吹き出し${index + 1}`,
    }));
    const input: UpdateAutoReplyInput & { responseMessages: ResponseMessage[] } = { responseMessages };

    await updateAutoReply(db, created.id, input);
    const loaded = await getAutoReplyById(db, created.id);

    expect(JSON.parse((loaded as unknown as { response_messages: string }).response_messages)).toEqual(responseMessages);
    expect(loaded).toEqual(expect.objectContaining({
      response_type: 'text',
      response_content: '吹き出し1',
      template_id: null,
    }));
  });

  test('a legacy row without response_messages remains readable as an unchanged single response', async () => {
    raw.prepare(
      `INSERT INTO auto_replies
        (id, keyword, match_type, response_type, response_content, template_id, line_account_id, is_active, created_at)
       VALUES ('legacy', '営業時間', 'exact', 'text', '10時からです', NULL, NULL, 1, '2026-07-21T00:00:00+09:00')`,
    ).run();

    const loaded = await getAutoReplyById(db, 'legacy');

    expect((loaded as unknown as { response_messages: string | null }).response_messages).toBeNull();
    expect(loaded).toEqual(expect.objectContaining({
      response_type: 'text',
      response_content: '10時からです',
    }));
  });
});
