import { describe, expect, test } from 'vitest';
import {
  timingSafeEqualStr,
  verifyWebhookToken,
  parseWebhookPayload,
  verifyHmacSignature,
} from './formaloo-webhook.js';
import { signFriendToken } from './formaloo-friend-token.js';

// =============================================================================
// F-3 / T-C1 — Formaloo webhook 認証 & payload 正規化 (純関数)。
//   - path token 検証 (推測不能 shared-secret / N-4)
//   - HMAC 署名 + timestamp 窓 (±5分 replay 拒否 / N-12)
//   - payload whitelist 抽出 (submission id / slug / answers / friend / M-21)
// =============================================================================

describe('timingSafeEqualStr', () => {
  test('等値は true / 非等値・長さ違いは false', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStr('', '')).toBe(true);
  });
});

describe('verifyWebhookToken (path token / N-4)', () => {
  test('expected 未設定なら常に false (fail-closed: dev では token 検証不能=非承認)', () => {
    expect(verifyWebhookToken('anything', undefined)).toBe(false);
    expect(verifyWebhookToken('anything', '')).toBe(false);
  });
  test('一致で true / 不一致で false', () => {
    expect(verifyWebhookToken('s3cr3t-token', 's3cr3t-token')).toBe(true);
    expect(verifyWebhookToken('wrong', 's3cr3t-token')).toBe(false);
  });
});

describe('parseWebhookPayload (whitelist 抽出 / M-21)', () => {
  const now = '2026-07-10T09:00:00+09:00';
  test('submission id 欠落は null (dedup キー無しは処理不能)', async () => {
    expect(await parseWebhookPayload({ data: { answers: {} } }, now)).toBeNull();
    expect(await parseWebhookPayload(null, now)).toBeNull();
    expect(await parseWebhookPayload('not-object', now)).toBeNull();
  });
  test('data.slug + data.form.slug + answers を抽出', async () => {
    const p = await parseWebhookPayload(
      {
        data: {
          slug: 'sub_123',
          form: { slug: 'form_abc' },
          answers: { q1: '田中', friend_id: 'fr_1' },
          created_at: '2026-07-10T08:59:00+09:00',
        },
      },
      now,
    );
    expect(p).not.toBeNull();
    expect(p!.submissionId).toBe('sub_123');
    expect(p!.slug).toBe('form_abc');
    expect(p!.answers).toEqual({ q1: '田中', friend_id: 'fr_1' });
    expect(p!.friendId).toBe('fr_1');
    expect(p!.submittedAt).toBe('2026-07-10T08:59:00+09:00');
  });
  test('submitted_at 欠落は now を採用', async () => {
    const p = await parseWebhookPayload({ id: 'sub_x', answers: {} }, now);
    expect(p!.submissionId).toBe('sub_x');
    expect(p!.submittedAt).toBe(now);
    expect(p!.friendId).toBeNull();
  });
  test('friend は answers の複数キー候補から解決 (f / line_friend_id など)', async () => {
    expect((await parseWebhookPayload({ id: 's', answers: { f: 'fr_2' } }, now))!.friendId).toBe('fr_2');
    expect((await parseWebhookPayload({ id: 's', answers: { line_friend_id: 'fr_3' } }, now))!.friendId).toBe('fr_3');
  });
  test('未知プロパティは answers 以外に漏らさない (whitelist)', async () => {
    const p = (await parseWebhookPayload({ id: 's', evil: 'x', answers: { a: 1 } }, now))!;
    expect(Object.keys(p).sort()).toEqual(['answers', 'friendId', 'slug', 'submissionId', 'submittedAt']);
  });
});

describe('parseWebhookPayload — 署名 fr_id 復元 (T-A6 / 順方向)', () => {
  const now = '2026-07-10T09:00:00+09:00';
  const SECRET = 'frtok_parse_test_secret';
  const FRIEND = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  test('rendered_data[fr_id] の署名トークンを verify して friendId を復元 (実 payload 形)', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    const p = await parseWebhookPayload(
      {
        event_type: 'form_submit',
        data: { slug: 'sub_1', form: { slug: 'form_abc' }, answers: { q1: '田中' } },
        rendered_data: { fr_id: token, fr_name: '田中' },
      },
      now,
      { friendTokenSecret: SECRET },
    );
    expect(p).not.toBeNull();
    expect(p!.friendId).toBe(FRIEND);
    // 出力 shape は不変 (whitelist / 5 キー) — event_type 等は 1a では出力に足さない
    expect(Object.keys(p!).sort()).toEqual(['answers', 'friendId', 'slug', 'submissionId', 'submittedAt']);
  });

  test('改ざんした fr_id は verify で reject され friendId=null (誤タグ防止 / R-F4)', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    const tampered = token!.slice(0, -1) + (token!.endsWith('A') ? 'B' : 'A');
    const p = await parseWebhookPayload(
      { data: { slug: 'sub_1', form: { slug: 'form_abc' } }, rendered_data: { fr_id: tampered } },
      now,
      { friendTokenSecret: SECRET },
    );
    expect(p!.friendId).toBeNull();
  });

  test('fr_id 欠落 payload (HP 経由) は friendId=null (legacy 候補も無い)', async () => {
    const p = await parseWebhookPayload(
      { data: { slug: 'sub_2', form: { slug: 'form_abc' }, answers: { q1: '匿名' } }, rendered_data: { q1: '匿名' } },
      now,
      { friendTokenSecret: SECRET },
    );
    expect(p!.friendId).toBeNull();
  });

  test('secret 未供給時は署名 fr_id を復元せず legacy 候補 chain に fallback (回帰安全)', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    // secret を渡さない → 署名 fr_id は無視され、legacy answers.friend_id で解決
    const p = await parseWebhookPayload(
      { data: { slug: 'sub_3', form: { slug: 'form_abc' }, answers: { friend_id: 'legacy_fr' } }, rendered_data: { fr_id: token } },
      now,
    );
    expect(p!.friendId).toBe('legacy_fr');
  });

  test('alias は上書き可 (friendTokenAlias)', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    const p = await parseWebhookPayload(
      { data: { slug: 'sub_4', form: { slug: 'form_abc' } }, rendered_data: { line_fr: token } },
      now,
      { friendTokenSecret: SECRET, friendTokenAlias: 'line_fr' },
    );
    expect(p!.friendId).toBe(FRIEND);
  });
});

describe('verifyHmacSignature (HMAC-SHA256 + timestamp 窓 / N-12)', () => {
  const secret = 'whsec_test';
  const body = '{"data":{"slug":"sub_1"}}';

  async function sign(raw: string, ts?: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const msg = ts ? `${ts}.${raw}` : raw;
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  test('secret 未設定なら false (署名検証不能)', async () => {
    expect(await verifyHmacSignature({ rawBody: body, signature: 'x', secret: undefined })).toBe(false);
  });
  test('正しい署名 (timestamp 無し) は true', async () => {
    const sig = await sign(body);
    expect(await verifyHmacSignature({ rawBody: body, signature: sig, secret })).toBe(true);
  });
  test('改竄 body は false', async () => {
    const sig = await sign(body);
    expect(await verifyHmacSignature({ rawBody: body + 'x', signature: sig, secret })).toBe(false);
  });
  test('timestamp 付き署名: 窓内は true / 窓外は false (replay 拒否)', async () => {
    const ts = '2026-07-10T09:00:00+09:00';
    const nowMs = new Date(ts).getTime();
    const sig = await sign(body, ts);
    expect(await verifyHmacSignature({ rawBody: body, signature: sig, secret, timestamp: ts, nowMs })).toBe(true);
    // 10 分後 = ±5 分窓の外
    expect(await verifyHmacSignature({ rawBody: body, signature: sig, secret, timestamp: ts, nowMs: nowMs + 10 * 60_000 })).toBe(false);
  });
  test('署名フォーマット不正 (空/非 hex) は false', async () => {
    expect(await verifyHmacSignature({ rawBody: body, signature: '', secret })).toBe(false);
    expect(await verifyHmacSignature({ rawBody: body, signature: 'zzzz', secret })).toBe(false);
  });
});
