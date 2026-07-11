/**
 * D-1 / D-2 / D-3 (Phase B B-2) — 不可侵 assert (機械検証)。
 *  D-1: faq-match.ts byte-identical + faq-fts が normalize/ngrams を import 再利用 (自前再実装なし) +
 *       packages/db が apps/worker を import しない (依存方向)。
 *  D-2: wrangler 現在形不変 (crons 正定義2本 (2026-07-11 解禁) / FAQ_BOT_ENABLED スイッチ="true" go-live 承認 /
 *       binding 意図形) + webhook gate + faq-ai.ts の retrievalFloor と escalate/grounding/LLM 層を保持。
 *  D-3: bootstrap --check clean + T-B4 backup doc + serializeFaq API 非露出 (routes/faqs.test.ts で assert)。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '../../../..'); // services → src → worker → apps → repo root

function unchangedVsMain(repoRelPath: string): boolean {
  try {
    execFileSync('git', ['diff', '--quiet', 'origin/main', '--', repoRelPath], { cwd: REPO, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
const readRepo = (p: string) => readFileSync(join(REPO, p), 'utf8');

describe('D-1 — faq-match 無変更 + normalize/ngrams 再利用 + 依存方向', () => {
  test('faq-match.ts が origin/main と byte-identical (Dice/normalize/ngrams 資産の再利用)', () => {
    expect(unchangedVsMain('apps/worker/src/services/faq-match.ts')).toBe(true);
  });

  test('faq-fts.ts は faq-match の normalize/ngrams を import 再利用し自前再実装しない', () => {
    const src = readRepo('apps/worker/src/services/faq-fts.ts');
    expect(src).toMatch(/import\s*\{[^}]*normalize[^}]*ngrams[^}]*\}\s*from\s*'\.\/faq-match\.js'/);
    // normalize の内部実装マーカー (NFKC / charCodeAt) が faq-fts に無い = 再実装していない。
    expect(src).not.toMatch(/NFKC|charCodeAt/);
  });

  test('packages/db は apps/worker / services/faq-* を import しない (db→worker 逆流禁止)', () => {
    const dir = join(REPO, 'packages/db/src');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const line of src.split('\n')) {
        if (/^\s*import\b.*\bfrom\b/.test(line) && /apps\/worker|@line-crm\/worker|services\/faq-/.test(line)) {
          offenders.push(`${f}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('D-2 — dark-ship gate + 検索スコア下限 + escalate/grounding/LLM 層 保持', () => {
  // 【2026-07-11 rebaseline】go-live で FAQ_BOT_ENABLED="true"・[ai]/[[vectorize]] binding 実在。旧 assert は
  // 「FAQ_BOT_ENABLED="false" 存在」+ origin/main 比較 (時限式) で go-live 後恒久 RED 化していた。守っていた実体
  // (crons 正定義2本 (2026-07-11 解禁)・全体スイッチが黙って変わらない・binding 構成不変) を現ソースの現在形で保護し直す (時限式排除)。
  test('wrangler 現在形: crons 正定義2本 exact / FAQ_BOT_ENABLED スイッチ="true"(承認) / binding 意図形', () => {
    const lines = readRepo('apps/worker/wrangler.ks.toml').split('\n');
    // 2026-07-11 crons 解禁 (case line-crons-enable): crons=[] → 正定義2本。5min tick=配信/リマインダー/stuck 復旧/token refresh、6h tick=booking/event expirer (index.ts:708,736 の event.cron === '0 */6 * * *' と exact 一致)。config と同一 diff で更新し解禁直後の恒久 RED を防止。
    expect(lines.filter((l) => l === 'crons = ["*/5 * * * *", "0 */6 * * *"]')).toHaveLength(1); // 正 cron 2 本 exact (重複/追加なし)
    expect(lines.filter((l) => /^FAQ_BOT_ENABLED = "(?:true|false)"$/.test(l))).toEqual(['FAQ_BOT_ENABLED = "true"']);
    expect(lines.filter((l) => l === 'FAQ_BOT_ENABLED = "false"')).toHaveLength(0); // dark-ship 代入行の残骸なし
    expect(lines.filter((l) => l === '[ai]')).toHaveLength(1);
    expect(lines.filter((l) => l === 'binding = "AI"')).toHaveLength(1);
    expect(lines.filter((l) => l === '[[vectorize]]')).toHaveLength(1);
    expect(lines.filter((l) => l === 'index_name = "ks-knowledge-chunks"')).toHaveLength(1);
  });

  test('webhook faq gate 行が byte-identical (FTS 差替は faq-reply/faq-fts 内のみ)', () => {
    expect(readRepo('apps/worker/src/routes/webhook.ts')).toContain("if (!matched && faqBotEnabled === 'true') {");
    expect(unchangedVsMain('apps/worker/src/routes/webhook.ts')).toBe(true);
  });

  test('faq-ai.ts の faq Dice floor (retrievalFloor 尺度) が不変 (B-4 で chunk 結線しても faq 側 floor は緩和しない)', () => {
    // B-4 (chunks live 結線) が faq-ai.ts を意図的に改修するため byte-identical は解除 (地雷 B4-7)。
    // faq の Dice floor 判定 (topScore と retrievalFloor 比較) が撤廃/緩和されていないことを確認する。
    const src = readRepo('apps/worker/src/services/faq-ai.ts');
    expect(src).toContain('detail.topScore >= ai.retrievalFloor');
  });

  test('runtime.ts の retrievalFloor default (0.3) が不変 (faq floor 緩和なし・B-4 は additive)', () => {
    // B-4 は runtime.ts に vectorize/embed 設定を additive 追加するため byte-identical は解除。faq floor は不変。
    expect(readRepo('apps/worker/src/services/llm/runtime.ts')).toContain('DEFAULT_RETRIEVAL_FLOOR = 0.3');
  });
});

describe('D-3 — bootstrap sync + backup doc', () => {
  test('generate-bootstrap --check が clean (schema/migrations と bootstrap.sql が同期)', () => {
    expect(() =>
      execFileSync('node', [join(REPO, 'packages/db/scripts/generate-bootstrap.mjs'), '--check'], {
        cwd: join(REPO, 'packages/db'),
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  test('T-B4: FTS5 backup 手順 doc (仮想表 export 非対応・base 表のみ・再構築可能な派生物) が存在', () => {
    const doc = readRepo('docs/wiki/22-Operations.md');
    expect(doc).toContain('wrangler d1 export');
    expect(doc).toMatch(/仮想表.*export|export.*仮想表/);
    expect(doc).toContain('再構築可能な派生物');
    expect(doc).toContain('backfillFaqsSearchText');
  });
});
