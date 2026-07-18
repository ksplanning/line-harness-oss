/**
 * fr-id-capture-fix / O-5 (codex#2 / 最重要 failure): 二者分離 = 他人回答が prefill されないことの code-level 実証。
 *   owner 立会の実機二者分離 (別 LINE アカ A/B) は infra-ops 工程だが、その fail-closed の芯 =
 *   「prefill lookup は friend_id 完全一致のみ」+「署名 fr_id は改ざん/別 friend を復元しない」を D1 + friend-token で固定する。
 *   - getFriendLatestSubmission(form, A) は A の row のみ返し B の row を絶対に返さない (取り違え防止の SQL 境界)。
 *   - 署名 fr_id: A のトークンは A・B のトークンは B に復元 (cross-friend で取り違えない)。改ざん/別 secret は null (fail-closed)。
 *   - 識別≠認証 (R-2): B の valid token を A が copy して使うと B に復元される = 署名では防げない残余リスク。
 *     ただし A 本人の /fo は LINE session から A を解決するため、A が自分で B のトークンを URL に載せない限り起きない。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { getFriendLatestSubmission } from '@line-crm/db';
import { signFriendToken, verifyFriendToken } from './formaloo-friend-token.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}
function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;
const SECRET = 'frtok_isolation_secret';

function seedSubRow(id: string, formId: string, friendId: string | null, answers: Record<string, unknown>, submittedAt: string) {
  raw.prepare(`INSERT INTO formaloo_submissions (id, form_id, friend_id, answers_json, submitted_at) VALUES (?,?,?,?,?)`)
    .run(id, formId, friendId, JSON.stringify(answers), submittedAt);
}

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });
afterEach(() => raw.close());

describe('二者分離 prefill isolation (O-5: 他人回答が prefill されない)', () => {
  test('getFriendLatestSubmission は friend_id 完全一致のみ返す (A に B の row は絶対出ない)', async () => {
    // A と B が同フォームに別目印回答を送信
    seedSubRow('rowA', 'form1', 'friendA', { q1: 'A-MARK' }, '2026-07-18T10:00:00+09:00');
    seedSubRow('rowB', 'form1', 'friendB', { q1: 'B-MARK' }, '2026-07-18T11:00:00+09:00');

    const a = await getFriendLatestSubmission(DB, 'form1', 'friendA');
    const b = await getFriendLatestSubmission(DB, 'form1', 'friendB');
    expect(JSON.parse(a!.answers_json as string).q1).toBe('A-MARK');
    expect(JSON.parse(b!.answers_json as string).q1).toBe('B-MARK');
    // A の lookup が B の目印を含まない (取り違えゼロ)
    expect(a!.friend_id).toBe('friendA');
    expect(b!.friend_id).toBe('friendB');
  });

  test('friend_id NULL の row (過去送信・fr_id 無し) は誰にも prefill されない (fail-closed)', async () => {
    seedSubRow('rowNull', 'form1', null, { q1: 'ORPHAN' }, '2026-07-18T09:00:00+09:00');
    seedSubRow('rowA', 'form1', 'friendA', { q1: 'A-MARK' }, '2026-07-18T10:00:00+09:00');
    // 未登録 friend は null (誤って ORPHAN row を拾わない)
    expect(await getFriendLatestSubmission(DB, 'form1', 'friendGhost')).toBeNull();
    // A は自分の row のみ (ORPHAN を拾わない)
    expect(JSON.parse((await getFriendLatestSubmission(DB, 'form1', 'friendA'))!.answers_json as string).q1).toBe('A-MARK');
  });

  test('署名 fr_id: A のトークンは A・B のトークンは B に復元 (cross-friend で取り違えない)', async () => {
    const tokenA = (await signFriendToken('friendA', SECRET))!;
    const tokenB = (await signFriendToken('friendB', SECRET))!;
    expect(await verifyFriendToken(tokenA, SECRET)).toBe('friendA');
    expect(await verifyFriendToken(tokenB, SECRET)).toBe('friendB');
    // A のトークンから B は復元されない
    expect(await verifyFriendToken(tokenA, SECRET)).not.toBe('friendB');
  });

  test('改ざん fr_id / 別 secret → null (friend_id を復元しない = prefill 一切なし / fail-closed)', async () => {
    const tokenA = (await signFriendToken('friendA', SECRET))!;
    // sig 改ざん
    expect(await verifyFriendToken(tokenA.slice(0, -1) + (tokenA.endsWith('a') ? 'b' : 'a'), SECRET)).toBeNull();
    // 別 secret で署名検証
    expect(await verifyFriendToken(tokenA, 'different-secret')).toBeNull();
    // friendId 部分だけ別 friend にすげ替え (sig は friendA のもの) → null
    const forged = 'friendB.' + tokenA.split('.')[1];
    expect(await verifyFriendToken(forged, SECRET)).toBeNull();
  });

  test('残余リスク R-2 (識別≠認証): B の valid token をそのまま渡すと B に復元される (署名では防げない)', async () => {
    // これは fail-closed 破りではない: 署名は forgery を防ぐが leaked/共有 token の replay は防げない (owner 受容境界)。
    const tokenB = (await signFriendToken('friendB', SECRET))!;
    // 攻撃者が B の valid token を A の URL に載せても、復元されるのは B (A ではない) = 他人 row は B 本人の row。
    // A 本人の /fo は LINE session から A を解決するため、この経路は A が意図的に他人トークンを使う場合のみ。
    expect(await verifyFriendToken(tokenB, SECRET)).toBe('friendB');
  });
});
