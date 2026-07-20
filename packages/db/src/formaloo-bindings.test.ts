/**
 * T-B3 (F6-2 / db 層) — 作成先 workspace 記録 + account_binding helper の検証。
 *   - createFormalooForm が lineAccountId/workspaceId を台帳へ記録 (未指定は両 NULL = 後方互換)。
 *   - isActiveFormalooWorkspace: 登録済 active のみ true (未登録/無効化は false / 参照整合性 M-4)。
 *   - upsert/get/list/clear account_binding。
 *   - resolveDefaultWorkspace: binding が指す workspace が active のときだけ default を返す。
 *     無効化/未登録/未 binding/default NULL は NULL に落とす (孤立 form を生まない / Codex M#7)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  createFormalooForm,
  getFormalooForm,
  saveFormalooDefinition,
  isActiveFormalooWorkspace,
  upsertFormalooAccountBinding,
  getFormalooAccountBinding,
  listFormalooAccountBindings,
  clearFormalooAccountBinding,
  resolveDefaultWorkspace,
} from './formaloo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(PKG_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function seedWorkspace(id: string, isActive = 1) {
  raw.prepare(
    `INSERT INTO formaloo_workspaces (id, label, key_ciphertext, key_iv, secret_ciphertext, secret_iv, is_active)
     VALUES (?,?, 'ck','iv1','cs','iv2', ?)`,
  ).run(id, id, isActive);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('createFormalooForm — lineAccountId/workspaceId 記録', () => {
  test('渡すと台帳に記録される', async () => {
    const form = await createFormalooForm(DB, { title: 'A社問い合わせ', lineAccountId: 'acc_A', workspaceId: 'fw_1' });
    const fetched = await getFormalooForm(DB, form.id);
    expect(fetched?.line_account_id).toBe('acc_A');
    expect(fetched?.workspace_id).toBe('fw_1');
  });

  test('未指定は両 NULL (env 鍵 / 共通表示 = 後方互換)', async () => {
    const form = await createFormalooForm(DB, { title: '共通フォーム' });
    const fetched = await getFormalooForm(DB, form.id);
    expect(fetched?.line_account_id).toBeNull();
    expect(fetched?.workspace_id).toBeNull();
  });
});

describe('saveFormalooDefinition — title/description present-key 更新 (T-B7)', () => {
  test('指定時だけ title/description を更新し、description:null は明示 clear になる', async () => {
    const form = await createFormalooForm(DB, { title: '旧タイトル', description: '旧説明' });
    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      fields: [],
      title: '新タイトル',
      description: '新説明',
    });
    let saved = await getFormalooForm(DB, form.id);
    expect(saved?.title).toBe('新タイトル');
    expect(saved?.description).toBe('新説明');

    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      fields: [],
      description: null,
    });
    saved = await getFormalooForm(DB, form.id);
    expect(saved?.title).toBe('新タイトル');
    expect(saved?.description).toBeNull();
  });

  test('title/description 未指定の既存呼出は値を変更しない', async () => {
    const form = await createFormalooForm(DB, { title: '保持タイトル', description: '保持説明' });
    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      fields: [],
    });
    const saved = await getFormalooForm(DB, form.id);
    expect(saved?.title).toBe('保持タイトル');
    expect(saved?.description).toBe('保持説明');
  });

  test('定義の置換とdraft化を同じform行の更新で確定する', async () => {
    const form = await createFormalooForm(DB, { title: '公開中' });
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'published' WHERE id = ?").run(form.id);

    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[],"version":2}',
      fields: [],
      builderStatus: 'draft',
    });

    const saved = await getFormalooForm(DB, form.id);
    expect(saved?.definition_json).toBe('{"fields":[],"logic":[],"version":2}');
    expect(saved?.builder_status).toBe('draft');
  });
});

describe('isActiveFormalooWorkspace — 参照整合性', () => {
  test('登録済 active は true / 無効化・未登録は false', async () => {
    seedWorkspace('fw_active', 1);
    seedWorkspace('fw_inactive', 0);
    expect(await isActiveFormalooWorkspace(DB, 'fw_active')).toBe(true);
    expect(await isActiveFormalooWorkspace(DB, 'fw_inactive')).toBe(false);
    expect(await isActiveFormalooWorkspace(DB, 'fw_missing')).toBe(false);
  });
});

describe('account_binding CRUD', () => {
  test('upsert → get → list → clear', async () => {
    await upsertFormalooAccountBinding(DB, 'acc_A', 'fw_1');
    expect((await getFormalooAccountBinding(DB, 'acc_A'))?.default_workspace_id).toBe('fw_1');
    // UPSERT で上書き
    await upsertFormalooAccountBinding(DB, 'acc_A', 'fw_2');
    expect((await getFormalooAccountBinding(DB, 'acc_A'))?.default_workspace_id).toBe('fw_2');
    // list
    await upsertFormalooAccountBinding(DB, 'acc_B', 'fw_3');
    const all = await listFormalooAccountBindings(DB);
    expect(all.map((b) => b.line_account_id).sort()).toEqual(['acc_A', 'acc_B']);
    // clear
    await clearFormalooAccountBinding(DB, 'acc_A');
    expect(await getFormalooAccountBinding(DB, 'acc_A')).toBeNull();
  });
});

describe('resolveDefaultWorkspace — active 限定 (Codex M#7)', () => {
  test('binding が active workspace を指すとき default を返す', async () => {
    seedWorkspace('fw_1', 1);
    await upsertFormalooAccountBinding(DB, 'acc_A', 'fw_1');
    expect(await resolveDefaultWorkspace(DB, 'acc_A')).toBe('fw_1');
  });

  test('binding の workspace が無効化されたら NULL に落とす (孤立させない)', async () => {
    seedWorkspace('fw_1', 1);
    await upsertFormalooAccountBinding(DB, 'acc_A', 'fw_1');
    raw.prepare(`UPDATE formaloo_workspaces SET is_active=0 WHERE id='fw_1'`).run();
    expect(await resolveDefaultWorkspace(DB, 'acc_A')).toBeNull();
  });

  test('binding の workspace が未登録 → NULL', async () => {
    await upsertFormalooAccountBinding(DB, 'acc_A', 'fw_ghost');
    expect(await resolveDefaultWorkspace(DB, 'acc_A')).toBeNull();
  });

  test('binding 無し → NULL', async () => {
    expect(await resolveDefaultWorkspace(DB, 'acc_none')).toBeNull();
  });

  test('binding の default_workspace_id が NULL → NULL', async () => {
    await upsertFormalooAccountBinding(DB, 'acc_A', null);
    expect(await resolveDefaultWorkspace(DB, 'acc_A')).toBeNull();
  });
});
