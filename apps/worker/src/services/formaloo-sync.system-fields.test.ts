import { describe, test, expect } from 'vitest';
import { pushDefinitionToFormaloo } from './formaloo-sync';
import type { FormalooClient, FormalooResult } from './formaloo-client';

// =============================================================================
// fr-id-capture-fix / T-C3 (+ D-4 rollback): pushDefinitionToFormaloo が field upsert 直後に
//   friend system hidden field を冪等 auto-push する配線を検証する。
//   - ensureSystemFields=true → GET fields_list → 無い alias を POST /v3.0/fields/ → PushResult に surface。
//   - ensureSystemFields 未指定(default false) → GET/POST 一切なし・PushResult.systemFields 無 (byte 同等 / rollback)。
//   - includeOwnerGatedSystemFields=false → fr_name(PII) を push しない (owner-gate)。
//   - 衝突 → systemFieldsOutOfSync=true (回答導線=push 本体は ok を維持・system は out_of_sync surface)。
// =============================================================================

interface RawField { slug: string; alias?: string | null; type?: string; title?: string }

function mockClient(cfg: { fields: RawField[]; postMode?: 'append' | 'fail'; formGetOk?: boolean }) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const state = [...cfg.fields];
  const postMode = cfg.postMode ?? 'append';
  const formGetOk = cfg.formGetOk ?? true;
  const client = {
    async get<T>(path: string): Promise<FormalooResult<T>> {
      calls.push({ method: 'GET', path });
      // T-C3 round2: ensure の form-state GET (/v3.0/forms/{slug}/) を失敗させ silent-success 是正を route 手前で検証する。
      if (!formGetOk && /\/v3\.0\/forms\/[^/]+\/$/.test(path)) return { ok: false, status: 500, error: 'boom' } as FormalooResult<T>;
      return { ok: true, status: 200, data: { data: { form: { fields_list: state.map((f) => ({ ...f })) } } } } as unknown as FormalooResult<T>;
    },
    async post<T>(path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method: 'POST', path, body });
      const b = (body ?? {}) as { alias?: string; type?: string };
      if (postMode === 'fail') return { ok: false, status: 500, error: 'boom' } as FormalooResult<T>;
      state.push({ slug: `new_${b.alias}`, alias: b.alias, type: b.type ?? 'hidden' });
      return { ok: true, status: 201, data: { data: { field: { slug: `new_${b.alias}` } } } } as unknown as FormalooResult<T>;
    },
    async request<T>(method: string, path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method, path, body });
      return { ok: true, status: 200, data: {} } as FormalooResult<T>;
    },
  } as unknown as FormalooClient;
  return { client, calls };
}

const BASE = { formalooSlug: 'FSLUG', title: 'テスト', fields: [], logic: [] };

describe('pushDefinitionToFormaloo — system field auto-push (T-C3)', () => {
  test('ensureSystemFields=true: fr_id/fr_name 無 → POST /v3.0/fields/ で ensure → PushResult に surface (systemFieldsOk)', async () => {
    const { client, calls } = mockClient({ fields: [{ slug: 's1', type: 'short_text', title: '名前' }] });
    const r = await pushDefinitionToFormaloo(client, { ...BASE, ensureSystemFields: true });
    expect(r.ok).toBe(true);
    expect(r.systemFieldsOk).toBe(true);
    expect(r.systemFieldsOutOfSync).toBe(false);
    const sysPosts = calls.filter((c) => c.method === 'POST' && c.path === '/v3.0/fields/');
    expect(sysPosts.map((c) => (c.body as { alias?: string }).alias).sort()).toEqual(['fr_id', 'fr_name']);
    // hidden + form 紐付けの payload
    expect(sysPosts.every((c) => (c.body as { type?: string }).type === 'hidden')).toBe(true);
    expect(sysPosts.every((c) => (c.body as { form?: string }).form === 'FSLUG')).toBe(true);
  });

  test('D-4 rollback: ensureSystemFields 未指定(default) → GET/POST 一切なし・systemFields 無 (byte 同等)', async () => {
    const { client, calls } = mockClient({ fields: [{ slug: 's1', type: 'short_text' }] });
    const r = await pushDefinitionToFormaloo(client, { ...BASE });
    expect(r.ok).toBe(true);
    expect(r.systemFields).toBeUndefined();
    expect(r.systemFieldsOk).toBeUndefined();
    // GET /v3.0/forms/FSLUG/ (ensure の fields_list 取得) も POST /v3.0/fields/ も無い
    expect(calls.some((c) => c.method === 'GET' && c.path === '/v3.0/forms/FSLUG/')).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v3.0/fields/')).toBe(false);
  });

  test('owner-gate: includeOwnerGatedSystemFields=false → fr_id のみ push (fr_name を作らない)', async () => {
    const { client, calls } = mockClient({ fields: [] });
    const r = await pushDefinitionToFormaloo(client, { ...BASE, ensureSystemFields: true, includeOwnerGatedSystemFields: false });
    expect(r.systemFieldsOk).toBe(true);
    const sysPosts = calls.filter((c) => c.method === 'POST' && c.path === '/v3.0/fields/');
    expect(sysPosts.map((c) => (c.body as { alias?: string }).alias)).toEqual(['fr_id']);
    expect(sysPosts.some((c) => (c.body as { alias?: string }).alias === 'fr_name')).toBe(false);
  });

  test('衝突/失敗: system field POST 失敗 → push 本体は ok・systemFieldsOutOfSync=true (silent success 禁止)', async () => {
    const { client } = mockClient({ fields: [], postMode: 'fail' });
    const r = await pushDefinitionToFormaloo(client, { ...BASE, ensureSystemFields: true });
    expect(r.ok).toBe(true); // 回答導線 (push 本体) は落とさない
    expect(r.systemFieldsOk).toBe(false);
    expect(r.systemFieldsOutOfSync).toBe(true);
  });

  test('衝突: alias=fr_id が visible(short_text) → 自動修復せず systemFieldsOutOfSync (fail-closed)', async () => {
    const { client, calls } = mockClient({ fields: [{ slug: 'u1', alias: 'fr_id', type: 'short_text', title: 'user 作成' }] });
    const r = await pushDefinitionToFormaloo(client, { ...BASE, ensureSystemFields: true, includeOwnerGatedSystemFields: false });
    expect(r.ok).toBe(true);
    expect(r.systemFieldsOutOfSync).toBe(true);
    // 衝突 field を mutate しない (PATCH/DELETE/POST /v3.0/fields/ なし)
    expect(calls.some((c) => c.method === 'PATCH' && c.path.startsWith('/v3.0/fields/'))).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v3.0/fields/')).toBe(false);
  });

  test('T-C3 round2: ensure の form-state GET 失敗 → push 本体は ok・systemFieldsOutOfSync=true (silent-success 禁止)', async () => {
    const { client } = mockClient({ fields: [], formGetOk: false });
    const r = await pushDefinitionToFormaloo(client, { ...BASE, ensureSystemFields: true });
    expect(r.ok).toBe(true); // 回答導線 (push 本体) は落とさない
    expect(r.systemFieldsOk).toBe(false);
    expect(r.systemFieldsOutOfSync).toBe(true); // fetch 失敗を idle(成功) 扱いにせず surface
  });
});

// =============================================================================
// fr-id-hardening-round2 / ③ alias=slug 標準付与: createField が新規 field POST 応答 slug で PATCH {alias:slug} を付与し
//   /fo の slug-keyed 回答 prefill を成立させる。default off は byte 同等・alias PATCH は fail-soft。
// =============================================================================
function aliasClient(cfg: { fieldPostOk?: boolean; aliasPatchOk?: boolean } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let fieldCounter = 0;
  const client = {
    async get<T>(path: string): Promise<FormalooResult<T>> {
      calls.push({ method: 'GET', path });
      return { ok: true, status: 200, data: { data: { form: { fields_list: [] } } } } as unknown as FormalooResult<T>;
    },
    async post<T>(path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method: 'POST', path, body });
      if (/\/v3\.0\/forms\/$/.test(path)) {
        return { ok: true, status: 201, data: { data: { form: { slug: 'FSLUG', full_form_address: 'https://x.formaloo.me/a' } } } } as unknown as FormalooResult<T>;
      }
      if (cfg.fieldPostOk === false) return { ok: false, status: 500, error: 'boom' } as FormalooResult<T>;
      const slug = `f_${fieldCounter++}`;
      return { ok: true, status: 201, data: { data: { field: { slug } } } } as unknown as FormalooResult<T>;
    },
    async request<T>(method: string, path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method, path, body });
      if (method === 'PATCH' && /\/v3\.0\/fields\/[^/]+\/$/.test(path) && cfg.aliasPatchOk === false) {
        return { ok: false, status: 500, error: 'boom' } as FormalooResult<T>;
      }
      return { ok: true, status: 200, data: {} } as FormalooResult<T>;
    },
  } as unknown as FormalooClient;
  return { client, calls };
}

const NEWFORM = { formalooSlug: null, title: 'テスト', fields: [{ id: 'q1', type: 'text' as const, label: '名前', required: true, config: {} }], logic: [] };

describe('pushDefinitionToFormaloo — alias=slug 標準付与 (③)', () => {
  test('setFieldAlias:true: 新規 field POST → 応答 slug で PATCH {alias:slug} を付与', async () => {
    const { client, calls } = aliasClient();
    const r = await pushDefinitionToFormaloo(client, { ...NEWFORM, setFieldAlias: true });
    expect(r.ok).toBe(true);
    const fieldPost = calls.find((c) => c.method === 'POST' && c.path === '/v3.0/fields/');
    expect(fieldPost).toBeTruthy();
    // POST 応答 slug (f_0) に対し PATCH /v3.0/fields/f_0/ {alias:'f_0'}
    const aliasPatch = calls.find((c) => c.method === 'PATCH' && c.path === '/v3.0/fields/f_0/');
    expect(aliasPatch).toBeTruthy();
    expect(aliasPatch!.body).toEqual({ alias: 'f_0' });
    expect(r.fieldSlugs?.q1).toBe('f_0');
  });

  test('default (setFieldAlias 未指定): alias PATCH 無し (byte 同等 / rollback)', async () => {
    const { client, calls } = aliasClient();
    const r = await pushDefinitionToFormaloo(client, { ...NEWFORM });
    expect(r.ok).toBe(true);
    // /v3.0/fields/{slug}/ への alias PATCH を一切出さない
    expect(calls.some((c) => c.method === 'PATCH' && /\/v3\.0\/fields\/[^/]+\/$/.test(c.path))).toBe(false);
  });

  test('alias PATCH fail-soft: PATCH 500 でも push は ok (field 作成は成立・prefill は backfill 待ち)', async () => {
    const { client, calls } = aliasClient({ aliasPatchOk: false });
    const r = await pushDefinitionToFormaloo(client, { ...NEWFORM, setFieldAlias: true });
    expect(r.ok).toBe(true); // alias PATCH 失敗は publish を落とさない
    expect(r.fieldSlugs?.q1).toBe('f_0'); // field 自体は作成済
    // PATCH は試みる (fail-soft = 握り潰しでなく試行後 warn)
    expect(calls.some((c) => c.method === 'PATCH' && c.path === '/v3.0/fields/f_0/')).toBe(true);
  });
});
