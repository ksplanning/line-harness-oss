/**
 * T-B2 (Phase B B-2) — アプリ層 pre-tokenize + 実 FTS5 recall + Dice 再ランク。
 *  - buildFaqSearchText / buildQuerySearchText は faq-match.ts の normalize/ngrams を import 再利用。
 *  - 実 FTS5 (better-sqlite3) を張り、pos3 (Phase A 0.6 未満の言い換え) が FTS MATCH (bigram OR) top-K
 *    → 既存 scoreFaq 再ランクで正解 FAQ が best になる。
 *  - neg は「候補0 (無関係)」/「Dice 下限未満 (surface 弱)」で floor 未満 = escalate 側。
 *  - Dice の実測値は spec §4-#5 / better-sqlite3 実 FTS5 で確定 (憶測でない)。
 *  - ⚠️ spec §4-#5 は neg『今日の天気を教えて』を ~0 と記したが、実 normalize/dice では 0.31
 *    (faq_access の variant『アクセス方法を教えて』と "教えて" bigram が衝突)。よって Dice floor 層の
 *    neg は真に無関係な質問 (候補0 / Dice<0.07) を使い、"今日の天気" は LLM __NO_ANSWER__ 層 (C5) で扱う。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeAll, beforeEach } from 'vitest';
import { buildFaqSearchText, buildQuerySearchText, retrieveFaqCandidates, retrieveAndRankFaq } from './faq-fts.js';
import { matchFaqDetailed, type MatchableFaq } from './faq-match.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const TEST_FLOOR = 0.1; // pos3(0.135) を通し clean-neg(<0.07) を弾く分離値 (dark-ship・B-5 で owner 調整)

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const s of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean)) {
      try { db.exec(s); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...a: unknown[]) { params = a; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

const ACC = 'acc-1';
const CORPUS = [
  { id: 'faq_park', q: '駐車場はありますか', v: ['車で来店できますか', 'パーキングの有無'] },
  { id: 'faq_hours', q: '営業時間を教えてください', v: ['何時まで開いていますか', '定休日はいつですか'] },
  { id: 'faq_resv', q: '予約は必要ですか', v: ['当日予約はできますか'] },
  { id: 'faq_pay', q: '支払い方法は何がありますか', v: ['クレジットカードは使えますか', '電子マネー対応'] },
  { id: 'faq_access', q: '最寄り駅からの行き方', v: ['アクセス方法を教えて'] },
];

function seedCorpus(raw: Database.Database) {
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch1','a','t','s')`).run();
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-2','ch2','b','t','s')`).run();
  const ins = raw.prepare(`INSERT INTO faqs (id, line_account_id, question, variants, answer, is_active, search_text) VALUES (?,?,?,?,?,1,?)`);
  for (const f of CORPUS) ins.run(f.id, ACC, f.q, JSON.stringify(f.v), 'ans', buildFaqSearchText(f.q, f.v));
  // 別アカウント (acc-2) の駐車 FAQ = account スコープ漏洩ガードの負例。
  ins.run('faq_other', 'acc-2', '駐車場はありますか', '[]', 'ans', buildFaqSearchText('駐車場はありますか', []));
}

let raw: Database.Database;
let db: D1Database;

beforeAll(() => {
  // FTS5 未対応 env は fail-loud (以降の全 assert が無意味になるため setup で明示検知)。
  const t = new Database(':memory:');
  expect(() => t.exec(`CREATE VIRTUAL TABLE _probe USING fts5(x)`)).not.toThrow();
  t.close();
});

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
  seedCorpus(raw);
});

describe('pre-tokenize (buildFaqSearchText / buildQuerySearchText) — normalize/ngrams import 再利用', () => {
  test('駐車場はありますか → 2-gram 空白連結', () => {
    expect(buildFaqSearchText('駐車場はありますか', [])).toBe('駐車 車場 場は はあ あり りま ます すか');
    expect(buildQuerySearchText('駐車場はありますか')).toBe('駐車 車場 場は はあ あり りま ます すか');
  });
  test('buildFaqSearchText は question + 全 variants の bigram を含む (Phase A 対称)', () => {
    const st = buildFaqSearchText('支払い方法は何がありますか', ['クレジットカードは使えますか']);
    expect(st).toContain('支払'); // question 由来
    expect(st).toContain('くれ'); // variant 由来 (カタカナ→ひらがな正規化後の bigram)
  });
  test('normalize 経由: カタカナ→ひらがな・記号除去 (faq-match と同一挙動)', () => {
    // 「カード」→「かーど」正規化後の bigram を含む。
    expect(buildQuerySearchText('カード払い')).toBe('かー ーど ど払 払い');
  });
});

describe('FTS5 recall + Dice 再ランク (pos = 言い換え / Phase A 0.6 未満)', () => {
  const POS = [
    { q: '車を停める場所はありますか？', expect: 'faq_park', dice: 0.472 },
    { q: 'お店は何時からやってますか', expect: 'faq_hours', dice: 0.186 },
    { q: 'カード払いに対応してる？', expect: 'faq_pay', dice: 0.135 },
  ];
  for (const p of POS) {
    test(`"${p.q}" → Phase A miss だが FTS top-K → 再ランク best=${p.expect} (Dice≈${p.dice})`, async () => {
      // Phase A 決定論路 (Dice 0.6) では取りこぼす。
      const all = CORPUS.map((f) => ({ id: f.id, question: f.q, variants: f.v, is_active: 1 } as unknown as MatchableFaq));
      expect(matchFaqDetailed(p.q, all, 0.6).match).toBeNull();
      // FTS recall + 再ランク。
      const detail = await retrieveAndRankFaq(db, p.q, ACC);
      expect(detail.best?.faq.id).toBe(p.expect);
      expect(detail.topScore).toBeCloseTo(p.dice, 2);
      expect(detail.topScore!).toBeGreaterThanOrEqual(TEST_FLOOR); // tuned floor で生成側
    });
  }

  test('retrieveFaqCandidates は top-K (<=5) を bm25 順で返し正解を含む', async () => {
    const cands = await retrieveFaqCandidates(db, '車を停める場所はありますか？', ACC, 5);
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.length).toBeLessThanOrEqual(5);
    expect(cands.map((c) => c.id)).toContain('faq_park');
  });
});

describe('negative (Dice floor 層で escalate) + account スコープ', () => {
  test('無関係 (候補0) 『宇宙で一番大きい星は？』 → best=null (topScore null)', async () => {
    const detail = await retrieveAndRankFaq(db, '宇宙で一番大きい星は？', ACC);
    expect(detail.best).toBeNull();
    expect(detail.topScore).toBeNull();
  });
  test('無関係 (surface 弱) 『パスワードを忘れました』 → best Dice < floor', async () => {
    const detail = await retrieveAndRankFaq(db, 'パスワードを忘れました', ACC);
    expect(detail.topScore == null || detail.topScore < TEST_FLOOR).toBe(true);
  });
  test('account スコープ: acc-1 の recall に acc-2 の faq_other は入らない', async () => {
    const cands = await retrieveFaqCandidates(db, '駐車場はありますか', ACC, 5);
    expect(cands.map((c) => c.id)).toContain('faq_park');
    expect(cands.map((c) => c.id)).not.toContain('faq_other');
  });
  test('is_active=0 は recall されない', async () => {
    raw.prepare(`UPDATE faqs SET is_active=0 WHERE id='faq_park'`).run();
    const cands = await retrieveFaqCandidates(db, '車を停める場所はありますか？', ACC, 5);
    expect(cands.map((c) => c.id)).not.toContain('faq_park');
  });
  test('空 bigram (極短文) → 候補なし ([])', async () => {
    const cands = await retrieveFaqCandidates(db, '', ACC, 5);
    expect(cands).toEqual([]);
  });
});
