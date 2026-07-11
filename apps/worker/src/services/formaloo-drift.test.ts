/**
 * T-B2 / T-B3 (part2) — runFormalooDriftCheck orchestration (client/db/clock 注入)。
 *   1. bootstrap (baseline NULL) → no-fire / baseline set / 履歴 bootstrapped
 *   2. in-sync (fp==baseline) → no-fire / status none
 *   3. drift clean + autoApply ON + not out_of_sync → auto_applied / D1 saveFormalooDefinition 反映 /
 *      baseline 前進 / **pushDefinitionToFormaloo (client.post/put/request) 0 回** (spy) / field_map slug carry (T-B3)
 *   4. drift clean + autoApply OFF → notified only / D1 無書込
 *   5. drift weakened (autoApply ON) → notified only / D1 無書込
 *   6. drift + out_of_sync → conflict_held / D1 無書込 / ローカル編集無傷
 *   7. client null / GET !ok / 例外 → skip / baseline 不変 / 履歴なし (fail-safe)
 *   8. dedup: 同一 pending_remote_hash で 2 tick → 履歴 1 件のみ
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { formalooDefinitionFingerprint } from '@line-crm/shared';
import {
  saveFormalooDefinition,
  setFormalooSyncState,
  getFormalooSyncState,
  getFormalooForm,
  getFormalooFieldMap,
  listFormalooDriftEvents,
} from '@line-crm/db';
import { runFormalooDriftCheck } from './formaloo-drift.js';
import { extractFieldsList, extractRawLogic, extractLogic } from './formaloo-pull.js';
import type { FormalooClient } from './formaloo-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
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
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

/** Formaloo form-detail body。fieldsList は raw Formaloo field 要素、logic は bare array。 */
function body(slug: string, fieldsList: unknown[], logic: unknown[] = []): unknown {
  return { data: { form: { slug, fields_list: fieldsList, logic } } };
}
function rawField(slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { slug, type: 'short_text', title: '氏名', required: false, position: 0, ...over };
}
/** 複合 (compound) logic item — countWeakenedFormalooRules>0 になる (weakened=true)。 */
function compoundLogicItem(): unknown {
  return {
    identifier: 'L1',
    actions: [{
      action: 'show',
      args: [{ identifier: 's_q1' }],
      when: { operation: 'and', args: [
        { operation: 'is', args: [{ type: 'field', value: 's_q1' }, { value: 'a' }] },
        { operation: 'is', args: [{ type: 'field', value: 's_q1' }, { value: 'b' }] },
      ] },
    }],
  };
}

async function fpOf(bodyObj: unknown): Promise<string> {
  const fields = extractFieldsList(bodyObj);
  const rawLogic = extractRawLogic(bodyObj);
  const logicForFp: unknown = rawLogic != null ? rawLogic : extractLogic(bodyObj);
  return formalooDefinitionFingerprint(fields, logicForFp);
}

/** get のみ本物・書込 (post/put/request/delete) は spy 0 回 assert 用。 */
function spyClient(bodyFor: (slug: string) => unknown, opts: { failGet?: boolean; throwGet?: boolean } = {}) {
  const post = vi.fn(async () => ({ ok: true, status: 200, data: {} }));
  const put = vi.fn(async () => ({ ok: true, status: 200, data: {} }));
  const request = vi.fn(async () => ({ ok: true, status: 200, data: {} }));
  const del = vi.fn(async () => ({ ok: true, status: 200, data: {} }));
  const get = vi.fn(async (path: string) => {
    if (opts.throwGet) throw new Error('network boom');
    if (opts.failGet) return { ok: false, status: 500, error: 'HTTP 500' };
    const slug = path.match(/forms\/([^/]+)\//)?.[1] ?? '';
    return { ok: true, status: 200, data: bodyFor(slug) };
  });
  const client = { get, post, put, request, delete: del } as unknown as FormalooClient;
  return { client, get, post, put, request };
}

let raw: Database.Database;
let DB: D1Database;

/** 連携 form + field_map (slug 付き) を seed。field_map.id は form 毎に一意 (グローバル UNIQUE 罠回避)。 */
async function seedForm(id: string, slug: string, def = '{"fields":[],"logic":[]}') {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, formaloo_slug, workspace_id, deleted) VALUES (?, ?, ?, ?, NULL, 0)`,
  ).run(id, id, def, slug);
  await saveFormalooDefinition(DB, id, {
    definitionJson: def,
    fields: [{ id: `${id}_q1`, formalooFieldSlug: 's_q1', fieldType: 'text', label: '氏名', position: 0, configJson: '{}' }],
  });
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('runFormalooDriftCheck — 1. bootstrap (baseline NULL)', () => {
  it('初回は発火せず baseline を現 fingerprint に採用 + 履歴 bootstrapped', async () => {
    await seedForm('f1', 's_form1');
    const b = body('s_form1', [rawField('s_q1')]);
    const { client, post, put, request } = spyClient(() => b);

    const sum = await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: true });

    expect(sum.bootstrapped).toBe(1);
    expect(sum.autoApplied).toBe(0);
    const sync = await getFormalooSyncState(DB, 'f1');
    expect(sync?.remote_definition_hash).toBe(await fpOf(b));
    expect(sync?.drift_status).toBe('none');
    const events = await listFormalooDriftEvents(DB, 'f1');
    expect(events.map((e) => e.action)).toEqual(['bootstrapped']);
    // push は 1 度も呼ばれない
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('runFormalooDriftCheck — 2. in-sync (fp==baseline)', () => {
  it('drift なし → 発火せず status none / 履歴なし', async () => {
    await seedForm('f1', 's_form1');
    const b = body('s_form1', [rawField('s_q1')]);
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', remoteDefinitionHash: await fpOf(b), driftStatus: 'none' });
    const { client } = spyClient(() => b);

    const sum = await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: true });

    expect(sum.inSync).toBe(1);
    expect(sum.autoApplied).toBe(0);
    expect(await listFormalooDriftEvents(DB, 'f1')).toEqual([]);
  });
});

describe('runFormalooDriftCheck — 3. drift clean + autoApply ON → auto_applied', () => {
  it('D1 反映 (定義更新 + slug carry) / baseline 前進 / push 0 回 / 履歴 auto_applied', async () => {
    await seedForm('f1', 's_form1');
    const v1 = body('s_form1', [rawField('s_q1', { title: '氏名' })]);
    const v2 = body('s_form1', [rawField('s_q1', { title: 'お名前' })]); // title drift (clean)
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', remoteDefinitionHash: await fpOf(v1), driftStatus: 'none' });
    const { client, post, put, request } = spyClient(() => v2);

    const sum = await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: true });

    expect(sum.autoApplied).toBe(1);
    // D1 定義が新 title を反映
    const form = await getFormalooForm(DB, 'f1');
    expect(JSON.parse(form!.definition_json).fields[0].label).toBe('お名前');
    // T-B3: field_map の formaloo_field_slug が carry される (wipe しない)
    const map = await getFormalooFieldMap(DB, 'f1');
    expect(map.find((m) => m.id === 'f1_q1')?.formaloo_field_slug).toBe('s_q1');
    // baseline 前進 + status applied
    const sync = await getFormalooSyncState(DB, 'f1');
    expect(sync?.remote_definition_hash).toBe(await fpOf(v2));
    expect(sync?.drift_status).toBe('applied');
    expect(sync?.pending_remote_hash).toBeNull();
    // 履歴
    expect((await listFormalooDriftEvents(DB, 'f1')).map((e) => e.action)).toEqual(['auto_applied']);
    // ★ push は 0 回 (逆方向 push しない)
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('auto-apply 後 baseline == 新 fingerprint なので次 tick は再発火しない (false re-fire なし)', async () => {
    await seedForm('f1', 's_form1');
    const v1 = body('s_form1', [rawField('s_q1', { title: '氏名' })]);
    const v2 = body('s_form1', [rawField('s_q1', { title: 'お名前' })]);
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', remoteDefinitionHash: await fpOf(v1), driftStatus: 'none' });
    const { client } = spyClient(() => v2);
    await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: true });
    const sum2 = await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: true });
    expect(sum2.autoApplied).toBe(0);
    expect(sum2.inSync).toBe(1);
    expect((await listFormalooDriftEvents(DB, 'f1')).length).toBe(1); // auto_applied 1 件のみ
  });
});

describe('runFormalooDriftCheck — 4. drift clean + autoApply OFF → notified only', () => {
  it('D1 無書込 / baseline 不変 / 履歴 notified', async () => {
    await seedForm('f1', 's_form1');
    const v1 = body('s_form1', [rawField('s_q1', { title: '氏名' })]);
    const v2 = body('s_form1', [rawField('s_q1', { title: 'お名前' })]);
    const base = await fpOf(v1);
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', remoteDefinitionHash: base, driftStatus: 'none' });
    const defBefore = (await getFormalooForm(DB, 'f1'))!.definition_json;
    const { client } = spyClient(() => v2);

    const sum = await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: false });

    expect(sum.notified).toBe(1);
    expect(sum.autoApplied).toBe(0);
    const sync = await getFormalooSyncState(DB, 'f1');
    expect(sync?.remote_definition_hash).toBe(base); // baseline 不変
    expect(sync?.pending_remote_hash).toBe(await fpOf(v2));
    expect(sync?.drift_status).toBe('detected');
    expect((await getFormalooForm(DB, 'f1'))!.definition_json).toBe(defBefore); // D1 無書込
    expect((await listFormalooDriftEvents(DB, 'f1')).map((e) => e.action)).toEqual(['notified']);
  });
});

describe('runFormalooDriftCheck — 5. drift weakened (autoApply ON) → notified only', () => {
  it('弱化 warnings ありは flag ON でも auto-apply しない / has_warnings=1', async () => {
    await seedForm('f1', 's_form1');
    const v1 = body('s_form1', [rawField('s_q1')], []);
    const v2 = body('s_form1', [rawField('s_q1')], [compoundLogicItem()]); // 複合 logic 追加 = weakened
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', remoteDefinitionHash: await fpOf(v1), driftStatus: 'none' });
    const defBefore = (await getFormalooForm(DB, 'f1'))!.definition_json;
    const { client } = spyClient(() => v2);

    const sum = await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: true });

    expect(sum.notified).toBe(1);
    expect(sum.autoApplied).toBe(0);
    expect((await getFormalooForm(DB, 'f1'))!.definition_json).toBe(defBefore); // D1 無書込
    const events = await listFormalooDriftEvents(DB, 'f1');
    expect(events[0].action).toBe('notified');
    expect(events[0].has_warnings).toBe(1);
  });
});

describe('runFormalooDriftCheck — 6. drift + out_of_sync → conflict_held', () => {
  it('ローカル未 push 編集ありは auto-apply せず conflict / ローカル定義無傷', async () => {
    await seedForm('f1', 's_form1');
    const v1 = body('s_form1', [rawField('s_q1', { title: '氏名' })]);
    const v2 = body('s_form1', [rawField('s_q1', { title: 'お名前' })]);
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'out_of_sync', remoteDefinitionHash: await fpOf(v1), driftStatus: 'none' });
    const defBefore = (await getFormalooForm(DB, 'f1'))!.definition_json;
    const { client } = spyClient(() => v2);

    const sum = await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: true });

    expect(sum.conflicts).toBe(1);
    expect(sum.autoApplied).toBe(0);
    const sync = await getFormalooSyncState(DB, 'f1');
    expect(sync?.sync_status).toBe('out_of_sync'); // ローカル状態は維持
    expect(sync?.drift_status).toBe('conflict');
    expect((await getFormalooForm(DB, 'f1'))!.definition_json).toBe(defBefore); // ローカル編集無傷
    expect((await listFormalooDriftEvents(DB, 'f1')).map((e) => e.action)).toEqual(['conflict_held']);
  });
});

describe('runFormalooDriftCheck — 7. fail-safe (client 無 / GET 失敗 / 例外)', () => {
  it('client null → skip / baseline 不変 / 履歴なし', async () => {
    await seedForm('f1', 's_form1');
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', remoteDefinitionHash: 'base', driftStatus: 'none' });
    const sum = await runFormalooDriftCheck({ db: DB, resolveClient: async () => null, autoApplyEnabled: true });
    expect(sum.skipped).toBe(1);
    expect(sum.checked).toBe(0);
    expect((await getFormalooSyncState(DB, 'f1'))?.remote_definition_hash).toBe('base');
    expect(await listFormalooDriftEvents(DB, 'f1')).toEqual([]);
  });

  it('GET !ok → skip / baseline 不変', async () => {
    await seedForm('f1', 's_form1');
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', remoteDefinitionHash: 'base', driftStatus: 'none' });
    const { client } = spyClient(() => ({}), { failGet: true });
    const sum = await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: true });
    expect(sum.skipped).toBe(1);
    expect((await getFormalooSyncState(DB, 'f1'))?.remote_definition_hash).toBe('base');
    expect(await listFormalooDriftEvents(DB, 'f1')).toEqual([]);
  });

  it('GET が throw → skip / 他 form は継続 (allSettled / tick 全体を止めない)', async () => {
    await seedForm('f1', 's_boom');
    await seedForm('f2', 's_ok');
    const v = body('s_ok', [rawField('s_q1')]);
    // f1 (s_boom) は throw、f2 (s_ok) は正常 bootstrap
    const throwing = spyClient((slug) => (slug === 's_boom' ? {} : v));
    throwing.get.mockImplementation(async (path: string) => {
      const slug = path.match(/forms\/([^/]+)\//)?.[1] ?? '';
      if (slug === 's_boom') throw new Error('boom');
      return { ok: true, status: 200, data: v };
    });
    const sum = await runFormalooDriftCheck({ db: DB, resolveClient: async () => throwing.client, autoApplyEnabled: true });
    expect(sum.skipped).toBe(1);
    expect(sum.bootstrapped).toBe(1); // f2 は処理された
  });
});

describe('runFormalooDriftCheck — 8. dedup (同一 pending_remote_hash 2 tick)', () => {
  it('通知は pending_remote_hash が変わった時だけ記録 → 2 連続 tick で 1 件のみ', async () => {
    await seedForm('f1', 's_form1');
    const v1 = body('s_form1', [rawField('s_q1', { title: '氏名' })]);
    const v2 = body('s_form1', [rawField('s_q1', { title: 'お名前' })]);
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', remoteDefinitionHash: await fpOf(v1), driftStatus: 'none' });
    const { client } = spyClient(() => v2);

    await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: false });
    const sum2 = await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: false });

    expect(sum2.notified).toBe(0); // 2 回目は dedup で発火しない
    expect((await listFormalooDriftEvents(DB, 'f1')).length).toBe(1); // 履歴は 1 件のみ
  });
});

describe('runFormalooDriftCheck — cap / 全走査', () => {
  it('maxChecks で走査上限を守る', async () => {
    await seedForm('f1', 's_a');
    await seedForm('f2', 's_b');
    const { client } = spyClient((slug) => body(slug, [rawField('s_q1')]));
    const sum = await runFormalooDriftCheck({ db: DB, resolveClient: async () => client, autoApplyEnabled: true, maxChecks: 1 });
    expect(sum.bootstrapped).toBe(1); // 1 form のみ処理
  });
});
