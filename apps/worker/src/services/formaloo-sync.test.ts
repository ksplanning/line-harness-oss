/**
 * T-B2 (F-2) — push-sync 配線: harness 定義 → Formaloo API payload マッピングを client 経由で送る。
 *   - field は toFormalooFieldPayload (short_text/max_length 等) で送る
 *   - logic は Formaloo field slug ベースに解決して送る
 *   - fail-soft: どこかで失敗したら {ok:false} を返す (throw しない / N-6)
 * (実 Formaloo への push→pull 一致 = N-8 は browser-evaluator/live で E2E 確認。ここは wiring を固定。)
 */
import { describe, test, expect } from 'vitest';
import { pushDefinitionToFormaloo } from './formaloo-sync';
import type { FormalooResult } from './formaloo-client';
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared';

function mockClient(script: {
  post?: Array<() => FormalooResult>;
  put?: Array<() => FormalooResult>;
  request?: Array<() => FormalooResult>;
}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = {
    async post<T>(path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method: 'POST', path, body });
      const next = script.post?.shift();
      return (next ? next() : { ok: true, status: 200, data: {} }) as FormalooResult<T>;
    },
    async put<T>(path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method: 'PUT', path, body });
      const next = script.put?.shift();
      return (next ? next() : { ok: true, status: 200, data: {} }) as FormalooResult<T>;
    },
    // form-route-branching T-C1: logic push は client.request('PATCH', ...) 経由 (bare-array)。
    async request<T>(method: string, path: string, body?: unknown): Promise<FormalooResult<T>> {
      calls.push({ method, path, body });
      const next = script.request?.shift();
      return (next ? next() : { ok: true, status: 200, data: {} }) as FormalooResult<T>;
    },
  } as unknown as import('./formaloo-client').FormalooClient;
  return { client, calls };
}

const fields: HarnessField[] = [
  { id: 'h1', type: 'text', label: '名前', required: true, position: 0, config: { maxLength: 30 } },
  { id: 'h2', type: 'choice', label: '性別', required: true, position: 1, config: { choices: ['男', '女'] } },
];
const logic: HarnessLogicRule[] = [
  { id: 'r1', sourceFieldId: 'h2', operator: 'equals', value: '男', action: 'show', targetFieldId: 'h1' },
];

describe('pushDefinitionToFormaloo — 新規 form', () => {
  test('form 作成 → field を mapped payload で push → logic を slug ベースで push', async () => {
    const { client, calls } = mockClient({
      post: [
        () => ({ ok: true, status: 201, data: { data: { form: { slug: 'FORMSLUG', full_form_address: 'https://forms.formaloo.net/FORMSLUG' } } } }),
        () => ({ ok: true, status: 201, data: { data: { field: { slug: 'FS1' } } } }),
        () => ({ ok: true, status: 201, data: { data: { field: { slug: 'FS2' } } } }),
      ],
      put: [() => ({ ok: true, status: 200, data: {} })],
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: null, title: 'テスト', fields, logic });
    expect(r.ok).toBe(true);
    expect(r.formalooSlug).toBe('FORMSLUG');
    expect(r.fieldSlugs).toEqual({ h1: 'FS1', h2: 'FS2' });
    expect(r.publicAddress).toBe('https://forms.formaloo.net/FORMSLUG');

    // form 作成呼び出し
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v3.0/forms/', body: { title: 'テスト' } });
    expect(calls[0].body).toEqual({ title: 'テスト' }); // description 未指定の既存 caller は byte-equivalent
    // field 作成は top-level /v3.0/fields/ へ POST し、form slug は URL でなく body で紐づく。
    // 旧実装 /v3.0/forms/{slug}/fields/ は本番 Formaloo API に存在せず HTTP 404 だった (本番 404 回帰ガード)。
    expect(calls[1].path).toBe('/v3.0/fields/');
    expect(calls[1].body).toMatchObject({ form: 'FORMSLUG', type: 'short_text', title: '名前', max_length: 30, required: true });
    expect(calls[2].path).toBe('/v3.0/fields/');
    // choice の選択肢は Formaloo writeOnly `choice_items` ([{title}]) で送る (live 実証 2026-07-10)。
    // 旧 `choices: string[]` は実 API に無視され選択肢が落ちていた (silent data loss / latent defect 回帰ガード)。
    expect(calls[2].body).toMatchObject({ form: 'FORMSLUG', type: 'choice', title: '性別', choice_items: [{ title: '男' }, { title: '女' }] });
    expect((calls[2].body as Record<string, unknown>).choices).toBeUndefined();
    // form-route-branching T-C1: 編集 logic は R0 bare-array を PATCH で送る (旧 PUT {logic:{rules}} は本番 500)。
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/v3.0/forms/FORMSLUG/')).toBe(false);
    const patchCall = calls.find((c) => c.method === 'PATCH' && c.path === '/v3.0/forms/FORMSLUG/')!;
    const arr = (patchCall.body as { logic: unknown[] }).logic;
    // R0 item: source(FS2) identifier / actions.args identifier=target(FS1) / when.args value=source(FS2)
    expect(arr).toEqual([
      {
        type: 'field', identifier: 'FS2',
        actions: [
          {
            action: 'show',
            args: [{ type: 'field', identifier: 'FS1' }],
            // h2 は choice だが新規 form で choiceItems 無 (case-b) → constant 近似
            when: { operation: 'is', args: [{ type: 'field', value: 'FS2' }, { type: 'constant', value: '男' }] },
          },
        ],
      },
    ]);
  });

  test('T-C1: choice source が choiceItems を持つ既存 form → PATCH bare-array の when を {type:choice,value:slug} で生成 (fieldby 経由 / hosted 発火)', async () => {
    const choiceSrc: HarnessField = {
      id: 'q1', type: 'choice', label: 'ルート', required: true, position: 0,
      config: { choices: ['A', 'C'], choiceItems: [{ title: 'A', slug: 'ciA' }, { title: 'C', slug: 'ciC' }] },
    };
    const pageC: HarnessField = { id: 'p3', type: 'page_break', label: '', required: false, position: 1, config: {} };
    const jumpLogic: HarnessLogicRule[] = [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'C', action: 'jump', targetFieldId: 'p3' },
    ];
    const { client, calls } = mockClient({});
    const r = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'EXIST', title: 't', fields: [choiceSrc, pageC], logic: jumpLogic,
      existingFieldSlugs: { q1: 'FSq1', p3: 'FSp3' },
    });
    expect(r.ok).toBe(true);
    const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/v3.0/forms/EXIST/')!;
    const arr = (patch.body as { logic: any[] }).logic;
    expect(arr[0].actions[0].action).toBe('jump');
    expect(arr[0].actions[0].args).toEqual([{ type: 'field', identifier: 'FSp3' }]);
    // rule.value 'C' → choiceItems の slug 'ciC' に写像され choice operand で発火
    expect(arr[0].actions[0].when.args[1]).toEqual({ type: 'choice', value: 'ciC' });
  });

  test('description が明示された初回保存は form POST に title+description を送る (T-B12)', async () => {
    const { client, calls } = mockClient({
      post: [
        () => ({ ok: true, status: 201, data: { data: { form: { slug: 'FORM_WITH_DESCRIPTION' } } } }),
      ],
    });

    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: null,
      title: '現在タイトル',
      description: '現在説明',
      fields: [],
      logic: [],
    });

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual({
      method: 'POST', path: '/v3.0/forms/', body: { title: '現在タイトル', description: '現在説明' },
    });
  });
});

describe('pushDefinitionToFormaloo — fail-soft (N-6)', () => {
  test('form 作成失敗 → {ok:false}', async () => {
    const { client } = mockClient({ post: [() => ({ ok: false, status: 500, error: 'boom' })] });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: null, title: 't', fields, logic });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('form create failed');
  });
  test('field push 失敗 → {ok:false, formalooSlug 付き} (部分失敗 = out_of_sync 判定材料 / N-13)', async () => {
    const { client } = mockClient({
      post: [
        () => ({ ok: true, status: 201, data: { data: { form: { slug: 'S' } } } }),
        () => ({ ok: false, status: 400, error: 'bad field' }),
      ],
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: null, title: 't', fields, logic });
    expect(r.ok).toBe(false);
    expect(r.formalooSlug).toBe('S');
    expect(r.error).toContain('field push failed');
  });
  test('既存 form + 未知 field は form 作成をスキップし probe(404)→POST で作成 (top-level endpoint / body で form 紐づけ)', async () => {
    // 冪等化後: formalooSlug 既存 (formPreExisted) かつ existingFieldSlugs 未渡し → 各 field を probe。
    // probe 404 (真の新規) → POST /v3.0/fields/ で作成 (form 作成は skip)。旧「常に POST」の spirit を継承しつつ probe 経路化。
    const { client, calls } = upsertMock(({ method, path }) => {
      if (method === 'GET') return { ok: false, status: 404, error: 'not found' }; // probe: 未存在
      if (method === 'POST' && path === '/v3.0/fields/') return { ok: true, status: 201, data: { data: { field: { slug: 'FSx' } } } };
      if (method === 'PUT') return { ok: true, status: 200, data: {} };
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: 'EXISTING', title: 't', fields, logic });
    expect(r.ok).toBe(true);
    expect(r.formalooSlug).toBe('EXISTING');
    // form 作成 (POST /v3.0/forms/) は叩かない
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v3.0/forms/')).toBe(false);
    // field は top-level /v3.0/fields/ へ POST し、既存 slug を body の form で紐づける
    const fieldPost = calls.find((c) => c.method === 'POST' && c.path === '/v3.0/fields/')!;
    expect(fieldPost.body).toMatchObject({ form: 'EXISTING', type: 'short_text' });
  });
});

// =============================================================================
// push upsert 冪等化 (formaloo-push-idempotency / T-A1・T-A2) — update-vs-create で
// field 重複作成を根絶。mock client は method+exact path+body を記録する handler 型。
// =============================================================================

type MockResp = FormalooResult;
/** handler(method,path,body)→FormalooResult を返し全 call を記録する mock (probe GET / PATCH / POST / PUT を統一記録)。 */
function upsertMock(handler: (call: { method: string; path: string; body?: unknown }) => MockResp) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const run = (method: string, path: string, body?: unknown) => {
    const call = { method, path, body };
    calls.push(call);
    return handler(call);
  };
  const client = {
    async get<T>(path: string) { return run('GET', path) as FormalooResult<T>; },
    async post<T>(path: string, body?: unknown) { return run('POST', path, body) as FormalooResult<T>; },
    async put<T>(path: string, body?: unknown) { return run('PUT', path, body) as FormalooResult<T>; },
    async request<T>(method: string, path: string, body?: unknown) { return run(method, path, body) as FormalooResult<T>; },
  } as unknown as import('./formaloo-client').FormalooClient;
  return { client, calls };
}

const textField: HarnessField = { id: 'h1', type: 'text', label: '名前', required: true, position: 0, config: { maxLength: 30 } };
const choiceField: HarnessField = { id: 'h2', type: 'choice', label: '性別', required: true, position: 1, config: { choices: ['男', '女'] } };
const sectionField = {
  id: 'decor_section', type: 'section', label: 'ご案内', required: false, position: 0, config: { text: '本文です' },
} as unknown as HarnessField;
const pageBreakField = {
  id: 'decor_page', type: 'page_break', label: '改ページ', required: false, position: 1, config: {},
} as unknown as HarnessField;

describe('pushDefinitionToFormaloo — decoration meta (T-B3)', () => {
  test('section/page_break を通常 field と同じ POST /v3.0/fields/ 経路で meta/sub_type として作成する', async () => {
    let fieldNo = 0;
    const { client, calls } = upsertMock(({ method, path }) => {
      if (method === 'POST' && path === '/v3.0/forms/') {
        return { ok: true, status: 201, data: { data: { form: { slug: 'DECOR_FORM' } } } };
      }
      if (method === 'POST' && path === '/v3.0/fields/') {
        fieldNo += 1;
        return { ok: true, status: 201, data: { data: { field: { slug: `META_${fieldNo}` } } } };
      }
      return { ok: true, status: 200, data: {} };
    });

    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: null, title: '装飾フォーム', fields: [sectionField, pageBreakField], logic: [],
    });

    expect(result.ok).toBe(true);
    const posts = calls.filter((call) => call.method === 'POST' && call.path === '/v3.0/fields/');
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toMatchObject({
      form: 'DECOR_FORM', type: 'meta', sub_type: 'section', title: 'ご案内', description: '本文です', position: 0,
    });
    expect(posts[1].body).toMatchObject({
      form: 'DECOR_FORM', type: 'meta', sub_type: 'page_break', position: 1,
    });
    expect(posts.some((call) => ['section', 'page_break'].includes(String((call.body as { type?: unknown }).type)))).toBe(false);
  });

  test('slug 既知の decoration は既存 PATCH /v3.0/fields/{slug}/ 経路で meta のまま更新する', async () => {
    const { client, calls } = upsertMock(() => ({ ok: true, status: 200, data: {} }));

    const result = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'DECOR_FORM', title: '装飾フォーム', fields: [sectionField, pageBreakField], logic: [],
      existingFieldSlugs: { decor_section: 'SECTION_SLUG', decor_page: 'PAGE_SLUG' },
    });

    expect(result.ok).toBe(true);
    const patches = calls.filter((call) => call.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({
      path: '/v3.0/fields/SECTION_SLUG/',
      body: { type: 'meta', sub_type: 'section', title: 'ご案内', description: '本文です' },
    });
    expect(patches[1]).toMatchObject({
      path: '/v3.0/fields/PAGE_SLUG/',
      body: { type: 'meta', sub_type: 'page_break' },
    });
    expect(calls.some((call) => call.method === 'POST' && call.path === '/v3.0/fields/')).toBe(false);
  });
});

describe('pushDefinitionToFormaloo — upsert 冪等化 (T-A1)', () => {
  test('(a) existingFieldSlugs にある field は PATCH /v3.0/fields/{slug}/ で更新・choice_items を含まない・POST を叩かない', async () => {
    const { client, calls } = upsertMock(({ method }) => {
      if (method === 'PATCH') return { ok: true, status: 200, data: {} };
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'FSLUG', title: 't', fields: [choiceField], logic: [],
      existingFieldSlugs: { h2: 'sl2' },
    });
    expect(r.ok).toBe(true);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path).toBe('/v3.0/fields/sl2/'); // exact path (W1)
    // update は choices を触らない (B6): choice_items を送らない = dup も wipe も起こさない
    expect((patch.body as Record<string, unknown>).choice_items).toBeUndefined();
    expect((patch.body as Record<string, unknown>).title).toBe('性別'); // scalar option は更新する
    // 新規作成 (POST /v3.0/fields/) は叩かない = 重複を作らない
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v3.0/fields/')).toBe(false);
    // probe も不要 (slug 既知)
    expect(calls.some((c) => c.method === 'GET')).toBe(false);
    expect(r.fieldSlugs).toEqual({ h2: 'sl2' }); // PATCH は slug 既知 = 応答 parse 不要
  });

  test('(b) slug 無し新規 field は POST /v3.0/fields/ で choices 込み作成', async () => {
    const { client, calls } = upsertMock(({ method, path }) => {
      if (method === 'POST' && path === '/v3.0/forms/') return { ok: true, status: 201, data: { data: { form: { slug: 'NEWFORM' } } } };
      if (method === 'POST' && path === '/v3.0/fields/') return { ok: true, status: 201, data: { data: { field: { slug: 'FS' } } } };
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: null, title: 't', fields: [choiceField], logic: [] });
    expect(r.ok).toBe(true);
    const post = calls.find((c) => c.method === 'POST' && c.path === '/v3.0/fields/')!;
    expect((post.body as Record<string, unknown>).choice_items).toEqual([{ title: '男' }, { title: '女' }]); // choices 込み
    expect((post.body as Record<string, unknown>).form).toBe('NEWFORM');
    expect(r.fieldSlugs).toEqual({ h2: 'FS' });
  });

  test('(c) PATCH が HTTP 404 (Formaloo 側で削除済) → 同 field を POST へ self-heal し fieldSlugs に新 slug', async () => {
    const { client, calls } = upsertMock(({ method, path }) => {
      if (method === 'PATCH') return { ok: false, status: 404, error: 'gone' };
      if (method === 'POST' && path === '/v3.0/fields/') return { ok: true, status: 201, data: { data: { field: { slug: 'REBORN' } } } };
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'FSLUG', title: 't', fields: [textField], logic: [],
      existingFieldSlugs: { h1: 'oldslug' },
    });
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === 'PATCH')!.path).toBe('/v3.0/fields/oldslug/');
    const post = calls.find((c) => c.method === 'POST' && c.path === '/v3.0/fields/')!;
    expect((post.body as Record<string, unknown>).form).toBe('FSLUG'); // self-heal は full payload (choices 込み)
    expect(r.fieldSlugs).toEqual({ h1: 'REBORN' }); // 新 slug へ置換
  });

  test('(d) formalooSlug=null (初回・form 新規作成) は probe 0 回で全 field POST (従来挙動同値)', async () => {
    let n = 0;
    const { client, calls } = upsertMock(({ method, path }) => {
      if (method === 'POST' && path === '/v3.0/forms/') return { ok: true, status: 201, data: { data: { form: { slug: 'NF' } } } };
      if (method === 'POST' && path === '/v3.0/fields/') { n += 1; return { ok: true, status: 201, data: { data: { field: { slug: `fs${n}` } } } }; }
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: null, title: 't', fields: [textField, choiceField], logic: [] });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.method === 'GET').length).toBe(0); // probe 0 回 (B2)
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/v3.0/fields/').length).toBe(2); // 全 field POST
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(r.fieldSlugs).toEqual({ h1: 'fs1', h2: 'fs2' });
  });
});

describe('pushDefinitionToFormaloo — probe (T-A2 / formPreExisted + slug 未知)', () => {
  test('(e) probe GET /v3.0/fields/{id}/ が 200 → PATCH 更新 (新規作成しない = 重複防止)', async () => {
    const { client, calls } = upsertMock(({ method }) => {
      if (method === 'GET') return { ok: true, status: 200, data: {} };
      if (method === 'PATCH') return { ok: true, status: 200, data: {} };
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: 'FSLUG', title: 't', fields: [textField], logic: [] });
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === 'GET')!.path).toBe('/v3.0/fields/h1/'); // probe は field.id で
    expect(calls.find((c) => c.method === 'PATCH')!.path).toBe('/v3.0/fields/h1/'); // slug=field.id で PATCH
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v3.0/fields/')).toBe(false);
    expect(r.fieldSlugs).toEqual({ h1: 'h1' });
  });

  test('(e) probe が 404 → POST 作成', async () => {
    const { client, calls } = upsertMock(({ method, path }) => {
      if (method === 'GET') return { ok: false, status: 404, error: 'nf' };
      if (method === 'POST' && path === '/v3.0/fields/') return { ok: true, status: 201, data: { data: { field: { slug: 'CREATED' } } } };
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: 'FSLUG', title: 't', fields: [textField], logic: [] });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(calls.find((c) => c.method === 'POST' && c.path === '/v3.0/fields/')!.body).toMatchObject({ form: 'FSLUG' });
    expect(r.fieldSlugs).toEqual({ h1: 'CREATED' });
  });

  test.each([401, 403, 429, 500, 503])('(e) probe が %i → {ok:false} で fail-soft 停止 (POST も PATCH もしない = 憶測 create で重複を作らない / B1)', async (status) => {
    const { client, calls } = upsertMock(({ method }) => {
      if (method === 'GET') return { ok: false, status, error: `HTTP ${status}` };
      return { ok: true, status: 201, data: { data: { field: { slug: 'X' } } } };
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: 'FSLUG', title: 't', fields: [textField], logic: [] });
    expect(r.ok).toBe(false);
    expect(r.formalooSlug).toBe('FSLUG');
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v3.0/fields/')).toBe(false); // 憶測作成しない
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('(e) probe が例外相当 (client.request fail-soft = status 0) → {ok:false} 停止 (POST しない)', async () => {
    const { client, calls } = upsertMock(({ method }) => {
      if (method === 'GET') return { ok: false, status: 0, error: 'network boom' }; // client.request が例外を status 0 に握り潰す形 (N-6)
      return { ok: true, status: 201, data: { data: { field: { slug: 'X' } } } };
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: 'FSLUG', title: 't', fields: [textField], logic: [] });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v3.0/fields/')).toBe(false);
  });
});

describe('pushDefinitionToFormaloo — fail-soft 非 ok (T-A2 (f) / N-6 throw しない)', () => {
  test('(f) PATCH が 500 (非 404) → throw せず {ok:false, formalooSlug, error}', async () => {
    const { client } = upsertMock(({ method }) => {
      if (method === 'PATCH') return { ok: false, status: 500, error: 'boom' };
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'FSLUG', title: 't', fields: [textField], logic: [], existingFieldSlugs: { h1: 'sl1' },
    });
    expect(r.ok).toBe(false);
    expect(r.formalooSlug).toBe('FSLUG');
    expect(r.error).toContain('update failed');
  });

  test('(f) 新規 POST が非 ok → {ok:false, formalooSlug, error}', async () => {
    const { client } = upsertMock(({ method, path }) => {
      if (method === 'GET') return { ok: false, status: 404, error: 'nf' };
      if (method === 'POST' && path === '/v3.0/fields/') return { ok: false, status: 400, error: 'bad field' };
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, { formalooSlug: 'FSLUG', title: 't', fields: [textField], logic: [] });
    expect(r.ok).toBe(false);
    expect(r.formalooSlug).toBe('FSLUG');
    expect(r.error).toContain('field push failed');
  });

  test('(f) self-heal POST (PATCH 404 後) が非 ok → {ok:false, formalooSlug, error}', async () => {
    const { client } = upsertMock(({ method, path }) => {
      if (method === 'PATCH') return { ok: false, status: 404, error: 'gone' };
      if (method === 'POST' && path === '/v3.0/fields/') return { ok: false, status: 500, error: 'heal boom' };
      return { ok: true, status: 200, data: {} };
    });
    const r = await pushDefinitionToFormaloo(client, {
      formalooSlug: 'FSLUG', title: 't', fields: [textField], logic: [], existingFieldSlugs: { h1: 'sl1' },
    });
    expect(r.ok).toBe(false);
    expect(r.formalooSlug).toBe('FSLUG');
    expect(r.error).toContain('field push failed');
  });
});
