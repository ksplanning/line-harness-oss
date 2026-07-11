/**
 * T-C2 (F6-3 / db 層) — ハーネス側フォルダ CRUD helper + cross-account/循環/削除 cascade。
 *   ① createFormalooFolder: lineAccountId 必須・line_accounts 実在確認 (架空 account 400 / Codex M#3) /
 *      parentId は同一 account のみ / 空・過長 name reject (M-21)。
 *   ② renameFormalooFolder / moveFormalooFolder: 循環 (A→B→A)・自己親・別 account 親を reject。
 *   ③ deleteFormalooFolder: 所属 form を未分類 (folder_id=NULL) へ + 子フォルダを親フォルダへ再接続 +
 *      folder 本体削除 を D1 batch で原子的に (form は消えない / 孤児・循環なし)。
 *      Codex M#7: batch 途中失敗注入で全更新 rollback (all-or-nothing) を assert。
 *   ④ listFormalooFolders: account スコープ (別 account のフォルダを返さない)。
 *   ⑤ setFormalooFormFolder: folder.line_account_id === form.line_account_id のみ許可 (cross-account 400)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import {
  createFormalooFolder,
  renameFormalooFolder,
  moveFormalooFolder,
  deleteFormalooFolder,
  listFormalooFolders,
  getFormalooFolder,
  setFormalooFormFolder,
  FolderError,
} from './formaloo-folders.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

// batch 途中失敗の注入制御 (Codex M#7 all-or-nothing 検証)。
// failAfter >= 0 のとき、batch は failAfter 本目の statement 実行後に throw する (transaction rollback を誘発)。
const batchControl = { failAfter: -1 };

interface MockStmt {
  bind(...args: unknown[]): MockStmt;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
  __exec(): { changes: number };
}

function d1(db: Database.Database): D1Database {
  function makeStmt(sql: string): MockStmt {
    const s = db.prepare(sql);
    let params: unknown[] = [];
    const api: MockStmt = {
      bind(...args: unknown[]) { params = args; return api; },
      async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
      async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
      async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      __exec() { const info = s.run(...(params as never[])); return { changes: info.changes }; },
    };
    return api;
  }
  return {
    prepare(sql: string) { return makeStmt(sql); },
    // D1 batch = 単一 transaction (1 文でも失敗すれば none commit)。better-sqlite3 transaction で再現。
    async batch(stmts: MockStmt[]) {
      const tx = db.transaction((list: MockStmt[]) => {
        const out: { meta: { changes: number } }[] = [];
        let i = 0;
        for (const st of list) {
          const info = st.__exec();
          out.push({ meta: { changes: info.changes } });
          i++;
          if (batchControl.failAfter >= 0 && i > batchControl.failAfter) {
            throw new Error('injected mid-batch failure');
          }
        }
        return out;
      });
      return tx(stmts);
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

function seedAccount(id: string) {
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?,?,?,?,?)`,
  ).run(id, `ch_${id}`, id, 'tok', 'sec');
}

function seedForm(id: string, lineAccountId: string | null, folderId: string | null = null) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, line_account_id, folder_id)
     VALUES (?, ?, '{"fields":[],"logic":[]}', ?, ?)`,
  ).run(id, id, lineAccountId, folderId);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  batchControl.failAfter = -1;
  seedAccount('acc_A');
  seedAccount('acc_B');
});
afterEach(() => { batchControl.failAfter = -1; });

describe('① createFormalooFolder — account 必須/実在 + parent 同一 account + name whitelist', () => {
  test('実在 account で作成でき、position/timestamps を持つ', async () => {
    const f = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'キャンペーン' });
    expect(f.id).toMatch(/^ff_/);
    expect(f.line_account_id).toBe('acc_A');
    expect(f.name).toBe('キャンペーン');
    expect(f.parent_id).toBeNull();
    expect(typeof f.position).toBe('number');
    expect(f.created_at).toBeTruthy();
  });

  test('lineAccountId 未指定/空は 400 (架空 account フォルダ禁止)', async () => {
    await expect(createFormalooFolder(DB, { lineAccountId: '', name: 'x' })).rejects.toMatchObject({ status: 400 });
    // @ts-expect-error 未指定
    await expect(createFormalooFolder(DB, { name: 'x' })).rejects.toBeInstanceOf(FolderError);
  });

  test('line_accounts に実在しない account は 400 (Codex M#3)', async () => {
    await expect(createFormalooFolder(DB, { lineAccountId: 'acc_ghost', name: 'x' })).rejects.toMatchObject({ status: 400 });
    // フォルダは作られない
    expect(await listFormalooFolders(DB, 'acc_ghost')).toEqual([]);
  });

  test('空 name / 過長 name は 400 (M-21 whitelist)', async () => {
    await expect(createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '' })).rejects.toMatchObject({ status: 400 });
    await expect(createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '   ' })).rejects.toMatchObject({ status: 400 });
    await expect(createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'あ'.repeat(101) })).rejects.toMatchObject({ status: 400 });
  });

  test('parentId 指定は同一 account の実在フォルダのみ (別 account 親は 400)', async () => {
    const parentA = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '親A' });
    const child = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '子A', parentId: parentA.id });
    expect(child.parent_id).toBe(parentA.id);
    // 別 account の folder を親にできない
    await expect(createFormalooFolder(DB, { lineAccountId: 'acc_B', name: '越境', parentId: parentA.id })).rejects.toMatchObject({ status: 400 });
    // 存在しない親も 400
    await expect(createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'x', parentId: 'ff_ghost' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('② rename / move — 循環・自己親・別 account 親を拒否', () => {
  test('renameFormalooFolder が名前を更新・空/過長は 400・不明 id は 404', async () => {
    const f = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '旧' });
    await renameFormalooFolder(DB, f.id, '新');
    expect((await getFormalooFolder(DB, f.id))!.name).toBe('新');
    await expect(renameFormalooFolder(DB, f.id, '')).rejects.toMatchObject({ status: 400 });
    await expect(renameFormalooFolder(DB, 'ff_ghost', 'x')).rejects.toMatchObject({ status: 404 });
  });

  test('moveFormalooFolder: 親付け替え可・自己親 400・循環 400・別 account 親 400', async () => {
    const a = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'A' });
    const b = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'B', parentId: a.id });
    const bChild = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'Bの子', parentId: b.id });
    // B を トップレベルへ移動
    await moveFormalooFolder(DB, b.id, null);
    expect((await getFormalooFolder(DB, b.id))!.parent_id).toBeNull();
    // 自己親
    await expect(moveFormalooFolder(DB, a.id, a.id)).rejects.toMatchObject({ status: 400 });
    // 循環: a の親を bChild にすると a→...→bChild→b→a? bChild は a の子孫。a を bChild の子にすると循環。
    await moveFormalooFolder(DB, b.id, a.id); // 戻す a>b>bChild
    await expect(moveFormalooFolder(DB, a.id, bChild.id)).rejects.toMatchObject({ status: 400 });
    // 別 account 親
    const other = await createFormalooFolder(DB, { lineAccountId: 'acc_B', name: 'B社' });
    await expect(moveFormalooFolder(DB, a.id, other.id)).rejects.toMatchObject({ status: 400 });
  });
});

describe('③ deleteFormalooFolder — form 未分類化 + 子再接続 + batch all-or-nothing', () => {
  test('削除で所属 form が未分類 (folder_id=NULL) になり form は消えない', async () => {
    const f = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '販促' });
    seedForm('fa_1', 'acc_A', f.id);
    seedForm('fa_2', 'acc_A', f.id);
    await deleteFormalooFolder(DB, f.id);
    // folder は消える
    expect(await getFormalooFolder(DB, f.id)).toBeNull();
    // form は残り、未分類 (folder_id=NULL)
    for (const id of ['fa_1', 'fa_2']) {
      const row = raw.prepare(`SELECT id, folder_id FROM formaloo_forms WHERE id=?`).get(id) as { id: string; folder_id: string | null };
      expect(row.id).toBe(id);
      expect(row.folder_id).toBeNull();
    }
  });

  test('削除で子フォルダが祖父母へ再接続 (孤児/循環なし)', async () => {
    const gp = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '祖父母' });
    const parent = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '親', parentId: gp.id });
    const child = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '子', parentId: parent.id });
    // parent を削除 → child は gp へ再接続
    await deleteFormalooFolder(DB, parent.id);
    expect((await getFormalooFolder(DB, child.id))!.parent_id).toBe(gp.id);
  });

  test('トップレベル削除で子はトップレベル化 (parent_id=NULL)', async () => {
    const top = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'トップ' });
    const child = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '子', parentId: top.id });
    await deleteFormalooFolder(DB, top.id);
    expect((await getFormalooFolder(DB, child.id))!.parent_id).toBeNull();
  });

  test('不明 id 削除は 404', async () => {
    await expect(deleteFormalooFolder(DB, 'ff_ghost')).rejects.toMatchObject({ status: 404 });
  });

  test('⚠️ Codex M#7: batch 途中失敗で全更新 rollback (all-or-nothing・部分適用ゼロ)', async () => {
    const f = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '販促' });
    const child = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: '子', parentId: f.id });
    seedForm('fa_1', 'acc_A', f.id);
    // batch の 1 本目実行後に失敗を注入 → transaction rollback で全て未適用に戻るはず。
    batchControl.failAfter = 1;
    await expect(deleteFormalooFolder(DB, f.id)).rejects.toThrow();
    // rollback: form は未分類化されていない (folder_id=f.id のまま) / folder は残る / 子も付け替わっていない
    const form = raw.prepare(`SELECT folder_id FROM formaloo_forms WHERE id='fa_1'`).get() as { folder_id: string | null };
    expect(form.folder_id).toBe(f.id);
    expect(await getFormalooFolder(DB, f.id)).not.toBeNull();
    expect((await getFormalooFolder(DB, child.id))!.parent_id).toBe(f.id);
  });
});

describe('④ listFormalooFolders — account スコープ', () => {
  test('別 account のフォルダを返さない', async () => {
    await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'A1' });
    await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'A2' });
    await createFormalooFolder(DB, { lineAccountId: 'acc_B', name: 'B1' });
    const a = await listFormalooFolders(DB, 'acc_A');
    expect(a.map((f) => f.name).sort()).toEqual(['A1', 'A2']);
    const b = await listFormalooFolders(DB, 'acc_B');
    expect(b.map((f) => f.name)).toEqual(['B1']);
  });
});

describe('⑤ setFormalooFormFolder — cross-account 混入防止', () => {
  test('同一 account の folder への割当は成功 (folder_id 更新)', async () => {
    const f = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'A販促' });
    seedForm('fa_A', 'acc_A', null);
    await setFormalooFormFolder(DB, 'fa_A', f.id);
    expect((raw.prepare(`SELECT folder_id FROM formaloo_forms WHERE id='fa_A'`).get() as { folder_id: string }).folder_id).toBe(f.id);
  });

  test('別 account の folder への割当は 400 (割り当てない)', async () => {
    const fb = await createFormalooFolder(DB, { lineAccountId: 'acc_B', name: 'B販促' });
    seedForm('fa_A', 'acc_A', null);
    await expect(setFormalooFormFolder(DB, 'fa_A', fb.id)).rejects.toMatchObject({ status: 400 });
    expect((raw.prepare(`SELECT folder_id FROM formaloo_forms WHERE id='fa_A'`).get() as { folder_id: string | null }).folder_id).toBeNull();
  });

  test('共通フォーム (line_account_id NULL) は account フォルダに割り当てられない (folder NOT NULL account と不一致 = 400)', async () => {
    const fa = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'A販促' });
    seedForm('fa_common', null, null);
    await expect(setFormalooFormFolder(DB, 'fa_common', fa.id)).rejects.toMatchObject({ status: 400 });
  });

  test('folderId=null で未分類に戻せる', async () => {
    const f = await createFormalooFolder(DB, { lineAccountId: 'acc_A', name: 'A販促' });
    seedForm('fa_A', 'acc_A', f.id);
    await setFormalooFormFolder(DB, 'fa_A', null);
    expect((raw.prepare(`SELECT folder_id FROM formaloo_forms WHERE id='fa_A'`).get() as { folder_id: string | null }).folder_id).toBeNull();
  });

  test('不明 form は 404 / 不明 folder は 400', async () => {
    seedForm('fa_A', 'acc_A', null);
    await expect(setFormalooFormFolder(DB, 'fa_ghost', null)).rejects.toMatchObject({ status: 404 });
    await expect(setFormalooFormFolder(DB, 'fa_A', 'ff_ghost')).rejects.toMatchObject({ status: 400 });
  });
});
