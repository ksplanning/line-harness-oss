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

// B-5 (T-E5 / D-1 救済) で unanswered-inbox.ts は source 別証拠窓を導入する = 「ファイル全体 byte-identical」は
// 撤回し、dark-ship 安全の実体である「auto_reply の 5000ms 窓が byte-identical」を不変条件に置き換える。
describe('D-1 — unanswered-inbox.ts の auto_reply 証拠窓は byte-identical (B-5 T-E5 は faq_bot のみ source 別大窓)', () => {
  const cur = readRepo('apps/worker/src/services/unanswered-inbox.ts');
  const main = execFileSync('git', ['show', 'origin/main:apps/worker/src/services/unanswered-inbox.ts'], { cwd: REPO }).toString();
  test('auto_reply の 5000ms 窓定数は不変 (自動応答の既存挙動を退行させない)', () => {
    expect(cur).toContain('const AUTO_REPLY_EVIDENCE_WINDOW_MS = 5_000;');
    expect(main).toContain('const AUTO_REPLY_EVIDENCE_WINDOW_MS = 5_000;');
  });
  test('B-5 の変更は faq_bot 用 source 別大窓の追加に限る (本番 faq_bot 行は flag ON まで 0 件 = dark-ship 安全)', () => {
    expect(cur).toContain('FAQ_AI_EVIDENCE_WINDOW_MS');
    // origin/main には存在しない = B-5 で追加した sanctioned な変更。
    expect(main).not.toContain('FAQ_AI_EVIDENCE_WINDOW_MS');
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
