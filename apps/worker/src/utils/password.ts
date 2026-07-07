/**
 * ID/PASS ログインのパスワードハッシュ (batch F / T-F2)。
 *
 * WebCrypto (crypto.subtle) の PBKDF2-SHA256 を使う (Cloudflare Workers ネイティブ = Node/bcrypt に
 * 依存しない)。平文パスワードは保存も返却もせず、ハッシュ + ソルト + 反復回数のみを持つ record を作る。
 *
 * 設計:
 *   - salt: 16 バイトのランダム (毎回新規) → 同じ平文でもハッシュが毎回変わる (レインボー/事前計算耐性)。
 *   - iterations: 明示保存 (DB に持つ) → 将来強度を引き上げても、既存ハッシュは保存時の回数で検証できる。
 *   - 比較は定数時間 (タイミング攻撃対策)。
 */

const ALGO = 'pbkdf2-sha256';

/**
 * Cloudflare Workers の PBKDF2 iterations 実行上限 = 100,000。
 * これを超えると本番 (workerd) の crypto.subtle.deriveBits が失敗し、ID/PASS ログインの全試行
 * (hash 生成も verify も) が 500 になる。Node のテスト環境には上限が無いため単体テストでは検出できず、
 * closer の本番地面確認で発覚 (2026-07-07 P0)。**iterations は必ずこの値以下に保つこと。**
 * 参照: Cloudflare Workers Web Crypto (PBKDF2 iterations は 100,000 が上限)。
 */
export const CLOUDFLARE_WORKERS_PBKDF2_MAX_ITERATIONS = 100_000;

/** 新規ハッシュの反復回数。Workers 上限ちょうど (>100k は本番 500 / 上の制約参照)。 */
export const PBKDF2_ITERATIONS = 100_000;

const KEY_LEN_BITS = 256;
const SALT_BYTES = 16;

export interface PasswordRecord {
  password_hash: string; // hex
  password_salt: string; // hex
  password_algo: string;
  password_iterations: number;
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveHex(plain: string, salt: Uint8Array, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(plain), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_LEN_BITS,
  );
  return toHex(bits);
}

/** 定数時間の hex 文字列比較 (長さ差・内容差でタイミングを漏らさない)。 */
function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = fromHex(a);
  const bb = fromHex(b);
  // 長さが違えば false だが、途中 return せず全走査して定数時間性を保つ。
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * 平文 → PBKDF2 ハッシュ record (毎回新しい salt)。平文は record に一切残さない。
 * iterations は record に保存されるので、verifyPassword は「保存時の回数」で検証する
 * (将来この既定値を引き上げても、既存ハッシュは保存回数で検証でき壊れない = 前方互換)。
 * @param iterations 反復回数 (既定 = PBKDF2_ITERATIONS)。本番 route は既定のみ使用。テスト/移行で
 *   旧回数を再現する時だけ明示指定する (本番は Workers 上限のため PBKDF2_ITERATIONS 固定)。
 */
export async function hashPassword(
  plain: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<PasswordRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveHex(plain, salt, iterations);
  return {
    password_hash: hash,
    password_salt: toHex(salt),
    password_algo: ALGO,
    password_iterations: iterations,
  };
}

/** 平文が record と一致するか (保存時の salt/iterations で再計算し定数時間比較)。 */
export async function verifyPassword(
  plain: string,
  record: Pick<PasswordRecord, 'password_hash' | 'password_salt' | 'password_algo' | 'password_iterations'>,
): Promise<boolean> {
  if (!record.password_hash || !record.password_salt) return false;
  if (record.password_algo && record.password_algo !== ALGO) return false;
  // 保存時の iterations で検証 (前方互換)。欠損時のみ現行既定にフォールバック。
  const iterations = record.password_iterations || PBKDF2_ITERATIONS;
  const candidate = await deriveHex(plain, fromHex(record.password_salt), iterations);
  return timingSafeEqualHex(candidate, record.password_hash);
}
