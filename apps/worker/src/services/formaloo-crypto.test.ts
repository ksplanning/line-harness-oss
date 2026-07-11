/**
 * T-A1 (F6-1) — AES-256-GCM envelope 暗号化 helper。
 *   ① round-trip 一致 ② 12-byte random IV 一意 (同一平文→別 ciphertext)
 *   ③ 復号失敗 (KEK 不一致 / 破損 base64) は throw せず null (fail-soft / N-15)
 *   ④ GCM auth tag tamper: ciphertext/iv を 1bit flip すると null (Codex gap #3)
 *   ⑤ AAD 束縛: 別 workspace / 別 field の ciphertext を差し替えると null (Codex gap #3 差替え耐性)
 * 平文/KEK を console.log しない (helper 実装で担保 / grep 検証は D-2)。
 */
import { describe, expect, test } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  formalooFieldAad,
  type EncryptedField,
} from './formaloo-crypto.js';

// mock KEK (base64 32byte)。本番 KEK は wrangler secret (S-1) — test fixture に生値を置かない方針の代理値。
const KEK = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');
const KEK2 = Buffer.from(new Uint8Array(32).fill(2)).toString('base64');

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function flipFirstBit(b64: string): string {
  const bytes = b64ToBytes(b64);
  bytes[0] ^= 0x01;
  return bytesToB64(bytes);
}

const AAD = formalooFieldAad('ws1', 'key');

describe('T-A1 envelope 暗号化 round-trip', () => {
  test('① 暗号化→復号で平文一致', async () => {
    const enc = await encryptSecret(KEK, 'my-api-key-plaintext', AAD);
    const dec = await decryptSecret(KEK, enc, AAD);
    expect(dec).toBe('my-api-key-plaintext');
  });

  test('平文が ciphertext に出ない (暗号文であること)', async () => {
    const enc = await encryptSecret(KEK, 'super-secret-value', AAD);
    expect(atob(enc.ciphertext)).not.toContain('super-secret-value');
  });
});

describe('T-A1 IV 一意性', () => {
  test('② IV は 12-byte・同一平文でも毎回別 ciphertext (getRandomValues 由来)', async () => {
    const a = await encryptSecret(KEK, 'same', AAD);
    const b = await encryptSecret(KEK, 'same', AAD);
    expect(b64ToBytes(a.iv).length).toBe(12);
    expect(b64ToBytes(b.iv).length).toBe(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // どちらも同じ平文に復号できる
    expect(await decryptSecret(KEK, a, AAD)).toBe('same');
    expect(await decryptSecret(KEK, b, AAD)).toBe('same');
  });
});

describe('T-A1 復号失敗 fail-soft (throw せず null)', () => {
  test('③ KEK 不一致 → null', async () => {
    const enc = await encryptSecret(KEK, 'v', AAD);
    expect(await decryptSecret(KEK2, enc, AAD)).toBeNull();
  });

  test('③ 破損 base64 / 不正 KEK → null (例外を握りつぶす)', async () => {
    const enc = await encryptSecret(KEK, 'v', AAD);
    expect(await decryptSecret('not-a-valid-kek', enc, AAD)).toBeNull();
    expect(await decryptSecret(KEK, { ciphertext: '@@@bad', iv: enc.iv }, AAD)).toBeNull();
  });

  test('④ ciphertext を 1bit flip → null (GCM auth tag)', async () => {
    const enc = await encryptSecret(KEK, 'v', AAD);
    const tampered: EncryptedField = { ciphertext: flipFirstBit(enc.ciphertext), iv: enc.iv };
    expect(await decryptSecret(KEK, tampered, AAD)).toBeNull();
  });

  test('④ iv を 1bit flip → null', async () => {
    const enc = await encryptSecret(KEK, 'v', AAD);
    const tampered: EncryptedField = { ciphertext: enc.ciphertext, iv: flipFirstBit(enc.iv) };
    expect(await decryptSecret(KEK, tampered, AAD)).toBeNull();
  });
});

describe('T-A1 AAD 束縛 (差替え耐性)', () => {
  test('⑤ 別 workspace の AAD で復号 → null', async () => {
    const enc = await encryptSecret(KEK, 'v', formalooFieldAad('ws1', 'key'));
    expect(await decryptSecret(KEK, enc, formalooFieldAad('ws2', 'key'))).toBeNull();
  });

  test('⑤ 別 field の AAD で復号 → null (key の ciphertext を secret として復号不可)', async () => {
    const enc = await encryptSecret(KEK, 'v', formalooFieldAad('ws1', 'key'));
    expect(await decryptSecret(KEK, enc, formalooFieldAad('ws1', 'secret'))).toBeNull();
  });
});
