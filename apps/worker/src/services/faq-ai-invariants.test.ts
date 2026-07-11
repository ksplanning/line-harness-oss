/**
 * D-1 / D-2 / D-3 (Phase B B-1) — 不可侵 assert (機械検証)。
 *  D-1: unanswered-inbox.ts が origin/main と byte-identical (AI 自動回答は既存 faq_bot 証拠経路)。
 *  D-2: プロンプトに秘密値/friend_id 等内部識別子が載らない (system+根拠+質問のみ)。
 *  D-3: faq-match.ts / webhook gate 行 byte-identical + wrangler 現在形不変
 *       (crons 正定義2本 (2026-07-11 解禁) / FAQ_BOT_ENABLED スイッチ="true" go-live 承認 / binding 意図形)。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildFaqPrompt } from './faq-ai.js';

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

function readRepo(repoRelPath: string): string {
  return readFileSync(join(REPO, repoRelPath), 'utf8');
}

// B-5 (T-E5 / D-1 救済) で unanswered-inbox.ts は source 別証拠窓を導入した = 「ファイル全体 byte-identical」は
// 撤回し、dark-ship 安全の実体である「auto_reply の 5000ms 窓」を不変条件に置き換える。
//
// 【2026-07-11 書き直し / temporal invariant の恒常化】旧 assert は
// `expect(git show origin/main:unanswered-inbox.ts).not.toContain('FAQ_AI_EVIDENCE_WINDOW_MS')` という
// 時限式 (temporal) invariant だった: B-5 が origin/main に merge/push された瞬間に前提が反転し恒常 red 化して
// 自己無効化する (全 suite の回帰信号を濁す)。origin/main との比較を排除し、現ソース (working tree) に対する
// 現在形の不変条件 = 「auto_reply 経路は 5000ms・faq_bot 経路のみ 30s 大窓・両者は source で分岐」に置換した。
describe('D-1 — unanswered-inbox.ts の証拠窓は source 別 (auto_reply=5000ms 不変 / faq_bot=30s は sanctioned な大窓)', () => {
  const cur = readRepo('apps/worker/src/services/unanswered-inbox.ts');
  test('auto_reply の 5000ms 窓定数は現ソースで不変 (自動応答の既存挙動を退行させない = dark-ship 安全の実体)', () => {
    expect(cur).toContain('const AUTO_REPLY_EVIDENCE_WINDOW_MS = 5_000;');
  });
  test('faq_bot 用 30s 大窓 (FAQ_AI_EVIDENCE_WINDOW_MS = 30_000) が sanctioned な追加として現ソースに存在する', () => {
    // B-5 T-E5 で追加した faq_bot 専用の大窓。LLM 生成 + LINE 往復 + log 遅延を吸収する保守値。
    expect(cur).toContain('const FAQ_AI_EVIDENCE_WINDOW_MS = 30_000;');
  });
  test('30s 大窓は faq_bot 経路にのみ適用され auto_reply 経路には適用されない (source === "faq_bot" で分岐)', () => {
    // 証拠窓の選択は source === 'faq_bot' の三項でのみ大窓へ切替わる = auto_reply (非 faq_bot) は 5000ms 固定。
    // これで「auto_reply 監視 (5000ms) が 30s 大窓に紛れて緩む」退行を構造で検知する (dark-ship 安全の維持)。
    expect(cur).toContain("out.source === 'faq_bot' ? FAQ_AI_EVIDENCE_WINDOW_MS : AUTO_REPLY_EVIDENCE_WINDOW_MS");
  });
});

describe('D-2 — プロンプトに秘密値/内部識別子が載らない', () => {
  const evidence = { question: '営業時間は？', answer: '平日は10時から19時までです' };
  const prompt = buildFaqPrompt(evidence, '営業時間を教えて');
  const whole = `${prompt.system}\n${prompt.user}`;

  test('system(上位) + 根拠 + 質問 のみで構成される', () => {
    expect(prompt.user).toContain('根拠:');
    expect(prompt.user).toContain('営業時間は？');
    expect(prompt.user).toContain('平日は10時から19時までです');
    expect(prompt.user).toContain('営業時間を教えて');
  });

  test('friend_id / account_id / token / 秘密値パターンが混入しない', () => {
    const forbidden = [
      'friend', 'friend_id', 'friendId',
      'acc-', 'account_id', 'accountId',
      'Bearer', 'token', 'ACCESS_TOKEN', 'CHANNEL_SECRET', 'secret', 'apiKey', 'API_KEY',
      'U1234', // LINE userId 風
    ];
    for (const bad of forbidden) {
      expect(whole).not.toContain(bad);
    }
  });
});

describe('D-3 — faq-match / webhook gate / flag byte-identical', () => {
  test('faq-match.ts が origin/main と byte-identical (B-2 再利用資産)', () => {
    expect(unchangedVsMain('apps/worker/src/services/faq-match.ts')).toBe(true);
  });

  // 【2026-07-11 rebaseline】go-live で FAQ_BOT_ENABLED="true"・[ai]/[[vectorize]] binding 実在。旧 assert は
  // 「FAQ_BOT_ENABLED="false" 存在」+ origin/main 比較 (時限式) で go-live 後恒久 RED 化していた。守っていた実体
  // (crons 正定義2本 (2026-07-11 解禁)・全体スイッチが黙って変わらない・binding 構成不変) を現ソースの現在形で保護し直す (時限式排除):
  //   旧「crons=[] / FAQ_BOT_ENABLED="false" 存在」→ 新「crons 正定義2本 exact 1件 + スイッチ正確に1件・値="true"(承認) + "false"残骸0件」
  //   旧「origin/main との差分行は compatibility_flags のみ」→ 新「binding が意図した現在形 ([ai]/[[vectorize]]/index_name)」
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

  test('webhook faq gate 行 (FAQ_BOT_ENABLED gate) が byte-identical で存在', () => {
    const webhook = readRepo('apps/worker/src/routes/webhook.ts');
    expect(webhook).toContain("if (!matched && faqBotEnabled === 'true') {");
  });
});
