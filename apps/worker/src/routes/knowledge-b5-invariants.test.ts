/**
 * B-5 (D-1/D-2/D-3) — dark-ship 不可侵 + 送信ゼロ + 秘密非露出の回帰ガード (source 走査)。
 *  - D-1: wrangler 現在形不変 (crons 正定義2本 (2026-07-11 owner 解禁)・FAQ_BOT_ENABLED スイッチ="true" go-live 承認・
 *         [ai]/[[vectorize]] binding は意図した現在形)・webhook.ts の faq gate (faqBotEnabled === 'true') が残る。
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

// 【2026-07-11 rebaseline / dark-ship 番兵 → live-config 恒久 invariant】
// go-live (owner 立会 2026-07-11) で本番 config が正式変更: FAQ_BOT_ENABLED="true"・[ai]/[[vectorize]]
// binding 実在。旧 assert は Phase B dark-ship 時代の「false のはず/binding 無いはず」を固定しており
// go-live 後は恒久 RED 化して実回帰を隠していた。守っていた実体を現在形で保護し直す (対応表):
//   旧「FAQ_BOT_ENABLED="false" が1件」→ 実体=全体スイッチが意図せず書き換わらない・crons が閉じたまま
//     → 新「crons 正定義2本 exact 1件 + FAQ_BOT_ENABLED スイッチ正確に1件・値="true"(owner承認) + "false" 代入行残骸0件」
//   旧「[ai]/[[vectorize]] 未追記」→ 実体=binding 構成が意図した形から黙って変わらない
//     → 新「[ai] binding="AI" 1件・[[vectorize]] 1件・index_name="ks-knowledge-chunks" 1件」
describe('D-1 — dark-ship gate 現在形不変 (wrangler live-config / webhook gate)', () => {
  const wrangler = readSrc('wrangler.ks.toml');
  const lines = wrangler.split('\n');
  test('crons 正定義2本 exact + FAQ_BOT_ENABLED スイッチ正確に1件・値="true"(owner立会承認)・"false" 残骸0件', () => {
    // 2026-07-11 crons 解禁 (case line-crons-enable): crons=[] → 正定義2本。5min tick=配信/リマインダー/stuck 復旧/token refresh、6h tick=booking/event expirer (index.ts:708,736 の event.cron === '0 */6 * * *' と exact 一致)。config と同一 diff で更新し解禁直後の恒久 RED を防止。
    expect(lines.filter((l) => l === 'crons = ["*/5 * * * *", "0 */6 * * *"]')).toHaveLength(1); // 正 cron 2 本 exact (重複/追加なし)
    expect(lines.filter((l) => /^FAQ_BOT_ENABLED = "(?:true|false)"$/.test(l))).toEqual(['FAQ_BOT_ENABLED = "true"']);
    expect(lines.filter((l) => l === 'FAQ_BOT_ENABLED = "false"')).toHaveLength(0); // dark-ship 代入行が誤って書き戻されていない
  });
  test('[ai]/[[vectorize]] binding は意図した現在形 (binding 構成が黙って変わらない)', () => {
    expect(lines.filter((l) => l === '[ai]')).toHaveLength(1);
    expect(lines.filter((l) => l === 'binding = "AI"')).toHaveLength(1);
    expect(lines.filter((l) => l === '[[vectorize]]')).toHaveLength(1);
    expect(lines.filter((l) => l === 'binding = "VECTORIZE"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'index_name = "ks-knowledge-chunks"')).toHaveLength(1);
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
