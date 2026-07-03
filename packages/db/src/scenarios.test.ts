/**
 * duplicateScenario (シナリオ複製) の深いコピー検証 (batch3 C3 / T-D1・T-D2・T-D3)。
 *
 * real SQLite (better-sqlite3 + 全 migration replay) 上で:
 *   - scenario 全列コピー / is_active=0 固定 / name='(コピー) '+元名 / 新 UUID (T-D1)
 *   - scenario_steps 深いコピー全列一致 + 元不変 + friend_scenarios 非複製 (T-D2)
 *   - steps 0 件シナリオの複製 (T-D3)
 *   - 外部導線 (entry_routes / tracked_links / forms.on_submit_scenario_id) は
 *     コピーも付け替えもしない (codex gap-check MED-2)
 * を assert する。INSERT 列を createScenarioStep の受理列と 1:1 で突き合わせる方針。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { duplicateScenario, getScenarioById } from './scenarios.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const BENIGN_SQLITE_ERROR = /duplicate column name|already exists/i;

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** schema.sql + 全 migration を順に replay して本番同等スキーマを in-memory に構築。 */
function applyMigrationReplay(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of splitSqlStatements(sql)) {
      try {
        db.exec(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!BENIGN_SQLITE_ERROR.test(message)) {
          throw new Error(`${file}: ${message}`);
        }
      }
    }
  }
}

// better-sqlite3 (同期) を D1 の async prepare().bind().first()/all()/run() 形に薄くラップ。
// (packages/db/src/tracked-links.test.ts の d1 shim と同流儀)
function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          params = args;
          return api;
        },
        async first<T>() {
          return (s.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: s.all(...(params as never[])) as T[] };
        },
        async run() {
          s.run(...(params as never[]));
          return {};
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;

// FK 親行 (tags / templates)。複製は既存親を指したままなので、prod 同様に seed する。
function seedParents() {
  raw.prepare(`INSERT INTO tags (id, name, color) VALUES (?, ?, ?)`).run('tag-1', 'VIP', '#111111');
  raw.prepare(`INSERT INTO tags (id, name, color) VALUES (?, ?, ?)`).run('tag-reach-1', '到達', '#222222');
  raw
    .prepare(`INSERT INTO templates (id, name, message_type, message_content) VALUES (?, ?, ?, ?)`)
    .run('tpl-1', '定型文A', 'text', 'テンプレ本文');
}

function seedSourceScenario() {
  seedParents();
  // 元シナリオ: 全列に非既定値を入れて「深いコピー漏れ」を確実に検出する。
  raw
    .prepare(
      `INSERT INTO scenarios
        (id, name, description, trigger_type, trigger_tag_id, is_active, delivery_mode, line_account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'src-1',
      'ようこそシナリオ',
      '新規友だち向けの案内',
      'tag_added',
      'tag-1',
      1,
      'elapsed',
      'acc-1',
      '2026-01-01T10:00:00.000+09:00',
      '2026-01-02T11:00:00.000+09:00',
    );
  // 2 steps: branching / offset / template / on_reach_tag を含め全列コピーを検証。
  raw
    .prepare(
      `INSERT INTO scenario_steps
        (id, scenario_id, step_order, delay_minutes, message_type, message_content,
         condition_type, condition_value, next_step_on_false,
         offset_days, offset_minutes, delivery_time, template_id, on_reach_tag_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'step-1', 'src-1', 0, 0, 'text', 'こんにちは',
      'tag_has', 'vip', 2, 1, 30, null, 'tpl-1', 'tag-reach-1',
      '2026-01-01T10:00:00.000+09:00',
    );
  raw
    .prepare(
      `INSERT INTO scenario_steps
        (id, scenario_id, step_order, delay_minutes, message_type, message_content,
         condition_type, condition_value, next_step_on_false,
         offset_days, offset_minutes, delivery_time, template_id, on_reach_tag_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'step-2', 'src-1', 1, 0, 'flex', '{"type":"bubble"}',
      null, null, null, 2, 0, null, null, null,
      '2026-01-01T10:05:00.000+09:00',
    );
}

// 元 scenario を参照する外部導線 + enroll を seed (複製が触らないことの検証用)。
function seedExternalRefs() {
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name) VALUES (?, ?, ?)`)
    .run('friend-1', 'U-friend-1', '田中');
  raw
    .prepare(
      `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('fs-1', 'friend-1', 'src-1', 0, 'active', '2026-01-03T00:00:00.000+09:00', '2026-01-03T00:00:00.000+09:00');
  raw.prepare(`INSERT INTO entry_routes (id, ref_code, name, scenario_id) VALUES (?, ?, ?, ?)`)
    .run('er-1', 'ref-abc', '入口A', 'src-1');
  raw.prepare(`INSERT INTO tracked_links (id, name, original_url, scenario_id) VALUES (?, ?, ?, ?)`)
    .run('tl-1', '計測リンク', 'https://example.com', 'src-1');
  raw.prepare(`INSERT INTO forms (id, name, on_submit_scenario_id) VALUES (?, ?, ?)`)
    .run('form-1', '問診フォーム', 'src-1');
}

beforeEach(() => {
  raw = new Database(':memory:');
  applyMigrationReplay(raw);
  db = d1(raw);
});

describe('duplicateScenario — scenario 全列コピー (T-D1)', () => {
  test('新 UUID / is_active=0 固定 / name=(コピー) 元名 / 定義列コピー', async () => {
    seedSourceScenario();
    const dup = await duplicateScenario(db, 'src-1');
    expect(dup).not.toBeNull();
    expect(dup!.id).not.toBe('src-1');
    expect(dup!.id.length).toBeGreaterThan(10); // 新 UUID
    expect(dup!.name).toBe('(コピー) ようこそシナリオ');
    expect(dup!.is_active).toBe(0); // 複製直後の意図しない配信開始を防ぐ
    // 定義列は元をそのまま引き継ぐ
    expect(dup!.description).toBe('新規友だち向けの案内');
    expect(dup!.trigger_type).toBe('tag_added');
    expect(dup!.trigger_tag_id).toBe('tag-1');
    expect(dup!.line_account_id).toBe('acc-1');
    expect(dup!.delivery_mode).toBe('elapsed');
    // created_at / updated_at は複製時刻 (元の 2026-01-01/02 ではない)
    expect(dup!.created_at).not.toBe('2026-01-01T10:00:00.000+09:00');
    expect(dup!.updated_at).not.toBe('2026-01-02T11:00:00.000+09:00');
  });

  test('存在しない id は null を返す', async () => {
    const dup = await duplicateScenario(db, 'nope');
    expect(dup).toBeNull();
  });
});

describe('duplicateScenario — steps 深いコピー + 元不変 + enroll 非複製 (T-D2)', () => {
  const COPYABLE_STEP_COLS = [
    'step_order', 'delay_minutes', 'message_type', 'message_content',
    'condition_type', 'condition_value', 'next_step_on_false',
    'offset_days', 'offset_minutes', 'delivery_time', 'template_id', 'on_reach_tag_id',
  ] as const;

  test('全 steps がコピー列一致・id/scenario_id/created_at は新規', async () => {
    seedSourceScenario();
    const dup = await duplicateScenario(db, 'src-1');
    const src = await getScenarioById(db, 'src-1');
    expect(dup!.steps.length).toBe(2);
    expect(src!.steps.length).toBe(2);

    // step_order でソートして 1:1 突き合わせ
    const dupSteps = [...dup!.steps].sort((a, b) => a.step_order - b.step_order);
    const srcSteps = [...src!.steps].sort((a, b) => a.step_order - b.step_order);
    for (let i = 0; i < srcSteps.length; i++) {
      for (const col of COPYABLE_STEP_COLS) {
        expect(dupSteps[i][col]).toEqual(srcSteps[i][col]);
      }
      // 付け替え列: id / scenario_id / created_at は新規
      expect(dupSteps[i].id).not.toBe(srcSteps[i].id);
      expect(dupSteps[i].scenario_id).toBe(dup!.id);
      expect(dupSteps[i].scenario_id).not.toBe('src-1');
    }
  });

  test('元シナリオの steps は不変 (親子付け替えミスで破壊しない)', async () => {
    seedSourceScenario();
    const before = await getScenarioById(db, 'src-1');
    await duplicateScenario(db, 'src-1');
    const after = await getScenarioById(db, 'src-1');
    expect(after!.is_active).toBe(1); // 元は有効のまま
    expect(after!.steps.map((s) => s.id).sort()).toEqual(before!.steps.map((s) => s.id).sort());
    expect(after!.steps.length).toBe(2);
  });

  test('friend_scenarios (enroll) は複製しない', async () => {
    seedSourceScenario();
    seedExternalRefs();
    const dup = await duplicateScenario(db, 'src-1');
    const enrollForNew = raw
      .prepare(`SELECT COUNT(*) AS c FROM friend_scenarios WHERE scenario_id = ?`)
      .get(dup!.id) as { c: number };
    expect(enrollForNew.c).toBe(0);
    // 元の enroll は残る
    const enrollForSrc = raw
      .prepare(`SELECT COUNT(*) AS c FROM friend_scenarios WHERE scenario_id = ?`)
      .get('src-1') as { c: number };
    expect(enrollForSrc.c).toBe(1);
  });

  test('外部導線 (entry_routes/tracked_links/forms) はコピーも付け替えもしない (MED-2)', async () => {
    seedSourceScenario();
    seedExternalRefs();
    const dup = await duplicateScenario(db, 'src-1');
    // 元 id を指したまま
    expect((raw.prepare(`SELECT scenario_id FROM entry_routes WHERE id='er-1'`).get() as { scenario_id: string }).scenario_id).toBe('src-1');
    expect((raw.prepare(`SELECT scenario_id FROM tracked_links WHERE id='tl-1'`).get() as { scenario_id: string }).scenario_id).toBe('src-1');
    expect((raw.prepare(`SELECT on_submit_scenario_id FROM forms WHERE id='form-1'`).get() as { on_submit_scenario_id: string }).on_submit_scenario_id).toBe('src-1');
    // 新 id を指す外部導線は 1 件も無い
    for (const q of [
      `SELECT COUNT(*) AS c FROM entry_routes WHERE scenario_id = ?`,
      `SELECT COUNT(*) AS c FROM tracked_links WHERE scenario_id = ?`,
      `SELECT COUNT(*) AS c FROM forms WHERE on_submit_scenario_id = ?`,
    ]) {
      expect((raw.prepare(q).get(dup!.id) as { c: number }).c).toBe(0);
    }
  });
});

describe('duplicateScenario — steps 0 件エッジケース (T-D3)', () => {
  test('steps が無いシナリオも scenario だけ複製され成功する', async () => {
    raw
      .prepare(
        `INSERT INTO scenarios (id, name, trigger_type, is_active, delivery_mode)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('empty-1', '空シナリオ', 'manual', 1, 'relative');
    const dup = await duplicateScenario(db, 'empty-1');
    expect(dup).not.toBeNull();
    expect(dup!.name).toBe('(コピー) 空シナリオ');
    expect(dup!.is_active).toBe(0);
    expect(dup!.steps.length).toBe(0);
  });
});
