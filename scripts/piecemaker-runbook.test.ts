/**
 * B-5 / B-4 — Piecemaker 運用 runbook の構造 acceptance (機械検証)。
 *   prose だが load-bearing なコマンド/env/段階が欠落していないことを固定する
 *   (§10 B-5「伝播 3 段」/ B-4「build-env 差分」)。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const PROP = 'docs/piecemaker/propagation-runbook.md';
const BENV = 'docs/piecemaker/build-env-rebuild.md';

describe('propagation runbook (§10 B-5: 3 段伝播)', () => {
  it('runbook が存在する', () => {
    expect(existsSync(join(ROOT, PROP))).toBe(true);
  });
  it('段1 dual-push: 両 remote への push + verify-tenant-sync 同期チェック (H-5)', () => {
    const s = read(PROP);
    expect(s).toMatch(/git push origin/);
    expect(s).toMatch(/git push piecemaker/);
    expect(s).toContain('verify-tenant-sync.sh');
  });
  it('段2 両テナント re-deploy: ks/piecemaker 双方の config で deploy', () => {
    const s = read(PROP);
    expect(s).toContain('--config wrangler.ks.toml');
    expect(s).toContain('--config wrangler.piecemaker.toml');
  });
  it('段3 両 D1 migration: 新規 migration を両テナント D1 に安全適用', () => {
    const s = read(PROP);
    expect(s).toMatch(/migration/i);
    expect(s).toMatch(/両.*D1|both.*D1|両テナント/);
    expect(s).toMatch(/backup|バックアップ/i); // additive/backup 先行の安全規律
  });
  it('honest 明記: dual-push だけでは機能伝播は未達 (SHA を揃えるだけ)', () => {
    const s = read(PROP);
    expect(s).toMatch(/dual-push.*だけ|SHA.*揃え|未達|コードが揃っただけ/);
  });
});

describe('build-env rebuild runbook (§10 B-4: ks 値焼込回避)', () => {
  it('runbook が存在する', () => {
    expect(existsSync(join(ROOT, BENV))).toBe(true);
  });
  it('apps/web (admin Pages) 面: Piecemaker env で再 build → out/ を deploy', () => {
    const s = read(BENV);
    expect(s).toContain('NEXT_PUBLIC_API_URL');
    expect(s).toContain('apps/web/out');
    expect(s).toContain('line-harness-piecemaker-admin');
    expect(s).toMatch(/output:\s*'export'|static export|静的/i); // static export 地雷
  });
  it('apps/worker (LIFF client) 面: VITE_* を Piecemaker 値で build', () => {
    const s = read(BENV);
    expect(s).toContain('VITE_WORKER_ORIGIN');
    expect(s).toContain('VITE_LIFF_ID');
  });
  it('地雷明記: ks 成果物 (out/・dist) を使い回さない', () => {
    const s = read(BENV);
    expect(s).toMatch(/使い回さない|焼き込|使い回し禁止|reuse/);
  });
});
