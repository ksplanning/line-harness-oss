/**
 * D-1 / D-2 / D-3 / D-4 (Phase B B-3) — 不可侵 assert (機械検証)。
 *  D-1: matcher/retrieval byte-identical + faq-reply の送信 verb 制約 + chunks を live RAG に非結線 +
 *       normalize/ngrams・buildQuerySearchText 再利用 (自前再実装なし) + packages/db→apps/worker 逆流禁止。
 *  D-2: wrangler 現在形不変 (crons 正定義2本 (2026-07-11 解禁) / FAQ_BOT_ENABLED スイッチ="true" go-live 承認 /
 *       SSRF backstop / binding 意図形) + webhook gate + 既存 outbound fetch ファイル無改変 (dark-ship)。
 *  D-3: bootstrap --check clean + 092=091+1(最高) + check-migrations pass + backup doc を knowledge_* 拡張。
 *  D-4: route が accountScopeReject / POST 認証スコープ / db helper が account 同値コピーを実装 (source 検証)。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
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

describe('D-1 (B-4 再編) — matcher/retrieval byte-identical + orchestrator 非結線 + chunk は runFaqAiAnswer 内で結線', () => {
  // ⚠️ B-4 は faq-ai.ts / runtime.ts を意図的に改修する (chunks live 結線が目的 / 地雷 B4-7)。回帰 assert は
  //    faq-match / faq-fts byte-identical + faq-reply の送信 verb 制約 + 送信安全 (gate/crons/FAQ_BOT_ENABLED) に
  //    組み替える (spec §7)。faq-reply は answerMode 対応で意図的に変更されるため、時限式の main 比較から外す。
  test.each([
    'apps/worker/src/services/faq-fts.ts',
    'apps/worker/src/services/faq-match.ts',
  ])('%s が origin/main と byte-identical', (p) => {
    expect(unchangedVsMain(p)).toBe(true);
  });

  test('orchestrator (faq-reply.ts) は chunk を直接 import せず push/multicast を持たない', () => {
    const src = readRepo('apps/worker/src/services/faq-reply.ts');
    expect(src).not.toContain('knowledge.js');
    expect(src).not.toContain('retrieveChunkEvidence');
    expect(src).not.toContain('buildChunkEvidenceBlock');
    // 新たな送信 verb を足していない (chunk 結線後も送信面は runFaqAiAnswer の outcome 経由のみ)。
    expect(src).not.toMatch(/pushMessage|multicast/);
  });

  test('chunk は runFaqAiAnswer 内で live 結線 (faq-ai.ts が retrieveChunkEvidence + nonce fence を使う / B-4)', () => {
    const src = readRepo('apps/worker/src/services/faq-ai.ts');
    expect(src).toMatch(/from ['"]\.\/knowledge\.js['"]/);
    expect(src).toContain('retrieveChunkEvidence');
    expect(src).toContain('buildChunkEvidenceBlock'); // chunk は必ず nonce fence で囲う (instruction/data 分離)
  });

  test('knowledge worker helper が normalize/ngrams と buildQuerySearchText を import 再利用 (自前再実装なし)', () => {
    const src = readRepo('apps/worker/src/services/knowledge.ts');
    expect(src).toMatch(/import\s*\{[^}]*normalize[^}]*ngrams[^}]*\}\s*from\s*'\.\/faq-match\.js'/);
    expect(src).toMatch(/import\s*\{[^}]*buildQuerySearchText[^}]*\}\s*from\s*'\.\/faq-fts\.js'/);
    expect(src).not.toMatch(/NFKC|charCodeAt/); // normalize の内部実装マーカーなし = 再実装していない
  });

  test('packages/db/src/knowledge.ts が apps/worker / services を import しない (逆流禁止)', () => {
    const src = readRepo('packages/db/src/knowledge.ts');
    for (const line of src.split('\n')) {
      if (/^\s*import\b.*\bfrom\b/.test(line)) {
        expect(line).not.toMatch(/apps\/worker|@line-crm\/worker|services\//);
      }
    }
  });
});

describe('D-2 — dark-ship gate byte-identical + compat flag additive + 既存 fetch 無改変', () => {
  // 【2026-07-11 rebaseline】go-live で FAQ_BOT_ENABLED="true"・[ai]/[[vectorize]] 結線。旧 assert は "false" 固定
  // + origin/main 比較 (時限式) で go-live 後恒久 RED 化していた。守っていた実体 (crons 正定義2本 (2026-07-11 解禁)・スイッチが黙って変わ
  // らない・SSRF backstop 存在・binding 意図形) を現ソースの現在形で保護し直す (時限式排除)。
  test('wrangler 現在形: crons 正定義2本 exact / FAQ_BOT_ENABLED="true"(承認) / SSRF backstop / binding 意図形', () => {
    const toml = readRepo('apps/worker/wrangler.ks.toml');
    const lines = toml.split('\n');
    // 2026-07-11 crons 解禁 (case line-crons-enable): crons=[] → 正定義2本。5min tick=配信/リマインダー/stuck 復旧/token refresh、6h tick=booking/event expirer (index.ts:708,736 の event.cron === '0 */6 * * *' と exact 一致)。config と同一 diff で更新し解禁直後の恒久 RED を防止。
    expect(lines.filter((l) => l === 'crons = ["*/5 * * * *", "0 */6 * * *"]')).toHaveLength(1); // 正 cron 2 本 exact (重複/追加なし)
    expect(lines.filter((l) => /^FAQ_BOT_ENABLED = "(?:true|false)"$/.test(l))).toEqual(['FAQ_BOT_ENABLED = "true"']);
    expect(lines.filter((l) => l === 'FAQ_BOT_ENABLED = "false"')).toHaveLength(0); // dark-ship 代入行の残骸なし
    expect(toml).toContain('global_fetch_strictly_public'); // SSRF backstop 存在 (現在形・追記済)
    expect(lines.filter((l) => l === '[ai]')).toHaveLength(1);
    expect(lines.filter((l) => l === 'binding = "VECTORIZE"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'index_name = "ks-knowledge-chunks"')).toHaveLength(1);
  });

  test('webhook faq gate 行が byte-identical', () => {
    expect(readRepo('apps/worker/src/routes/webhook.ts')).toContain("if (!matched && faqBotEnabled === 'true') {");
    expect(unchangedVsMain('apps/worker/src/routes/webhook.ts')).toBe(true);
  });

  test('既存 outbound fetch ファイルが flag 追記で無改変 (全て公開 API 宛)', () => {
    for (const f of [
      'apps/worker/src/services/google-calendar.ts',
      'apps/worker/src/services/token-refresh.ts',
    ]) {
      if (existsSync(join(REPO, f))) expect(unchangedVsMain(f)).toBe(true);
    }
  });

  test('ingest/list/delete 経路に LINE 送信呼出なし (実行コード / dark-ship)', () => {
    const code = (p: string) =>
      readRepo(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const f of ['apps/worker/src/routes/knowledge.ts', 'apps/worker/src/services/knowledge.ts', 'apps/worker/src/lib/ssrf-guard.ts']) {
      expect(code(f)).not.toMatch(/replyMessage|pushMessage|multicast|lineClient|sendMessage/);
    }
  });
});

describe('D-3 — bootstrap sync + migration 092 + backup doc 拡張', () => {
  test('generate-bootstrap --check が clean (schema/migrations と bootstrap.sql 同期・shadow 除外汎用)', () => {
    expect(() =>
      execFileSync('node', [join(REPO, 'packages/db/scripts/generate-bootstrap.mjs'), '--check'], {
        cwd: join(REPO, 'packages/db'),
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  test('bootstrap.sql / schema.sql に knowledge_* base 表 + fts + トリガが含まれ、shadow 表は含まれない', () => {
    // bootstrap.sql は generate-bootstrap が IF NOT EXISTS を除去した bare CREATE、schema.sql は IF NOT EXISTS。
    for (const f of ['packages/db/bootstrap.sql', 'packages/db/schema.sql']) {
      const sql = readRepo(f);
      expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?knowledge_documents/);
      expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?knowledge_chunks\b/);
      expect(sql).toMatch(/CREATE VIRTUAL TABLE (IF NOT EXISTS )?knowledge_chunks_fts/);
      expect(sql).toMatch(/knowledge_chunks_fts_ai/);
      // shadow 表 (_data/_idx/...) を明示 CREATE していない (汎用除外)。
      expect(sql).not.toMatch(/CREATE TABLE.*knowledge_chunks_fts_(data|idx|docsize|config|content)/);
    }
  });

  test('backup doc (22-Operations.md) が knowledge_* base 表 + 再構築派生物 + backfill + 復元順を記載', () => {
    const doc = readRepo('docs/wiki/22-Operations.md');
    expect(doc).toContain('knowledge_documents');
    expect(doc).toContain('knowledge_chunks');
    expect(doc).toContain('backfillChunkSearchText');
    expect(doc).toMatch(/再構築可能な派生物/);
    expect(doc).toMatch(/base 適用 → 092 → backfill|復元順/);
  });
});

describe('D-4 — account スコープ実装 (source 検証・機械 assert は knowledge.test.ts / route test)', () => {
  test('route が POST 認証スコープ (accountId 必須 403) と accountScopeReject を実装', () => {
    const src = readRepo('apps/worker/src/routes/knowledge.ts');
    expect(src).toContain('accountScopeReject');
    expect(src).toMatch(/if \(!accountId\) return c\.json\([^)]*403\)/); // global 非露出
  });
  test('db helper insertKnowledgeChunks が chunk に親 account を同値コピー (引数 lineAccountId を bind)', () => {
    const src = readRepo('packages/db/src/knowledge.ts');
    expect(src).toMatch(/insertKnowledgeChunks/);
    // batch INSERT の bind に lineAccountId (親 document の account) が渡る。
    expect(src).toMatch(/\.bind\(crypto\.randomUUID\(\), sourceDocId, lineAccountId,/);
  });
});
