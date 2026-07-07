/**
 * T-F2 (batch F) — WebCrypto PBKDF2-SHA256 password hashing の検証。
 *
 *   - hashPassword → verifyPassword の往復が成功
 *   - 改竄 (別パスワード / hash 書換 / salt 書換) は verify=false
 *   - 同じ平文でも salt が毎回ランダム = hash が毎回変わる (レインボー耐性)
 *   - iterations は明示 ≥100k・algo ラベルつき (将来の強度移行)
 *   - 平文は返り値/ラベルに現れない (漏えい防止)
 */
import { describe, it, expect } from 'vitest'
import {
  hashPassword,
  verifyPassword,
  PBKDF2_ITERATIONS,
  CLOUDFLARE_WORKERS_PBKDF2_MAX_ITERATIONS,
} from './password.js'

describe('T-F2 PBKDF2 password', () => {
  it('hash→verify 往復が成功する', async () => {
    const rec = await hashPassword('Correct-Horse-Battery-42')
    expect(await verifyPassword('Correct-Horse-Battery-42', rec)).toBe(true)
  })

  it('別パスワードは verify=false', async () => {
    const rec = await hashPassword('Correct-Horse-Battery-42')
    expect(await verifyPassword('wrong-password', rec)).toBe(false)
  })

  it('hash / salt を書き換えると verify=false (改竄検知)', async () => {
    const rec = await hashPassword('pw-123456')
    expect(await verifyPassword('pw-123456', { ...rec, password_hash: rec.password_hash.replace(/.$/, '0') })).toBe(false)
    expect(await verifyPassword('pw-123456', { ...rec, password_salt: rec.password_salt.replace(/.$/, '0') })).toBe(false)
  })

  it('同じ平文でも salt がランダムで hash が毎回変わる', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')
    expect(a.password_salt).not.toBe(b.password_salt)
    expect(a.password_hash).not.toBe(b.password_hash)
    // どちらも元の平文で検証できる。
    expect(await verifyPassword('same-password', a)).toBe(true)
    expect(await verifyPassword('same-password', b)).toBe(true)
  })

  it('iterations は明示 ≥100k / algo=pbkdf2-sha256 / 平文は record に現れない', async () => {
    const rec = await hashPassword('MyS3cret')
    expect(rec.password_iterations).toBeGreaterThanOrEqual(100_000)
    expect(rec.password_algo).toBe('pbkdf2-sha256')
    expect(JSON.stringify(rec)).not.toContain('MyS3cret')
  })

  // ── P0 防波堤: Cloudflare Workers の PBKDF2 iterations 上限 100,000 を超えると本番で全ログイン 500。
  //    Node テストには上限が無く挙動テストでは検出できないので、定数を機械的に固定する。
  it('PBKDF2_ITERATIONS は Workers 上限 (100,000) 以下 (超えると本番 500 / 2026-07-07 P0 再発防止)', () => {
    expect(CLOUDFLARE_WORKERS_PBKDF2_MAX_ITERATIONS).toBe(100_000)
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(CLOUDFLARE_WORKERS_PBKDF2_MAX_ITERATIONS)
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(100_000) // 上限ちょうどを使う (強度最大)
    expect(hashPasswordDefaultIterations()).resolves.toBe(PBKDF2_ITERATIONS)
  })

  it('verify は保存された iterations で検証する (前方互換 = 旧 iterations のハッシュも壊れない)', async () => {
    // 旧回数 (210k) で保存された既存行を再現。
    const legacy = await hashPassword('legacy-pw', 210_000)
    expect(legacy.password_iterations).toBe(210_000)
    // 保存回数 (210k) で検証されるので一致する (定数 100k を使っていたら不一致になるはず)。
    expect(await verifyPassword('legacy-pw', legacy)).toBe(true)
    // 保存 iterations を書き換えると (別回数で再計算され) 不一致 = 確かに保存値を使っている証拠。
    expect(await verifyPassword('legacy-pw', { ...legacy, password_iterations: 100_000 })).toBe(false)
  })
})

/** hashPassword の既定 iterations を取り出す小 helper (定数と一致を固定)。 */
async function hashPasswordDefaultIterations(): Promise<number> {
  return (await hashPassword('x')).password_iterations
}
