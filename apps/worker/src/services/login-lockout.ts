/**
 * ID/PASS ログインの account lockout ポリシー (batch F / T-F4)。
 *
 * D1 の failed_login_count を権威に、連続失敗で account を一時 lock する (in-memory rate-limit は
 * per-isolate/cold start 揮発なので lock の権威にしない / M-23)。純関数 = 副作用なし・test 容易。
 *
 * lockout 防止 (failure_observable 直撃) の設計:
 *   - owner role は hard-lock しない = 短窓 throttle のみ (締め出し防止)。owner が全 password を失っても
 *     env API_KEY Bearer break-glass (auth.ts) が別経路で常に通る。
 *   - 非 owner は指数バックオフ (1→2→4→8→16→30 分で頭打ち)。owner が /staff から解除できる。
 *   - IP 次元は rate-limit.ts の per-IP throttle が担う (本モジュールは per-account / GC-6 の複合)。
 */

/** この失敗回数「以上」で lock を検討する。 */
export const LOGIN_FAIL_THRESHOLD = 5;

/** 非 owner の lock 上限 (分)。指数バックオフの頭打ち。 */
export const MAX_LOCK_MINUTES = 30;

/** owner の throttle 上限 (分)。owner は hard-lock しない = ここで頭打ち。 */
export const OWNER_MAX_THROTTLE_MINUTES = 1;

/**
 * 連続失敗回数と role から lock 分数を決める。0 = lock しない。
 *
 * @param failedCount インクリメント後の連続失敗回数
 * @param role 'owner' は短窓 throttle のみ (hard-lock 禁止)
 */
export function computeLockMinutes(failedCount: number, role: 'owner' | 'admin' | 'staff'): number {
  if (failedCount < LOGIN_FAIL_THRESHOLD) return 0;
  const extra = failedCount - LOGIN_FAIL_THRESHOLD; // 0,1,2,...
  const backoff = Math.min(2 ** extra, MAX_LOCK_MINUTES); // 1,2,4,8,16,30...
  if (role === 'owner') return Math.min(backoff, OWNER_MAX_THROTTLE_MINUTES);
  return backoff;
}

/** now(JST) から minutes 後の JST 文字列 (locked_until 保存用 / julianday 比較で使う)。 */
export function lockedUntilFromNow(minutes: number, now: Date = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 3600_000 + minutes * 60_000);
  return jst.toISOString().replace('Z', '');
}
