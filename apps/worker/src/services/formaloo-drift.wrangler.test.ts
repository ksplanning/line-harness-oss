/**
 * T-C3 — wrangler config の drift flag (dark-ship 不変)。
 *   FORMALOO_DRIFT_ENABLED="true" (検知/通知 ON) + FORMALOO_DRIFT_AUTO_APPLY="false" (自動反映 OFF = 案 B 既定)。
 *   ★ KS 本番 config は wrangler.ks.toml (memory: 「wrangler.ks.toml is the true KS production config」)。
 *      OSS template wrangler.toml は default + production の 2 env。
 *   AUTO_APPLY が誤って "true" (auto-apply 誤点火) になっていないことも固定 (dark-ship 番人)。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(WORKER_ROOT, p), 'utf8');

describe('wrangler drift flags (T-C3)', () => {
  it('KS 本番 config (wrangler.ks.toml): ENABLED="true" / AUTO_APPLY="false" (dark-ship)', () => {
    const src = read('wrangler.ks.toml');
    const lines = src.split('\n').map((l) => l.trim());
    expect(lines.filter((l) => l === 'FORMALOO_DRIFT_ENABLED = "true"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'FORMALOO_DRIFT_AUTO_APPLY = "false"')).toHaveLength(1);
    // dark-ship 番人: auto-apply が "true" になっていない (owner 未確定)
    expect(lines.filter((l) => l === 'FORMALOO_DRIFT_AUTO_APPLY = "true"')).toHaveLength(0);
    // [vars] table 配下に置かれている (drift flag が [vars] より後・別 table 前に出現)
    const varsIdx = src.indexOf('\n[vars]');
    expect(varsIdx).toBeGreaterThan(-1);
    expect(src.indexOf('FORMALOO_DRIFT_ENABLED')).toBeGreaterThan(varsIdx);
    // config 構造が壊れていない (KS 識別子 + crons 健在)
    expect(src).toContain('WORKER_NAME = "line-harness-ks"');
    expect(lines.filter((l) => l === 'crons = ["*/5 * * * *", "0 */6 * * *"]')).toHaveLength(1);
  });

  it('OSS template (wrangler.toml): default + production の両 env に ENABLED="true" / AUTO_APPLY="false"', () => {
    const lines = read('wrangler.toml').split('\n').map((l) => l.trim());
    expect(lines.filter((l) => l === 'FORMALOO_DRIFT_ENABLED = "true"')).toHaveLength(2);
    expect(lines.filter((l) => l === 'FORMALOO_DRIFT_AUTO_APPLY = "false"')).toHaveLength(2);
    expect(lines.filter((l) => l === 'FORMALOO_DRIFT_AUTO_APPLY = "true"')).toHaveLength(0);
  });
});
