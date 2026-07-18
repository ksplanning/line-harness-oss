// =============================================================================
// LIFF getFriendship 非致命化 (BUG-2 / fo-liff-infinite-loop-fix)
// -----------------------------------------------------------------------------
// liff.getFriendship() は「ログインチャネルが LINE 公式アカウント(bot)にリンク済」の時だけ動作し、
// 未リンクだと throw する。client (main.ts) の linkAndAddFlow / initSalonBooking / initEventBooking は
// getFriendship を Promise.all で並列取得しており、その reject が Promise.all 全体を巻き添えにすると
// catch が lu 無しの生 /fo へ戻し無限ループを誘発する (root cause の増幅器)。
//
// この純関数で getFriendship を try/catch ラップし、throw を {friendFlag:false} に降格する
// (= 未友達として扱う安全側 degrade)。これによりリダイレクト/friend-add gate が getFriendship の
// 成否に依存しなくなる (getProfile が取れていれば lu 付与の復路へ前進できる)。
// getFriendship 呼び出しを引数で受けることで liff ambient global 非依存 = vitest 単体テスト可
// (src/lib 規約 = liff-return-url / safe-redirect と同源)。
// =============================================================================

/**
 * getFriendship を呼び、throw (Promise reject / 同期例外の双方) したら {friendFlag:false} に降格する。
 * 呼び出し側 (Promise.all) を巻き添えにしないため、例外は外へ伝播しない。
 * @param getFriendship liff.getFriendship を束ねた呼び出し (`() => liff.getFriendship()`)。
 * @returns 常に解決する Promise。正常時は getFriendship の返り値、失敗時は {friendFlag:false}。
 */
export async function safeGetFriendship(
  getFriendship: () => Promise<{ friendFlag: boolean }>,
): Promise<{ friendFlag: boolean }> {
  try {
    return await getFriendship();
  } catch {
    return { friendFlag: false };
  }
}
