/**
 * B-5 (D-1/D-2/D-3) — dark-ship 不可侵 + 送信ゼロ + 秘密非露出の回帰ガード (source 走査)。
 *  - D-1: wrangler crons=[] / FAQ_BOT_ENABLED="false" byte-identical・[ai]/[[vectorize]] binding 未追記・
 *         webhook.ts の faq gate (faqBotEnabled === 'true') が残る。
 *  - D-2: 送信 RAG コア (faq-match/faq-fts/faq-ai/faq-reply) を新 route が import しない。
 *  - D-3: AI 草案 serialize が friend_id/evidence/account_id を露出しない (allowlist)。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(__dirname, '../..');
const readSrc = (p: string) => readFileSync(join(WORKER_ROOT, p), 'utf8');
// コメント除去後の実行コード (説明文の語を誤検知しない)。
const readCode = (p: string) =>
  readSrc(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('D-1 — dark-ship 不可侵 (wrangler / webhook gate byte-identical)', () => {
  const wrangler = readSrc('wrangler.ks.toml');
  test('crons=[] と FAQ_BOT_ENABLED="false" が行内容で残る', () => {
    expect(wrangler.split('\n').filter((l) => l === 'crons = []').length).toBe(1);
    expect(wrangler.split('\n').filter((l) => l === 'FAQ_BOT_ENABLED = "false"').length).toBe(1);
  });
  test('[ai] / [[vectorize]] binding は追記されていない (手順書のみ)', () => {
    expect(wrangler).not.toMatch(/^\[ai\]/m);
    expect(wrangler).not.toMatch(/^\[\[vectorize\]\]/m);
  });
  test('webhook.ts の faq gate (faqBotEnabled === \'true\') が残る', () => {
    expect(readCode('src/routes/webhook.ts')).toMatch(/faqBotEnabled\s*===\s*'true'/);
  });
});

describe('D-2 — 送信 RAG コアを新 route が触らない', () => {
  test('routes/knowledge.ts が faq-match/faq-fts/faq-ai/faq-reply を import しない', () => {
    const code = readCode('src/routes/knowledge.ts');
    expect(code).not.toMatch(/faq-match|faq-fts|faq-ai|faq-reply/);
  });
});

describe('D-3 — 秘密/内部識別子の非露出 (serialize allowlist)', () => {
  const code = readCode('src/routes/knowledge.ts');
  test('AI 草案 serialize が friend_id / evidence / account_id を露出しない', () => {
    // serializeDraft の返却キーに含めない (D-3・B5-6)。
    const draftFn = code.slice(code.indexOf('function serializeDraft'), code.indexOf('function serializeDraft') + 400);
    expect(draftFn).not.toMatch(/friend_id|friendId/);
    expect(draftFn).not.toMatch(/evidence/);
    expect(draftFn).not.toMatch(/line_account_id|lineAccountId/);
  });
  test('ai-usage/ai-drafts/reingest/backfill 経路に送信呼出が無い (送信ゼロ)', () => {
    expect(code).not.toMatch(/replyMessage|pushMessage|multicast|lineClient|sendMessage/);
  });
});
