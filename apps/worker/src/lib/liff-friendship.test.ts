/**
 * BUG-2 — safeGetFriendship (liff.getFriendship 非致命化 / fo-liff-infinite-loop-fix)。
 *   client (main.ts) の linkAndAddFlow / initSalonBooking / initEventBooking は
 *   Promise.all([getProfile, getIDToken, getFriendship]) で friendship を並列取得する。
 *   getFriendship は「ログインチャネルが LINE 公式アカウント(bot)にリンク済」の時だけ動作し、
 *   未リンクだと throw する。その reject が Promise.all 全体を巻き添えにすると catch が lu 無しの
 *   生 /fo へ戻し無限ループを誘発する (root cause の増幅器)。
 *   safeGetFriendship は throw を {friendFlag:false} に降格し、リダイレクト/friend-add gate が
 *   getFriendship の成否に依存しないことを担保する (AC4)。
 */
import { describe, expect, test } from 'vitest';
import { safeGetFriendship } from './liff-friendship.js';

describe('safeGetFriendship (BUG-2 getFriendship 非致命化 / AC4)', () => {
  test('resolve → 返り値をそのまま返す (友達判定を保持する = 正常時は degrade しない)', async () => {
    expect(await safeGetFriendship(async () => ({ friendFlag: true }))).toEqual({ friendFlag: true });
    expect(await safeGetFriendship(async () => ({ friendFlag: false }))).toEqual({ friendFlag: false });
  });

  test('Promise reject (bot 未リンク等) → {friendFlag:false} に降格し throw を呼び出し側へ伝播しない', async () => {
    let threw = false;
    let result: { friendFlag: boolean } | undefined;
    try {
      result = await safeGetFriendship(async () => {
        throw new Error('getFriendship failed (channel not linked to OA)');
      });
    } catch {
      threw = true; // ← ここに来たら Promise.all を巻き添えにする = 無限ループ増幅器が残る
    }
    expect(threw).toBe(false); // throw が外へ出ない = Promise.all は reject しない = リダイレクト分岐へ到達
    expect(result).toEqual({ friendFlag: false });
  });

  test('同期 throw でも降格する (呼び出し時例外も Promise reject と同型に握る)', async () => {
    const result = await safeGetFriendship(() => {
      throw new Error('sync throw');
    });
    expect(result).toEqual({ friendFlag: false });
  });
});
