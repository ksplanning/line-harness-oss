/**
 * D-1 / D-2 / D-3 (Phase B B-2) — 不可侵 assert (機械検証)。
 *  D-1: faq-match.ts byte-identical + faq-fts が normalize/ngrams を import 再利用 (自前再実装なし) +
 *       packages/db が apps/worker を import しない (依存方向)。
 *  D-2: wrangler flag (FAQ_BOT_ENABLED="false" / crons=[]) + webhook gate + faq-ai.ts + runtime.ts が
 *       byte-identical (検索スコア下限 retrievalFloor と escalate/grounding/LLM 層を保持)。
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
  test('wrangler.ks.toml の crons=[] / FAQ_BOT_ENABLED="false" が byte-identical (dark-ship・infra 変更なし)', () => {
    const toml = readRepo('apps/worker/wrangler.ks.toml');
    expect(toml).toContain('crons = []');
    expect(toml).toContain('FAQ_BOT_ENABLED = "false"');
    expect(unchangedVsMain('apps/worker/wrangler.ks.toml')).toBe(true);
  });

  test('webhook faq gate 行が byte-identical (FTS 差替は faq-reply/faq-fts 内のみ)', () => {
    expect(readRepo('apps/worker/src/routes/webhook.ts')).toContain("if (!matched && faqBotEnabled === 'true') {");
    expect(unchangedVsMain('apps/worker/src/routes/webhook.ts')).toBe(true);
  });

  test('faq-ai.ts (runFaqAiAnswer 本体・floor 判定・escalate reason・grounding) が byte-identical', () => {
    expect(unchangedVsMain('apps/worker/src/services/faq-ai.ts')).toBe(true);
    // 検索スコア下限の判定が保持されている (撤廃/緩和していない)。
    expect(readRepo('apps/worker/src/services/faq-ai.ts')).toContain('detail.topScore < ai.retrievalFloor');
  });

  test('runtime.ts (retrievalFloor default) が byte-identical (floor 緩和なし)', () => {
    expect(unchangedVsMain('apps/worker/src/services/llm/runtime.ts')).toBe(true);
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
