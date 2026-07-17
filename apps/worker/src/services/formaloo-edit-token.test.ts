/**
 * form-edit-mail-link (弾L / T-B1) — 署名付き編集トークン 純関数。
 *   最重要 failure = 「他人の回答を開けない」の芯。
 *   sign→verify round-trip / 改ざん / 別鍵 / 期限切れ / 区切り無し / 空 rowRef / 別 form (payload 束縛) を全 reject。
 *   作法は formaloo-friend-token.ts 踏襲 (Web Crypto HMAC-SHA256 / base64url / 定数時間比較 / fail-closed) +
 *   構造化 payload (formId/rowRef/epoch/exp を署名対象に焼く) + 期限 (exp) 検証。専用鍵で権限昇格境界。
 */
import { describe, expect, test } from 'vitest';
import {
  signEditToken,
  verifyEditToken,
  editTokenExp,
  EDIT_TOKEN_DEFAULT_TTL_DAYS,
} from './formaloo-edit-token.js';

const SECRET = 'edittok_secret_A';
const OTHER_SECRET = 'edittok_secret_B';
const NOW = 1_800_000_000; // 固定 now (unix 秒)
const EXP = NOW + 3600; // 1h 後

describe('formaloo-edit-token — sign/verify round-trip (T-B1)', () => {
  test('sign→verify が payload (formId/rowRef/epoch/exp) を復元する', async () => {
    const token = await signEditToken({ formId: 'f1', rowRef: 'sub_1', exp: EXP, epoch: 3 }, SECRET);
    expect(token).toBeTruthy();
    expect(token).toContain('.'); // base64url(payload).sig
    const payload = await verifyEditToken(token, SECRET, NOW);
    expect(payload).toEqual({ formId: 'f1', rowRef: 'sub_1', epoch: 3, exp: EXP });
  });

  test('epoch 未指定は 0 に既定化される', async () => {
    const token = await signEditToken({ formId: 'f1', rowRef: 'sub_1', exp: EXP }, SECRET);
    const payload = await verifyEditToken(token, SECRET, NOW);
    expect(payload?.epoch).toBe(0);
  });

  test('editTokenExp(now, ttlDays) = now + ttlDays*86400 / 既定 TTL は 30 日', async () => {
    expect(editTokenExp(NOW, 30)).toBe(NOW + 30 * 86400);
    expect(EDIT_TOKEN_DEFAULT_TTL_DAYS).toBe(30);
    expect(editTokenExp(NOW)).toBe(NOW + EDIT_TOKEN_DEFAULT_TTL_DAYS * 86400);
  });
});

describe('formaloo-edit-token — fail-closed 発行 (T-B1)', () => {
  test('secret 未設定/空は null (署名不可 = 発行不可)', async () => {
    expect(await signEditToken({ formId: 'f1', rowRef: 'sub_1', exp: EXP }, '')).toBeNull();
    expect(await signEditToken({ formId: 'f1', rowRef: 'sub_1', exp: EXP }, undefined)).toBeNull();
    expect(await signEditToken({ formId: 'f1', rowRef: 'sub_1', exp: EXP }, null)).toBeNull();
  });

  test('formId 空 / rowRef 空は null (行束縛の欠落を発行しない)', async () => {
    expect(await signEditToken({ formId: '', rowRef: 'sub_1', exp: EXP }, SECRET)).toBeNull();
    expect(await signEditToken({ formId: 'f1', rowRef: '', exp: EXP }, SECRET)).toBeNull();
  });
});

describe('formaloo-edit-token — verify reject (最重要 = 他人の回答を開けない)', () => {
  test('改ざん payload (formId を別 form に書換) は reject (署名不一致)', async () => {
    const token = await signEditToken({ formId: 'f1', rowRef: 'sub_1', exp: EXP }, SECRET);
    const [payloadB64] = token!.split('.');
    // payload をデコード → formId を別 form に書換 → 再 encode (署名は据置 = 不一致)
    const decoded = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    decoded.f = 'f_ATTACKER';
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const forged = `${tampered}.${token!.split('.')[1]}`;
    expect(await verifyEditToken(forged, SECRET, NOW)).toBeNull();
  });

  test('改ざん payload (rowRef を別 row に書換) は reject (署名不一致)', async () => {
    const token = await signEditToken({ formId: 'f1', rowRef: 'sub_1', exp: EXP }, SECRET);
    const [payloadB64, sig] = token!.split('.');
    const decoded = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    decoded.r = 'sub_VICTIM';
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifyEditToken(`${tampered}.${sig}`, SECRET, NOW)).toBeNull();
  });

  test('別鍵で署名した token は reject', async () => {
    const token = await signEditToken({ formId: 'f1', rowRef: 'sub_1', exp: EXP }, OTHER_SECRET);
    expect(await verifyEditToken(token, SECRET, NOW)).toBeNull();
  });

  test('期限切れ (now >= exp) は reject', async () => {
    const token = await signEditToken({ formId: 'f1', rowRef: 'sub_1', exp: EXP }, SECRET);
    expect(await verifyEditToken(token, SECRET, EXP)).toBeNull(); // now == exp = 期限切れ
    expect(await verifyEditToken(token, SECRET, EXP + 1)).toBeNull(); // now > exp
    expect(await verifyEditToken(token, SECRET, EXP - 1)).not.toBeNull(); // 期限内
  });

  test('sig 改ざん (別署名) は reject', async () => {
    const token = await signEditToken({ formId: 'f1', rowRef: 'sub_1', exp: EXP }, SECRET);
    const [payloadB64] = token!.split('.');
    expect(await verifyEditToken(`${payloadB64}.deadbeefdeadbeefdeadbeefdead`, SECRET, NOW)).toBeNull();
  });

  test('区切り無し / 空 / secret 欠落は reject', async () => {
    expect(await verifyEditToken('no-separator', SECRET, NOW)).toBeNull();
    expect(await verifyEditToken('', SECRET, NOW)).toBeNull();
    expect(await verifyEditToken(null, SECRET, NOW)).toBeNull();
    const token = await signEditToken({ formId: 'f1', rowRef: 'sub_1', exp: EXP }, SECRET);
    expect(await verifyEditToken(token, '', NOW)).toBeNull();
    expect(await verifyEditToken(token, undefined, NOW)).toBeNull();
  });

  test('payload が壊れた base64 / 非 JSON は reject (routing に使わせない)', async () => {
    // 正しい sig を持たない任意文字列は sig 検証で落ちる (JSON decode 前に reject)
    expect(await verifyEditToken('!!!notb64!!!.somesig', SECRET, NOW)).toBeNull();
  });
});
