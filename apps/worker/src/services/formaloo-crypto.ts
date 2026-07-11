// =============================================================================
// Formaloo APIキー envelope 暗号化 helper (F6-1 / T-A1)
// -----------------------------------------------------------------------------
// 複数 workspace の API キー (KEY/SECRET) を D1 に **平文で置かない** ための AES-256-GCM 暗号化。
// KEK (Key Encryption Key) = worker secret `FORMALOO_KEK` (base64 32byte / closer 工程 S-1 で投入・
//   repo/D1/test fixture に生値を置かない)。D1 には base64 暗号文 + IV だけを保存する。
//
// 設計 (§ROLLOUT_PLAN §4 / Codex gap #3/#4 反映):
//   - Web Crypto (crypto.subtle) のみ使用 = Workers 標準・依存追加なし (dep-scan HIGH 0 維持)。
//   - KEY と SECRET を **個別に** 暗号化 (各 12-byte random IV / crypto.getRandomValues)。
//     → 同一平文でも毎回別 ciphertext (IV 再利用による GCM 破綻を構造的に回避)。
//   - AAD (additional authenticated data) = workspace id + field 名 ('key'|'secret')。
//     → 別 workspace / 別 field の ciphertext を差し替えても auth 検証で復号失敗 (差替え耐性)。
//   - 復号は **fail-soft**: KEK 不一致 / tamper (bit-flip) / AAD 不一致 / 破損 base64 いずれも
//     throw せず null を返す (N-15)。呼び出し側 (resolver) は null を「要再登録」として扱う。
//   - **平文 / KEK を console.log しない** (N-15)。エラーは握りつぶし、内容を漏らさない。
// =============================================================================

/** D1 に保存する暗号化フィールド (どちらも base64)。ciphertext は GCM ciphertext + 16byte auth tag。 */
export interface EncryptedField {
  ciphertext: string;
  iv: string;
}

/** GCM 推奨の IV 長 (96bit = 12byte)。 */
const IV_BYTES = 12;
/** AES-256 の生鍵長 (byte)。 */
const KEK_BYTES = 32;

/**
 * field 束縛 AAD。encrypt と decrypt で **必ず同一** の文字列を使う (workspace id + field 名)。
 * これにより A workspace の KEY 暗号文を B workspace や別 field として復号することを構造的に拒否する。
 */
export function formalooFieldAad(workspaceId: string, field: 'key' | 'secret'): string {
  return `formaloo-workspace:${workspaceId}:${field}`;
}

/** Uint8Array → base64 (Workers/Node 両対応 = btoa / Buffer 非依存)。 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 → Uint8Array。不正入力は atob が throw する (呼び出し側 decrypt が捕捉して null)。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64 KEK を AES-GCM CryptoKey に import。長さ不正 (32byte でない) は throw。 */
async function importKek(kekBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(kekBase64);
  if (raw.length !== KEK_BYTES) {
    // KEK の実体は漏らさず、長さ不正のみを汎用メッセージで通知。
    throw new Error('FORMALOO_KEK must be base64-encoded 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * 平文を暗号化。12-byte random IV を毎回生成し、AAD で field 束縛する。
 * KEK が不正 (長さ / base64) の場合は throw (呼び出し側 route が汎用エラーで応答)。
 */
export async function encryptSecret(
  kekBase64: string,
  plaintext: string,
  aad: string,
): Promise<EncryptedField> {
  const key = await importKek(kekBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(ct)), iv: bytesToBase64(iv) };
}

/**
 * 暗号文を復号。**fail-soft**: KEK 不一致 / auth tag tamper / AAD 不一致 / 破損 base64 は
 * すべて null を返す (throw せず / 平文・KEK を漏らさず / N-15)。
 */
export async function decryptSecret(
  kekBase64: string,
  field: EncryptedField,
  aad: string,
): Promise<string | null> {
  try {
    const key = await importKek(kekBase64);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(field.iv), additionalData: new TextEncoder().encode(aad) },
      key,
      base64ToBytes(field.ciphertext),
    );
    return new TextDecoder().decode(pt);
  } catch {
    // 復号不能 = 誤鍵 / 改竄 / 破損。詳細は握りつぶす (別 workspace への誤送信を防ぐため null 短絡)。
    return null;
  }
}
