import { describe, expect, test } from 'vitest';
import { signFriendToken, verifyFriendToken } from './formaloo-friend-token.js';

// =============================================================================
// C1 / T-A1・T-A2 — 順方向 fr_id 署名 friend token (R-F4 / 識別≠認証)。
//   signFriendToken(friendId, secret) = `friendId.<base64url(HMAC-SHA256(friendId, secret))[:trunc]>`
//   verifyFriendToken(token, secret)  = 署名一致時のみ friendId を返す (改ざん/別 secret/欠落は null)。
//   専用 secret (FORMALOO_FRIEND_TOKEN_SECRET) = 既存 auth/webhook token 系と別鍵で分離。
//   secret 未設定は fail-closed (署名不可 = 順方向を degrade・生 URL 相当へ)。
// 純関数・DB 非依存 = 単体テスト可 (crypto.subtle のみ使用)。
// =============================================================================

const SECRET = 'frtok_test_secret_do_not_use_in_prod';
// crypto.randomUUID() 形の friend id (不規則・非連番 / friends.ts:174)。
const FRIEND = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('signFriendToken / verifyFriendToken (T-A1: 署名 round-trip + 改ざん reject)', () => {
  test('正当トークンは friendId を復元し、署名 1 文字改ざんは null を返す (fail-closed)', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    expect(token).not.toBeNull();
    // token 形 = `friendId.<sig>` (friendId 部分は平文で読める / fr_name とは別に routing に使う)
    expect(token!.startsWith(FRIEND + '.')).toBe(true);
    expect(await verifyFriendToken(token, SECRET)).toBe(FRIEND);

    // 署名末尾 1 文字改ざん → verify で reject (no friendId)
    const last = token!.slice(-1);
    const tampered = token!.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(await verifyFriendToken(tampered, SECRET)).toBeNull();

    // friendId 部分を別 friendId に差し替えた forgery (任意 friendId の valid token 捏造) → reject
    const sig = token!.slice(token!.lastIndexOf('.') + 1);
    const forged = 'ffffffff-4f89-41d3-9a0c-0305e82c3301.' + sig;
    expect(await verifyFriendToken(forged, SECRET)).toBeNull();
  });
});

describe('signFriendToken / verifyFriendToken (T-A2: 別 secret 分離 + 未設定 fail-closed)', () => {
  test('別 secret では verify が null (既存 auth/webhook token と鍵分離)', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    // 別 secret (auth/webhook secret を流用しても) では検証できない = 分離の証拠
    expect(await verifyFriendToken(token, 'a-completely-different-secret')).toBeNull();
    // 同一 friendId でも別 secret で署名したトークンは元 secret で verify 不能
    const otherToken = await signFriendToken(FRIEND, 'another-secret');
    expect(await verifyFriendToken(otherToken, SECRET)).toBeNull();
  });

  test('secret 未設定/空は署名不可 (fail-closed)・friendId 空も発行しない', async () => {
    expect(await signFriendToken(FRIEND, undefined)).toBeNull();
    expect(await signFriendToken(FRIEND, null)).toBeNull();
    expect(await signFriendToken(FRIEND, '')).toBeNull();
    expect(await signFriendToken('', SECRET)).toBeNull();
  });

  test('verify: token/secret 欠落・区切り無しトークンは null', async () => {
    const token = await signFriendToken(FRIEND, SECRET);
    expect(await verifyFriendToken(undefined, SECRET)).toBeNull();
    expect(await verifyFriendToken(null, SECRET)).toBeNull();
    expect(await verifyFriendToken('', SECRET)).toBeNull();
    expect(await verifyFriendToken(token, undefined)).toBeNull();
    expect(await verifyFriendToken(token, '')).toBeNull();
    expect(await verifyFriendToken('no-dot-token', SECRET)).toBeNull();
    expect(await verifyFriendToken('.only-sig', SECRET)).toBeNull();
  });
});
