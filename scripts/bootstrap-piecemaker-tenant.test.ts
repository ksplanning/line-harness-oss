/**
 * P3-1 — bootstrap-piecemaker-tenant.sh の機械検証 (§10 B-1 / B-2 反映)。
 *
 *   実 CF は一切叩かない: WRANGLER_BIN を mock に差し替え、D1 コマンドを傍受して canned 応答を返す
 *   (「書くだけ・実行しない」= provisioning は infra-ops の後続 run)。
 *
 *   検証:
 *     A. 静的構造: wrangler.ks.toml 参照 0 / ks D1 id は比較の 1 箇所のみ / sqlite_master 空 assert /
 *        全 D1 コマンドが piecemaker config を通る。
 *     B. 3 重ガード (B-1): 非空 D1 / database_name 不一致 / database_id==ks / placeholder のまま → 非ゼロ exit。
 *     C. 3 重ガード通過 (GUARD_ONLY) → exit 0。
 *     D. 代表テーブル存在 verify (B-2): 全 5 表あれば green / 1 表欠落で非ゼロ exit。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'bootstrap-piecemaker-tenant.sh');
const KS_D1_ID = '8367d856-4aa6-4a5a-9d76-6d8cf4997284';

let root: string;
let mockBin: string;

const PROVISIONED_TOML = (id = '11111111-2222-3333-4444-555555555555', name = 'line-harness-piecemaker') =>
  [
    'name = "line-harness-piecemaker"',
    '[[d1_databases]]',
    'binding = "DB"',
    `database_name = "${name}"`,
    `database_id = "${id}"`,
    '[vars]',
    'WORKER_NAME = "line-harness-piecemaker"',
  ].join('\n') + '\n';

function writeToml(content: string): string {
  const p = join(root, `toml-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(p, content);
  return p;
}

/** mock wrangler を通してスクリプトを実行し {code, out} を返す。 */
function run(
  toml: string,
  opts: { tableCount?: number; tables?: string; guardOnly?: boolean; d1Tables?: string } = {},
): { code: number; out: string } {
  const env: Record<string, string> = {
    ...process.env,
    WRANGLER_BIN: mockBin,
    PIECEMAKER_TOML: toml,
    MOCK_TABLE_COUNT: String(opts.tableCount ?? 0),
    MOCK_TABLES: opts.tables ?? 'line_accounts friends formaloo_forms knowledge_chunks account_migrations',
  };
  // d1Tables を渡すと mock は guard1 SQL の除外句どおりに実テーブル集合を数える (MOCK_TABLE_COUNT より優先)。
  if (opts.d1Tables !== undefined) env.MOCK_D1_TABLES = opts.d1Tables;
  if (opts.guardOnly) env.GUARD_ONLY = '1';
  try {
    const out = execFileSync('bash', [SCRIPT], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bootstrap-pm-'));
  mockBin = join(root, 'mock-wrangler.sh');
  // mock wrangler: SQL 種別で分岐。COUNT(*)→table count / name IN(...)→表名列挙 / --file→適用成功。
  writeFileSync(
    mockBin,
    [
      '#!/usr/bin/env bash',
      'all="$*"',
      'if [[ "$all" == *"COUNT(*)"* && "$all" == *"sqlite_master"* ]]; then',
      '  if [[ -n "${MOCK_D1_TABLES:-}" ]]; then',
      '    # 実 D1 のテーブル集合を guard1 SQL の WHERE 除外句どおりに数える (SQL に忠実):',
      '    #   sqlite_/d1_ は常に除外。_cf_KV/_cf_METADATA は SQL に NOT IN 除外がある時のみ除外。',
      '    n=0',
      '    for t in ${MOCK_D1_TABLES}; do',
      '      case "$t" in sqlite_*|d1_*) continue ;; esac',
      '      if { [[ "$t" == "_cf_KV" ]] || [[ "$t" == "_cf_METADATA" ]]; } && [[ "$all" == *"_cf_KV"* ]]; then continue; fi',
      '      n=$((n+1))',
      '    done',
      '    echo "{\\"COUNT(*)\\": $n}"',
      '  else',
      '    echo "{\\"COUNT(*)\\": ${MOCK_TABLE_COUNT:-0}}"',
      '  fi',
      'elif [[ "$all" == *"name IN ("* ]]; then',
      '  for t in ${MOCK_TABLES:-}; do echo "  \\"$t\\""; done',
      'else',
      '  echo "applied ok"',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
  );
  chmodSync(mockBin, 0o755);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('bootstrap-piecemaker-tenant.sh — 静的構造 (A)', () => {
  const src = () => readFileSync(SCRIPT, 'utf8');
  it('wrangler.ks.toml を 1 度も参照しない (誤 config 事故防止)', () => {
    expect((src().match(/wrangler\.ks\.toml/g) ?? []).length).toBe(0);
  });
  it('ks D1 id は誤適用ガードの 1 箇所のみ (id 比較専用)', () => {
    expect((src().match(/8367d856/g) ?? []).length).toBe(1);
  });
  it('空 D1 assert に sqlite_master user table count を使う', () => {
    expect(src()).toContain('sqlite_master');
    expect(src()).toMatch(/NOT LIKE 'sqlite_%'/);
  });
  it('全 D1 コマンドが piecemaker config を通る (WR ラッパ + --config)', () => {
    expect(src()).toContain('--config "$PIECEMAKER_TOML"');
  });
});

describe('bootstrap-piecemaker-tenant.sh — 3 重ガード (B/C)', () => {
  it('非空 D1 → guard1 で非ゼロ exit', () => {
    const r = run(writeToml(PROVISIONED_TOML()), { tableCount: 3 });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/空でない|ABORT/);
  });
  it('database_name 不一致 → guard2 で非ゼロ exit', () => {
    const r = run(writeToml(PROVISIONED_TOML('11111111-2222-3333-4444-555555555555', 'wrong-db')));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/database_name/);
  });
  it('database_id == ks D1 id → guard3 で非ゼロ exit', () => {
    const r = run(writeToml(PROVISIONED_TOML(KS_D1_ID)));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/ks/i);
  });
  it('database_id が placeholder のまま → provisioning 未実施で非ゼロ exit', () => {
    const r = run(writeToml(PROVISIONED_TOML('<PIECEMAKER_D1_ID>')));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/placeholder|provisioning/i);
  });
  it('3 重ガード通過 + GUARD_ONLY → exit 0 (bootstrap 未実行)', () => {
    const r = run(writeToml(PROVISIONED_TOML()), { guardOnly: true });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/GUARD-ONLY|通過/);
  });
});

describe('bootstrap-piecemaker-tenant.sh — guard1 _cf_ system table 除外 (fresh D1)', () => {
  // Cloudflare の新規 D1 は常に '_cf_KV' システム表を含む。guard1 の空判定がこれを
  // 除外しないと、真に空の fresh テナント D1 を「user table 1 個」と誤認して常時 block する
  // (infra-ops 実測欠陥)。除外句 NOT IN ('_cf_KV','_cf_METADATA') で fresh D1 を空とみなす。
  it('guard1 SQL が _cf_KV / _cf_METADATA を NOT IN で除外する (静的)', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toMatch(/NOT IN \('_cf_KV','_cf_METADATA'\)/);
  });
  it("'_cf_KV' のみ持つ fresh D1 → guard1 pass (空とみなす)", () => {
    const r = run(writeToml(PROVISIONED_TOML()), { d1Tables: '_cf_KV', guardOnly: true });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/GUARD-ONLY|通過/);
  });
  it("'_cf_KV' + '_cf_METADATA' のみ → guard1 pass (CF システム表 2 種を全除外)", () => {
    const r = run(writeToml(PROVISIONED_TOML()), { d1Tables: '_cf_KV _cf_METADATA', guardOnly: true });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/GUARD-ONLY|通過/);
  });
  it("'_cf_KV' + 実 user table → guard1 は依然 block (除外は CF システム表に限定)", () => {
    const r = run(writeToml(PROVISIONED_TOML()), { d1Tables: '_cf_KV line_accounts' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/空でない|ABORT/);
  });
});

describe('bootstrap-piecemaker-tenant.sh — 代表テーブル verify (D)', () => {
  it('全 5 代表テーブル存在 → exit 0 (bootstrap→verify green)', () => {
    const r = run(writeToml(PROVISIONED_TOML()));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/DONE|verify/i);
  });
  it('代表テーブル 1 つ欠落 → verify で非ゼロ exit', () => {
    const r = run(writeToml(PROVISIONED_TOML()), {
      tables: 'line_accounts friends formaloo_forms account_migrations', // knowledge_chunks 欠落
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/knowledge_chunks|verify/i);
  });
});
