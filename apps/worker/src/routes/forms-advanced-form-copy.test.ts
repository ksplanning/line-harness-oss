/**
 * form-jp-localization (T-B2) — PUT 保存で公開ページ文言 (button_text/success_message/error_message) を
 *   Formaloo へ反映・定義に永続・soft-200 対策の GET-after-PATCH で honest surface。
 *  - 文言は既存 title/description meta PATCH に additive 合流 (present-key only / update 意味論)。
 *  - formCopy 未提供 save は文言を送らず prev を carry (後方互換 byte 不変)。
 *  - 設定は保存されるが hosted に反映されない (soft-200) を GET-after-PATCH 不一致→ out_of_sync で surface。
 * design route test (forms-advanced-design.test.ts) を写経元にした file-disjoint な専用 harness。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { JP_LOCALIZED_CONTENT, MANAGED_LOCALIZATION_KEYS } from '@line-crm/shared';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formsAdvanced } from './forms-advanced.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() { const info = statement.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((p) => p.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'copy-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'copy-formaloo-key', FORMALOO_API_SECRET: 'copy-formaloo-secret',
    // fr-id-capture-fix (T-C3): friend system field auto-push は本 test の関心外 (文言 localization)。
    //   静的 GET mock は POST 後の field を反映しないため無効化 (専用検証 = formaloo-sync.system-fields.test.ts)。
    FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE: '1',
    ...overrides,
  } as Env['Bindings'];
}

function app() {
  const hono = new Hono<Env>();
  hono.use('*', authMiddleware);
  hono.use('*', permissionMiddleware);
  hono.route('/', formsAdvanced);
  return hono;
}

function call(method: string, path: string, body?: unknown, bindings?: Partial<Env['Bindings']>) {
  return app().request(path, {
    method,
    headers: { Authorization: 'Bearer copy-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env(bindings));
}

function seedForm(id: string, slug: string | null, definitionJson = '{"fields":[],"logic":[]}') {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, 'タイトル', '説明', ?, ?)`,
  ).run(id, definitionJson, slug);
}

function rawDefinitionOf(id: string): string {
  const r = raw.prepare(`SELECT definition_json AS d FROM formaloo_forms WHERE id=?`).get(id) as { d: string };
  return r.d;
}
function definitionOf(id: string): Record<string, unknown> {
  return JSON.parse(rawDefinitionOf(id));
}

interface ApiCall { method: string; url: string; body: unknown }
const COPY_KEYS = ['button_text', 'success_message', 'error_message'];

/**
 * form-copy-sync-warning-fix: Formaloo の server-side 文言正規化 (全角→半角 等) を模倣する fold
 *   (evidence/spike-normalization-matrix.md §2+§4)。stub の PATCH がこの fold を掛けて state に保存する
 *   ことで「owner が打った全角値を送っても Formaloo は半角値を保存/返却する」実挙動を route test で再現する。
 */
function formalooFold(s: string): string {
  return s.normalize('NFKC').replace(/[\r\t]/g, ' ').replace(/ +/g, ' ');
}

/**
 * Formaloo API stub。文言 PATCH は remote form state に round-trip 反映され、後続 GET (= confirmFormCopyReflected)
 *   がそれを返す (実 Formaloo GET-after-PATCH 挙動を模倣)。
 *   - softIgnore: 文言 PATCH を soft-200 で無言無視 (state に反映しない = 反映されない地雷)。
 *   - reflectAfterGet: N 回目の confirm GET から反映 (bounded retry 収束模倣)。
 *   - foldCopy: 文言 PATCH 値を formalooFold して保存 (Formaloo の server-side 正規化を模倣 = 全角→半角)。
 */
function stubFormaloo(opts: { getForm?: Record<string, unknown>; softIgnore?: boolean; softIgnoreLocalization?: boolean; reflectAfterGet?: number; foldCopy?: boolean } = {}) {
  const calls: ApiCall[] = [];
  const state: Record<string, unknown> = { fields_list: [], ...(opts.getForm ?? {}) };
  let pending: Record<string, unknown> | null = null;
  let getCount = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (!(init?.body instanceof FormData)) {
      try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    }
    calls.push({ method, url, body });

    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'copy-jwt' }), { status: 200 });
    }
    if (method === 'POST' && /\/v3\.0\/forms\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { form: { slug: 'CREATED' } } }), { status: 201 });
    }
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      getCount += 1;
      if (pending && opts.reflectAfterGet != null && getCount >= opts.reflectAfterGet) { Object.assign(state, pending); pending = null; }
      return new Response(JSON.stringify({ data: { form: { ...state } } }), { status: 200 });
    }
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      const patchBody = (body ?? {}) as Record<string, unknown>;
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patchBody)) if (COPY_KEYS.includes(k)) copy[k] = v;
      if (Object.keys(copy).length) {
        // form-copy-sync-warning-fix: foldCopy 時は Formaloo の server-side 正規化を模して保存 (全角→半角 等)。
        const stored = opts.foldCopy
          ? Object.fromEntries(Object.entries(copy).map(([k, v]) => [k, typeof v === 'string' ? formalooFold(v) : v]))
          : copy;
        if (opts.softIgnore) { /* soft-200: 無言無視 = state に反映しない */ }
        else if (opts.reflectAfterGet != null) pending = { ...(pending ?? {}), ...stored };
        else Object.assign(state, stored);
      }
      if ('localized_content' in patchBody && !opts.softIgnoreLocalization) {
        state.localized_content = patchBody.localized_content;
      }
      return new Response(JSON.stringify({ data: { form: body } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return calls;
}

/** 文言 key を持つ meta PATCH を探す (文言を運ぶ PATCH は meta PATCH のみ)。 */
function copyPatch(calls: ApiCall[]) {
  return calls.find((e) => e.method === 'PATCH' && e.body != null && COPY_KEYS.some((k) => k in (e.body as Record<string, unknown>)));
}
function anyCopyPatch(calls: ApiCall[]) { return copyPatch(calls); }
function localizedPatch(calls: ApiCall[]) {
  return calls.find((e) => e.method === 'PATCH' && e.body != null && 'localized_content' in (e.body as Record<string, unknown>));
}

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });
afterEach(() => vi.unstubAllGlobals());

describe('PUT /api/forms-advanced/:id — form-jp-localization 文言', () => {
  test('formCopy 提供 → meta PATCH body に文言キーが合流し definition_json に永続・out_of_sync でない', async () => {
    seedForm('k1', 'SLUGK1');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/k1', {
      fields: [], logic: [],
      formCopy: { buttonText: '送信', successMessage: 'ありがとうございました', errorMessage: '送信に失敗しました' },
    });
    expect(res.status).toBe(200);
    const patch = copyPatch(calls);
    expect(patch?.body).toMatchObject({ button_text: '送信', success_message: 'ありがとうございました', error_message: '送信に失敗しました' });
    // definition_json は canonical (buttonText 等) で永続。
    expect(definitionOf('k1').formCopy).toEqual({ buttonText: '送信', successMessage: 'ありがとうございました', errorMessage: '送信に失敗しました' });
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).not.toBe('out_of_sync');
  });

  test('formCopy 未提供 → meta PATCH body に文言キー不在・definition_json に formCopy キー不在 (後方互換)', async () => {
    seedForm('k2', 'SLUGK2');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/k2', { fields: [], logic: [], title: '新題' });
    expect(res.status).toBe(200);
    expect(anyCopyPatch(calls)).toBeUndefined(); // 文言キーを 1 つも送っていない
    expect('formCopy' in definitionOf('k2')).toBe(false);
  });

  test('D-1 後方互換: formCopy を持つフォームへの formCopy 未提供 save は definition_json 生バイト完全一致 (idempotent)', async () => {
    // buildDefinitionJson は formalooAddress/logicFingerprint を必ず正規化して書くため、route 自身が
    // canonicalize した状態を基準に「formCopy 未提供 save の前後で raw string が 1 byte も変わらない」を証明する。
    seedForm('k3', 'SLUGK3');
    stubFormaloo();
    // save 1: formCopy を set して canonicalize + 永続。
    await call('PUT', '/api/forms-advanced/k3', { fields: [], logic: [], formCopy: { buttonText: '送信' } });
    const before = rawDefinitionOf('k3');
    // save 2: formCopy 未提供 (builder が文言を触っていない) → prev を carry。
    const res = await call('PUT', '/api/forms-advanced/k3', { fields: [], logic: [] });
    expect(res.status).toBe(200);
    const after = rawDefinitionOf('k3');
    expect(after).toBe(before); // 生バイト完全一致 (キー不在検査でなく raw string 一致)
    expect(definitionOf('k3').formCopy).toEqual({ buttonText: '送信' }); // prev 文言は carry
  });

  test('partial merge: prev formCopy + incoming set key → merge 永続・prev を消さない', async () => {
    const seeded = JSON.stringify({ fields: [], logic: [], formCopy: { successMessage: '完了しました' } });
    seedForm('k4', 'SLUGK4', seeded);
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/k4', {
      fields: [], logic: [],
      formCopy: { buttonText: '送信', successMessage: '', errorMessage: '' }, // buttonText だけ新規・他は空欄
    });
    expect(res.status).toBe(200);
    // prev successMessage は保持され buttonText が追加される (空欄=未指定=触らない → 誤消去しない)。
    expect(definitionOf('k4').formCopy).toEqual({ successMessage: '完了しました', buttonText: '送信' });
    // meta PATCH は merged 文言を原子送 (self-heal parity w/ design)。
    expect(copyPatch(calls)?.body).toMatchObject({ button_text: '送信', success_message: '完了しました' });
  });

  test('D-4a soft-200: 文言 PATCH が無言無視され GET-after-PATCH 不一致 → out_of_sync (殻完了防止)', async () => {
    seedForm('k5', 'SLUGK5');
    stubFormaloo({ softIgnore: true });
    const res = await call('PUT', '/api/forms-advanced/k5', { fields: [], logic: [], formCopy: { buttonText: '送信' } });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync');
    expect(data.syncError).toEqual(expect.any(String));
  });

  test('D-4b bounded retry で反映収束 → out_of_sync でない (eventual consistency)', async () => {
    seedForm('k6', 'SLUGK6');
    stubFormaloo({ reflectAfterGet: 2 });
    const res = await call('PUT', '/api/forms-advanced/k6', { fields: [], logic: [], formCopy: { buttonText: '送信' } });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).not.toBe('out_of_sync');
  });

  test('D-3 on_submit_message を触らない: どの PATCH body にも on_submit_message 系キーが無い', async () => {
    seedForm('k7', 'SLUGK7');
    const calls = stubFormaloo();
    await call('PUT', '/api/forms-advanced/k7', { fields: [], logic: [], formCopy: { successMessage: 'ありがとう' } });
    const touched = calls.some((e) => e.body != null && Object.keys(e.body as Record<string, unknown>).some((k) => /on_submit_message|submit_message/.test(k)));
    expect(touched).toBe(false);
  });

  test('文言 GET-after mock は実 Formaloo 応答 shape (data.form.*) — 一致で idle', async () => {
    seedForm('k8', 'SLUGK8');
    // stub は PATCH した文言を data.form.* に round-trip する (base extractForm と同 shape)。
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/k8', { fields: [], logic: [], formCopy: { errorMessage: 'エラー' } });
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).not.toBe('out_of_sync');
  });
});

// =============================================================================
// form-copy-sync-warning-fix (T-B1〜T-B4) — Formaloo server-side 正規化 × route sync 判定
// -----------------------------------------------------------------------------
// owner が打った全角値 (受付完了！) は Formaloo が半角 (受付完了!) に fold して保存する。従来の strict 等値だと
//   恒久不一致で out_of_sync 誤警告になっていた。confirmFormCopyReflected の正規化耐性化により、正規化差だけの
//   反映は idle に解消する (誤警告除去)。ただし真の未反映・design/画像の実失敗は依然 out_of_sync (fail-closed 温存)。
// =============================================================================
describe('PUT /api/forms-advanced/:id — form-copy-sync-warning-fix (正規化 × sync 判定)', () => {
  test('T-B1/AC-4a: formCopy 全角値を保存 → Formaloo が fold した半角値を GET → 正規化一致で syncStatus:idle (誤警告除去)', async () => {
    seedForm('kb1', 'SLUGKB1');
    stubFormaloo({ foldCopy: true }); // Formaloo の全角→半角 fold を模倣
    const res = await call('PUT', '/api/forms-advanced/kb1', {
      fields: [], logic: [], formCopy: { successMessage: '受付完了！' }, // owner が打った全角！ (U+FF01)
    });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).toBe('idle'); // 正規化差だけの反映を out_of_sync にしない
  });

  test('T-B2/AC-4b: mock GET が英語既定 Thanks! submitted successfully を返す (真の未反映) → out_of_sync + lastError (fail-closed 温存)', async () => {
    seedForm('kb2', 'SLUGKB2');
    // softIgnore: 送った文言が反映されず、GET は既定英語のまま返る = 真の未反映。
    stubFormaloo({ getForm: { success_message: 'Thanks! submitted successfully' }, softIgnore: true });
    const res = await call('PUT', '/api/forms-advanced/kb2', {
      fields: [], logic: [], formCopy: { successMessage: '受付完了！' },
    });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync');
    expect(data.syncError).toEqual(expect.any(String));
  });

  test('T-B3 honest-idle: 今すぐ同期 (onSave 再実行=copy 再送) → confirm が実行され正規化一致で idle (confirm skip でない)', async () => {
    seedForm('kb3', 'SLUGKB3');
    const calls = stubFormaloo({ foldCopy: true });
    const res = await call('PUT', '/api/forms-advanced/kb3', {
      fields: [], logic: [], formCopy: { successMessage: '受付完了！' },
    });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).toBe('idle');
    // 「今すぐ同期」は既存 onSave 経路の再実行 (新 endpoint なし)。idle は confirm skip でなく
    //   confirmFormCopyReflected の GET-after-PATCH が実行され一致した結果であることを証跡で assert。
    const confirmGets = calls.filter((e) => e.method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(e.url));
    expect(confirmGets.length).toBeGreaterThanOrEqual(1);
  });

  test('T-B3 非退行: reload 後 formCopy 非載 (formCopyProvided=false) → confirm skip・idle (今日と挙動不変)', async () => {
    // 画面 reload 後は builder が保存済 copy を pull しないため formCopy が payload に載らない (pull backlog の限界)。
    //   本案件は「その経路の挙動を今日から変えない (非退行)」に留める。値は実反映済ゆえ実害なし。
    const seeded = JSON.stringify({ fields: [], logic: [], formCopy: { successMessage: '受付完了！' } });
    seedForm('kb3b', 'SLUGKB3B', seeded);
    const calls = stubFormaloo({ foldCopy: true });
    const res = await call('PUT', '/api/forms-advanced/kb3b', { fields: [], logic: [] }); // formCopy 非載
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).toBe('idle');
    // 文言 PATCH を 1 つも送らない = confirm 経路に触れない (skip) = 新規 hollow-clear を作らない。
    expect(anyCopyPatch(calls)).toBeUndefined();
  });

  test('T-B4 複合失敗: copy 正規化差 (本来 idle) + design 実失敗 が同時 → out_of_sync (idle にならない・優先順位)', async () => {
    seedForm('kb4', 'SLUGKB4');
    // foldCopy=true: copy は Formaloo fold で正規化一致 (単独なら idle)。
    // stub は design 色を state に round-trip しない → confirmDesignReflected が不一致 = design 実失敗。
    const calls = stubFormaloo({ foldCopy: true });
    const res = await call('PUT', '/api/forms-advanced/kb4', {
      fields: [], logic: [],
      formCopy: { successMessage: '受付完了！' }, // fold で一致 → copy 単独なら idle
      design: { buttonColor: '#00ff00' },         // stub は反映しない → designReflectError
    });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    // 優先順位 (!metaRes.ok→compoundEditWarning→imageSyncError→designReflectError→formCopyReflectError→idle):
    //   copy が idle-worthy でも design 失敗が勝ち out_of_sync (いずれか異常なら owner は警告を見る = 正しい非ブロッカー)。
    expect(data.syncStatus).toBe('out_of_sync');
    expect(data.syncError).toEqual(expect.any(String));
    // copy 文言 PATCH は送られている (design と同一 meta PATCH に合流) = copy 経路も実行された証跡。
    expect(copyPatch(calls)).toBeDefined();
  });
});

describe('PUT /api/forms-advanced/:id — localized_content 日本語 UI chrome', () => {
  test('localizationJa=true は現行 localized_content へ管理 key だけを merge し、foreign/nested key と flag を保持する', async () => {
    seedForm('lj1', 'SLUGLJ1');
    const foreign = { tenant_banner: '残す', errors: { required: '独自必須文言' } };
    const calls = stubFormaloo({
      getForm: {
        localized_content: foreign,
        combined_localized_content: { next_btn: 'Next', errors: { required: 'Required' } },
      },
    });

    const res = await call('PUT', '/api/forms-advanced/lj1', { fields: [], logic: [], localizationJa: true });

    expect(res.status).toBe(200);
    expect(localizedPatch(calls)?.body).toMatchObject({
      localized_content: { ...foreign, ...JP_LOCALIZED_CONTENT },
    });
    expect(definitionOf('lj1').localizationJa).toBe(true);
    const data = (await res.json() as { data: { localizationJa: boolean; syncStatus: string } }).data;
    expect(data.localizationJa).toBe(true);
    expect(data.syncStatus).toBe('idle');
  });

  test('localizationJa=false は管理 key だけを解除し、foreign/nested key を破壊しない', async () => {
    seedForm('lj2', 'SLUGLJ2', JSON.stringify({ fields: [], logic: [], localizationJa: true }));
    const foreign = { tenant_banner: '残す', errors: { required: '独自必須文言' } };
    const calls = stubFormaloo({ getForm: { localized_content: { ...foreign, ...JP_LOCALIZED_CONTENT } } });

    const res = await call('PUT', '/api/forms-advanced/lj2', { fields: [], logic: [], localizationJa: false });

    expect(res.status).toBe(200);
    expect(localizedPatch(calls)?.body).toMatchObject({ localized_content: foreign });
    const sent = (localizedPatch(calls)?.body as { localized_content: Record<string, unknown> }).localized_content;
    for (const key of MANAGED_LOCALIZATION_KEYS) expect(key in sent).toBe(false);
    expect(definitionOf('lj2').localizationJa).toBe(false);
    expect((await res.json() as { data: { localizationJa: boolean } }).data.localizationJa).toBe(false);
  });

  test('localizationJa 未指定の再保存は PATCH せず、保存済 flag を carry して definition JSON 生バイトが一致する', async () => {
    seedForm('lj3', 'SLUGLJ3');
    const calls = stubFormaloo({ getForm: { localized_content: {} } });
    await call('PUT', '/api/forms-advanced/lj3', { fields: [], logic: [], localizationJa: true });
    const before = rawDefinitionOf('lj3');
    const patchCount = calls.filter((call) => call.body != null && 'localized_content' in (call.body as Record<string, unknown>)).length;

    const res = await call('PUT', '/api/forms-advanced/lj3', { fields: [], logic: [] });

    expect(res.status).toBe(200);
    expect(rawDefinitionOf('lj3')).toBe(before);
    expect(definitionOf('lj3').localizationJa).toBe(true);
    expect(calls.filter((call) => call.body != null && 'localized_content' in (call.body as Record<string, unknown>))).toHaveLength(patchCount);
  });

  test("FORMALOO_LOCALIZATION_DISABLE='1' は flag 永続化・localized_content 通信を byte 同等に短絡する", async () => {
    seedForm('lj4', 'SLUGLJ4');
    const calls = stubFormaloo({ getForm: { localized_content: { foreign: '残す' } } });
    const disabled = { FORMALOO_LOCALIZATION_DISABLE: '1' } as Partial<Env['Bindings']>;
    await call('PUT', '/api/forms-advanced/lj4', { fields: [], logic: [] }, disabled);
    const before = rawDefinitionOf('lj4');
    const patchCount = calls.filter((call) => call.body != null && 'localized_content' in (call.body as Record<string, unknown>)).length;

    const res = await call('PUT', '/api/forms-advanced/lj4', { fields: [], logic: [], localizationJa: true }, disabled);

    expect(res.status).toBe(200);
    expect(rawDefinitionOf('lj4')).toBe(before);
    expect('localizationJa' in definitionOf('lj4')).toBe(false);
    expect(calls.filter((call) => call.body != null && 'localized_content' in (call.body as Record<string, unknown>))).toHaveLength(patchCount);
  });

  test('localized_content PATCH の soft-200 未反映は GET-after-PATCH で out_of_sync にする', async () => {
    seedForm('lj5', 'SLUGLJ5');
    stubFormaloo({ getForm: { localized_content: { foreign: '残す' } }, softIgnoreLocalization: true });

    const res = await call('PUT', '/api/forms-advanced/lj5', { fields: [], logic: [], localizationJa: true });

    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync');
    expect(data.syncError).toContain('日本語 UI');
  });
});
