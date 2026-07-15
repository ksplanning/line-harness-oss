/**
 * P2-2 / H-4 — Piecemaker テナント config の自己番人 (invariant guardian)。
 *
 *   ks の formaloo-drift.wrangler.test.ts と同型: 自分の config (wrangler.piecemaker.toml) が
 *   意図した identity / dark-ship flag / cron 定義を保持していることを固定する dark-ship 番人。
 *
 *   1. 自 config identity 番人 (P2-2):
 *        WORKER_NAME / index_name / crons exact-match / FORMALOO_DRIFT_AUTO_APPLY="false"。
 *   2. 横断データ分離 番人 (H-4):
 *        ks の識別子 (D1 id / Vectorize index / R2 bucket / worker 名 / account id / workers subdomain)
 *        が piecemaker config に 1 度も現れないことを機械保証 = 顧客データ混線 0 の構造証明。
 *   3. provisioning 後 実値記入ゲート (§10 B-3 / P4a):
 *        provisioning で採番した実 D1 id / account_id / subdomain が記入済 + placeholder 不在。
 *   4. 秘密ゼロ (PUBLIC repo 前提 L-1):
 *        token / secret 様のリテラルが config に 0 件。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(WORKER_ROOT, p), 'utf8');

// ks 識別子の集合 (piecemaker config に 1 度も現れてはならない = 横断分離の機械保証)。
const KS_IDENTIFIERS = [
  'line-harness-ks', // worker 名 / D1 name / Pages/LIFF project 接頭
  'ks-knowledge-chunks', // Vectorize index
  'line-harness-images-ks', // R2 bucket
  '8367d856-4aa6-4a5a-9d76-6d8cf4997284', // ks D1 id
  '8afbae04688d10af42d2d4ab5a323019', // ks CF account id
  'web-8af', // ks workers.dev subdomain
];

describe('piecemaker tenant wrangler config (P2-2 / H-4)', () => {
  it('自 config identity 番人: WORKER_NAME / index_name / crons / dark-ship flag (P2-2)', () => {
    const src = read('wrangler.piecemaker.toml');
    const lines = src.split('\n').map((l) => l.trim());

    // worker identity
    expect(lines.filter((l) => l === 'name = "line-harness-piecemaker"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'WORKER_NAME = "line-harness-piecemaker"')).toHaveLength(1);

    // D1 / R2 / Vectorize identity (Piecemaker 専用資源)
    expect(lines.filter((l) => l === 'database_name = "line-harness-piecemaker"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'bucket_name = "line-harness-images-piecemaker"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'index_name = "piecemaker-knowledge-chunks"')).toHaveLength(1);

    // cron は ks と同値・exact 一致 (L-10: 6h 式は index.ts の event.cron 判定と byte 一致必須)
    expect(lines.filter((l) => l === 'crons = ["*/5 * * * *", "0 */6 * * *"]')).toHaveLength(1);

    // dark-ship 番人: drift 検知 ON / 自動反映 OFF (誤 auto-apply 点火防止)
    expect(lines.filter((l) => l === 'FORMALOO_DRIFT_ENABLED = "true"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'FORMALOO_DRIFT_AUTO_APPLY = "false"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'FORMALOO_DRIFT_AUTO_APPLY = "true"')).toHaveLength(0);

    // cross-site cookie 前提 (L-12): ADMIN_ORIGIN + ADMIN_ALLOW_CROSS_SITE=true が無いと管理画面ログイン破綻
    expect(src).toContain('ADMIN_ALLOW_CROSS_SITE = "true"');
    expect(src).toMatch(/^ADMIN_ORIGIN = /m);

    // [vars] table 配下に flag が置かれている (構造健全性)
    const varsIdx = src.indexOf('\n[vars]');
    expect(varsIdx).toBeGreaterThan(-1);
    expect(src.indexOf('FORMALOO_DRIFT_ENABLED')).toBeGreaterThan(varsIdx);
  });

  it('横断データ分離 番人: ks の識別子が piecemaker config に 0 件 (H-4)', () => {
    const src = read('wrangler.piecemaker.toml');
    for (const id of KS_IDENTIFIERS) {
      expect(src.includes(id), `piecemaker config が ks 識別子 "${id}" を含んではならない`).toBe(false);
    }
  });

  it('provisioning 後 実値記入ゲート: placeholder 不在 + 実 D1 id / account_id / subdomain 記入済 (§10 B-3 / P4a)', () => {
    const src = read('wrangler.piecemaker.toml');
    const lines = src.split('\n').map((l) => l.trim());
    // 明示ダミー placeholder は provisioning で全て実値へ置換済 = 1 件も残っていない (comment 含め全消し)
    expect(src).not.toContain('<PIECEMAKER_D1_ID>');
    expect(src).not.toContain('<PIECEMAKER_CF_ACCOUNT_ID>');
    expect(src).not.toContain('<PIECEMAKER_WORKERS_SUBDOMAIN>');
    // 実 account id (32 桁 hex) / D1 id (UUID) の形が実在する = provisioning 済の証明。
    const looksLikeCfAccountId = /\b[0-9a-f]{32}\b/;
    const looksLikeD1Uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
    expect(looksLikeCfAccountId.test(src)).toBe(true);
    expect(looksLikeD1Uuid.test(src)).toBe(true);
    // provisioning で採番した Piecemaker 専用の実値を pin (ks 資源でないことは H-4 番人が別途保証)。
    expect(lines.filter((l) => l === 'account_id = "9e4c603b3f47d4072f8a3a27759e8aff"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'database_id = "5a12defb-80cd-4e1b-b6fa-762e5308a21b"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'D1_DATABASE_ID = "5a12defb-80cd-4e1b-b6fa-762e5308a21b"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'CF_ACCOUNT_ID = "9e4c603b3f47d4072f8a3a27759e8aff"')).toHaveLength(1);
    // workers.dev subdomain が解決済 = WORKER_PUBLIC_URL に piecemaker が焼き込まれている。
    expect(src).toContain('https://line-harness-piecemaker.piecemaker.workers.dev');
  });

  it('秘密ゼロ: token / secret 様リテラルが 0 件 (PUBLIC repo 前提 L-1)', () => {
    const src = read('wrangler.piecemaker.toml');
    // channel_access_token / channel_secret / api_key= 実値のような代入が無い
    expect(src).not.toMatch(/channel_access_token/i);
    expect(src).not.toMatch(/channel_secret/i);
    expect(src).not.toMatch(/api_key\s*=\s*["']?[A-Za-z0-9]{20,}/i);
  });

  it('ks 本番 config (wrangler.ks.toml) は不可触 = piecemaker 追加は additive (L-8)', () => {
    // 既存 ks config が現値を保持していることを確認 (兄弟ファイル追加で壊れない additive-safe)。
    const ks = read('wrangler.ks.toml');
    expect(ks).toContain('WORKER_NAME = "line-harness-ks"');
    expect(ks.split('\n').map((l) => l.trim()).filter((l) => l === 'index_name = "ks-knowledge-chunks"')).toHaveLength(1);
  });
});
