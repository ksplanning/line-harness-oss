/**
 * lp-view-token (harness-lp-hosting / S-1) — LP 閲覧 friend 紐付けトークンの単体テスト。
 *
 * 設計 (§spec 5.1 候補1 = AES-GCM opaque envelope):
 *   - PII ゼロ: friendId は暗号文中で URL 非可視 (トークン文字列に平文 friendId が出ない)。
 *   - 署名 (改ざん検知): AES-GCM の auth tag が 1bit 改ざんを reject。
 *   - 期限 (expiry): exp 過去は verify で null。
 *   - fail-closed: secret 欠落 / 別 secret / 改ざん / 期限切れ / 壊れた token = すべて null。
 * WebCrypto (crypto.subtle) のみ = Workers 標準・依存追加なし。純関数・DB 非依存 = 単体テスト可。
 */
import { describe, expect, test } from 'vitest';
import { signLpViewToken, verifyLpViewToken } from './lp-view-token.js';

const SECRET = 'lp_view_secret_test_value';
const FRIEND = 'friend-uuid-0123456789abcdef';
const SLUG = 'summer-campaign';
const HOUR = 3600 * 1000;

describe('signLpViewToken / verifyLpViewToken round-trip', () => {
  test('sign→verify で friendId / lpSlug が復元される', async () => {
    const exp = Date.now() + HOUR;
    const token = await signLpViewToken(FRIEND, SLUG, exp, SECRET);
    expect(token).toBeTruthy();
    const claims = await verifyLpViewToken(token, SECRET);
    expect(claims).not.toBeNull();
    expect(claims!.friendId).toBe(FRIEND);
    expect(claims!.lpSlug).toBe(SLUG);
  });

  test('PII 非露出: トークン文字列に平文 friendId が substring 出現しない', async () => {
    const token = await signLpViewToken(FRIEND, SLUG, Date.now() + HOUR, SECRET);
    expect(token).toBeTruthy();
    expect(token!.includes(FRIEND)).toBe(false);
    // slug も暗号文中 = 平文で載らない
    expect(token!.includes(SLUG)).toBe(false);
  });

  test('毎回異なる iv で同一入力でも別トークンになる (nonce 再利用なし)', async () => {
    const exp = Date.now() + HOUR;
    const a = await signLpViewToken(FRIEND, SLUG, exp, SECRET);
    const b = await signLpViewToken(FRIEND, SLUG, exp, SECRET);
    expect(a).not.toBe(b);
    // どちらも正しく復元される
    expect((await verifyLpViewToken(a, SECRET))!.friendId).toBe(FRIEND);
    expect((await verifyLpViewToken(b, SECRET))!.friendId).toBe(FRIEND);
  });
});

describe('fail-closed (改ざん / 期限 / 別 secret / 欠落)', () => {
  test('改ざんした token は null (AES-GCM auth tag が reject)', async () => {
    const token = await signLpViewToken(FRIEND, SLUG, Date.now() + HOUR, SECRET)!;
    // 中間文字 (ciphertext 領域 = 必ず有効ビット) を差し替える。末尾 base64url 文字は trailing
    // padding ビットを含み得て「差し替えてもバイト不変」になり得るため、中間を狙う (決定的に改ざん)。
    const chars = token!.split('');
    const i = Math.floor(chars.length / 2);
    chars[i] = chars[i] === 'A' ? 'B' : 'A';
    expect(await verifyLpViewToken(chars.join(''), SECRET)).toBeNull();
    // 追加: 先頭 (iv 領域) の改ざんも reject
    const chars2 = token!.split('');
    chars2[2] = chars2[2] === 'A' ? 'B' : 'A';
    expect(await verifyLpViewToken(chars2.join(''), SECRET)).toBeNull();
  });

  test('期限切れ (exp 過去) は null', async () => {
    const token = await signLpViewToken(FRIEND, SLUG, Date.now() - 1000, SECRET);
    expect(await verifyLpViewToken(token, SECRET)).toBeNull();
  });

  test('now を明示すると期限判定が決定的 (境界: exp ちょうどは失効)', async () => {
    const exp = 1_000_000_000_000;
    const token = await signLpViewToken(FRIEND, SLUG, exp, SECRET);
    expect(await verifyLpViewToken(token, SECRET, exp - 1)).not.toBeNull();
    expect(await verifyLpViewToken(token, SECRET, exp)).toBeNull();
  });

  test('別 secret で verify すると null (復号失敗)', async () => {
    const token = await signLpViewToken(FRIEND, SLUG, Date.now() + HOUR, SECRET);
    expect(await verifyLpViewToken(token, 'a-completely-different-secret')).toBeNull();
  });

  test('secret 欠落は sign / verify とも fail-closed', async () => {
    expect(await signLpViewToken(FRIEND, SLUG, Date.now() + HOUR, undefined)).toBeNull();
    expect(await signLpViewToken(FRIEND, SLUG, Date.now() + HOUR, '')).toBeNull();
    const token = await signLpViewToken(FRIEND, SLUG, Date.now() + HOUR, SECRET);
    expect(await verifyLpViewToken(token, undefined)).toBeNull();
    expect(await verifyLpViewToken(token, '')).toBeNull();
  });

  test('friendId / lpSlug 空は sign で null (紐付け対象なし)', async () => {
    expect(await signLpViewToken('', SLUG, Date.now() + HOUR, SECRET)).toBeNull();
    expect(await signLpViewToken(FRIEND, '', Date.now() + HOUR, SECRET)).toBeNull();
  });

  test('壊れた / 空 token は null (crash させない)', async () => {
    expect(await verifyLpViewToken('', SECRET)).toBeNull();
    expect(await verifyLpViewToken(undefined, SECRET)).toBeNull();
    expect(await verifyLpViewToken('not-base64url!!!', SECRET)).toBeNull();
    expect(await verifyLpViewToken('AAAA', SECRET)).toBeNull(); // iv すら満たさない短さ
  });
});
