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
const ITERATIONS = 210_000; // OWASP 2023 PBKDF2-SHA256 目安以上
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

/** 平文 → PBKDF2 ハッシュ record (毎回新しい salt)。平文は record に一切残さない。 */
export async function hashPassword(plain: string): Promise<PasswordRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveHex(plain, salt, ITERATIONS);
  return {
    password_hash: hash,
    password_salt: toHex(salt),
    password_algo: ALGO,
    password_iterations: ITERATIONS,
  };
}

/** 平文が record と一致するか (保存時の salt/iterations で再計算し定数時間比較)。 */
export async function verifyPassword(
  plain: string,
  record: Pick<PasswordRecord, 'password_hash' | 'password_salt' | 'password_algo' | 'password_iterations'>,
): Promise<boolean> {
  if (!record.password_hash || !record.password_salt) return false;
  if (record.password_algo && record.password_algo !== ALGO) return false;
  const iterations = record.password_iterations || ITERATIONS;
  const candidate = await deriveHex(plain, fromHex(record.password_salt), iterations);
  return timingSafeEqualHex(candidate, record.password_hash);
}
