/**
 * D-1 / D-2 / D-3 (Phase B B-1) — 不可侵 assert (機械検証)。
 *  D-1: unanswered-inbox.ts が origin/main と byte-identical (AI 自動回答は既存 faq_bot 証拠経路)。
 *  D-2: プロンプトに秘密値/friend_id 等内部識別子が載らない (system+根拠+質問のみ)。
 *  D-3: faq-match.ts / webhook gate 行 / wrangler flag 行 (crons=[] / FAQ_BOT_ENABLED="false") が
 *       byte-identical。
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

  test('wrangler.ks.toml の crons=[] と FAQ_BOT_ENABLED="false" 行が存在 (dark-ship)', () => {
    const toml = readRepo('apps/worker/wrangler.ks.toml');
    expect(toml).toContain('crons = []');
    expect(toml).toContain('FAQ_BOT_ENABLED = "false"');
    // B-3 が compatibility_flags に global_fetch_strictly_public を additive 追記するため、ファイル全体
    // byte-identical ではなく「origin/main との差分行は compatibility_flags 行のみ」を行単位で確認する
    // (dark-ship の crons=[] / FAQ_BOT_ENABLED 2 行は不可侵)。
    const cur = toml.split('\n');
    const main = execFileSync('git', ['show', 'origin/main:apps/worker/wrangler.ks.toml'], { cwd: REPO }).toString().split('\n');
    expect(cur.length).toBe(main.length);
    for (const l of cur.filter((l, i) => l !== main[i])) expect(l).toMatch(/compatibility_flags/);
  });

  test('webhook faq gate 行 (FAQ_BOT_ENABLED gate) が byte-identical で存在', () => {
    const webhook = readRepo('apps/worker/src/routes/webhook.ts');
    expect(webhook).toContain("if (!matched && faqBotEnabled === 'true') {");
  });
});
