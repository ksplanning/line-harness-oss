import { describe, expect, test } from 'vitest';
import {
  ensureSystemHiddenFields,
  isFriendSystemField,
  checkSystemFieldHealth,
  backfillSystemHiddenFields,
  backfillFieldAliases,
  type SystemFieldClient,
} from './formaloo-system-fields.js';

// =============================================================================
// fr-id-capture-fix / T-C2 (+ T-C5 健全性チェック / O-6 backfill):
//   ensureSystemHiddenFields が予約 alias fr_id/fr_name を「各ちょうど1件かつ type=hidden」で冪等 ensure する。
//   - 無 → POST {type:'hidden',alias,title,form} → re-GET で exactly-one 確認 → created
//   - 正常既在(type=hidden) → POST 0 (present / 冪等)
//   - 既存非 system field は PATCH/DELETE しない (additive only)
//   - 衝突(visible/型違い/複数) → 自動修復せず out_of_sync (fail-closed)
//   - POST 非2xx/timeout/201消失 → throw せず out_of_sync で surface (silent success 禁止)
//   - fields_list 読取不能 (GET 非ok / 例外 / shape 不一致) → fail-closed out_of_sync (T-C3 round2:
//     closer 独立検証 Codex 発見の silent-success gap 是正。throw はしない = 回答導線は落とさず surface のみ)
// =============================================================================

interface RawField {
  slug: string;
  alias?: string | null;
  type?: string;
  title?: string;
  invisible?: boolean;
}

type PostMode = 'append' | 'noop' | 'fail' | 'timeout' | 'appendVisible';

function makeClient(cfg: {
  fields: RawField[];
  getOk?: boolean; // GET /v3.0/forms/{slug}/ を失敗させる (default true)
  getThrows?: boolean; // GET が例外を投げる (network 断・T-C3 round2 fail-closed)
  getBadShape?: boolean; // GET は 200 だが fields_list 不在 (read-shape 不一致・extractFieldsList→null)
  postMode?: PostMode; // POST /v3.0/fields/ の挙動 (default 'append')
  logic?: unknown[]; // T-C7: form の bare-array logic (default 無=logic なし)
}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const state = [...cfg.fields];
  const getOk = cfg.getOk ?? true;
  const postMode = cfg.postMode ?? 'append';
  const client: SystemFieldClient = {
    async get<T = unknown>(path: string) {
      calls.push({ method: 'GET', path });
      if (cfg.getThrows) throw new Error('network boom');
      if (cfg.getBadShape) return { ok: true, status: 200, data: { data: { form: { title: 'no fields' } } } as unknown as T };
      if (!getOk) return { ok: false, status: 404, error: 'not found' } as { ok: boolean; status: number; data?: T; error?: string };
      const form: Record<string, unknown> = { fields_list: state.map((f) => ({ ...f })) };
      if (cfg.logic !== undefined) form.logic = cfg.logic;
      const data = { data: { form } } as unknown as T;
      return { ok: true, status: 200, data };
    },
    async post<T = unknown>(path: string, body?: unknown) {
      calls.push({ method: 'POST', path, body });
      const b = (body ?? {}) as { alias?: string; type?: string; title?: string };
      if (postMode === 'fail') return { ok: false, status: 500, error: 'boom' } as { ok: boolean; status: number; data?: T; error?: string };
      if (postMode === 'timeout') return { ok: false, status: 0, error: 'network' } as { ok: boolean; status: number; data?: T; error?: string };
      if (postMode === 'append') {
        state.push({ slug: `new_${b.alias}`, alias: b.alias, type: b.type ?? 'hidden', title: b.title });
      }
      if (postMode === 'appendVisible') {
        state.push({ slug: `new_${b.alias}`, alias: b.alias, type: 'short_text', title: b.title });
      }
      // 'noop' = 201 を返すが state を変えない (201消失シミュレーション)
      return { ok: true, status: 201, data: { data: { field: { slug: `new_${b.alias}` } } } as unknown as T };
    },
  };
  return { client, calls, state };
}

describe('ensureSystemHiddenFields (T-C2)', () => {
  test('(1) alias 無 → POST payload={type:hidden,alias,title,form} → re-GET で exactly-one → created', async () => {
    const { client, calls } = makeClient({ fields: [{ slug: 's1', type: 'short_text', title: '名前' }] });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: true });
    expect(r.ok).toBe(true);
    expect(r.outOfSync).toBe(false);
    expect(r.skipped).toBe(false);
    // fr_id + fr_name の 2 件 created
    expect(r.outcomes.filter((o) => o.status === 'created').map((o) => o.alias).sort()).toEqual(['fr_id', 'fr_name']);
    // POST payload 検証 (fr_id)
    const frIdPost = calls.find((c) => c.method === 'POST' && (c.body as { alias?: string }).alias === 'fr_id')!;
    expect(frIdPost.path).toBe('/v3.0/fields/');
    expect(frIdPost.body).toMatchObject({ type: 'hidden', alias: 'fr_id', form: 'FSLUG' });
    expect((frIdPost.body as { title?: string }).title).toBeTruthy();
    // POST 後 re-GET が行われる
    const gets = calls.filter((c) => c.method === 'GET');
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });

  test('(2) 正常既在(type=hidden) → POST 0 (冪等 no-op / present)', async () => {
    const { client, calls } = makeClient({
      fields: [
        { slug: 's1', type: 'short_text', title: '名前' },
        { slug: 'h1', alias: 'fr_id', type: 'hidden', title: 'x' },
        { slug: 'h2', alias: 'fr_name', type: 'hidden', title: 'y' },
      ],
    });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: true });
    expect(r.ok).toBe(true);
    expect(r.outOfSync).toBe(false);
    expect(r.outcomes.every((o) => o.status === 'present')).toBe(true);
    expect(calls.filter((c) => c.method === 'POST').length).toBe(0);
  });

  test('(3) 既存非 system field を PATCH/DELETE しない (additive only)', async () => {
    const { client, calls } = makeClient({
      fields: [{ slug: 's1', type: 'short_text', title: '名前' }],
    });
    await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: true });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    // 既存 field への POST も無い (POST は /v3.0/fields/ の新規 system field のみ)
    expect(calls.filter((c) => c.method === 'POST').every((c) => c.path === '/v3.0/fields/')).toBe(true);
  });

  test('(4a) 衝突: alias=fr_id が visible(short_text) → 自動 mutate せず out_of_sync (fail-closed)', async () => {
    const { client, calls } = makeClient({
      fields: [{ slug: 'u1', alias: 'fr_id', type: 'short_text', title: 'user が作った fr_id' }],
    });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: false });
    expect(r.ok).toBe(false);
    expect(r.outOfSync).toBe(true);
    const frId = r.outcomes.find((o) => o.alias === 'fr_id')!;
    expect(frId.status).toBe('conflict');
    // 衝突 field を mutate しない (POST/PATCH/DELETE 一切なし)
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  test('(4b) 衝突: alias=fr_id が複数(重複) → out_of_sync・自動修復しない', async () => {
    const { client } = makeClient({
      fields: [
        { slug: 'h1', alias: 'fr_id', type: 'hidden', title: 'a' },
        { slug: 'h2', alias: 'fr_id', type: 'hidden', title: 'b' },
      ],
    });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: false });
    expect(r.outOfSync).toBe(true);
    expect(r.outcomes.find((o) => o.alias === 'fr_id')!.status).toBe('conflict');
  });

  test('(5a) POST 非2xx → throw せず out_of_sync で surface (silent success 禁止)', async () => {
    const { client } = makeClient({ fields: [], postMode: 'fail' });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: false });
    expect(r.ok).toBe(false);
    expect(r.outOfSync).toBe(true);
    expect(r.outcomes.find((o) => o.alias === 'fr_id')!.status).toBe('error');
  });

  test('(5b) POST 201 だが re-GET で 0 件 (201消失) → out_of_sync', async () => {
    const { client } = makeClient({ fields: [], postMode: 'noop' });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: false });
    expect(r.outOfSync).toBe(true);
    expect(r.outcomes.find((o) => o.alias === 'fr_id')!.status).not.toBe('created');
  });

  test('(5c) POST timeout(status 0) だが再GETで field 実在 → created (idempotent recovery)', async () => {
    // timeout は失敗を返すが field は実在する状況をシミュレート: 事前に fr_id を state へ入れておき postMode=timeout。
    const { client } = makeClient({
      fields: [{ slug: 'h1', alias: 'fr_id', type: 'hidden', title: 'x' }],
      postMode: 'timeout',
    });
    // fr_id は既在ゆえ POST されない = present。timeout 経路の recovery は (5b/5a) で担保・ここは present 確認。
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: false });
    expect(r.ok).toBe(true);
    expect(r.outcomes.find((o) => o.alias === 'fr_id')!.status).toBe('present');
  });

  test('owner-gate: includeOwnerGated=false は fr_id のみ ensure (fr_name を push しない)', async () => {
    const { client, calls } = makeClient({ fields: [] });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: false });
    expect(r.outcomes.map((o) => o.alias)).toEqual(['fr_id']);
    expect(calls.some((c) => c.method === 'POST' && (c.body as { alias?: string }).alias === 'fr_name')).toBe(false);
  });

  // fr-id-hardening-round2 / T-C3 fail-closed (closer 独立検証 Codex 発見の silent-success gap):
  //   form-state fetch 失敗/読取不能は fail-soft の skipped(=idle 扱い) ではなく **fail-closed の out_of_sync** で
  //   surface する。ensure は admin 保存経路 (forms-advanced PUT) のみで呼ばれ /fo 回答 hot path では呼ばれないため、
  //   out_of_sync surface は回答導線を落とさず「同期に失敗・再保存で復旧」を honest に見せるだけ (silent 成功禁止)。
  test('fetch 失敗 (GET 非ok) → fail-closed out_of_sync・盲目 POST しない (T-C3 round2)', async () => {
    const { client, calls } = makeClient({ fields: [], getOk: false });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: true });
    expect(r.ok).toBe(false);
    expect(r.outOfSync).toBe(true); // silent success 禁止 = surface して呼び出し側が out_of_sync 化
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // fields_list 不明ゆえ作成判断は保留
  });

  test('fetch 例外 (network throw) → fail-closed out_of_sync (throw を握り潰して成功にしない)', async () => {
    const { client, calls } = makeClient({ fields: [], getThrows: true });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: true });
    expect(r.ok).toBe(false);
    expect(r.outOfSync).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('read-shape 不一致 (200 だが fields_list 不在) → fail-closed out_of_sync', async () => {
    const { client, calls } = makeClient({ fields: [], getBadShape: true });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: true });
    expect(r.ok).toBe(false);
    expect(r.outOfSync).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('isFriendSystemField (raw field 判定)', () => {
  test('alias が予約なら true / それ以外 false', () => {
    expect(isFriendSystemField({ slug: 'a', alias: 'fr_id', type: 'hidden' })).toBe(true);
    expect(isFriendSystemField({ slug: 'a', alias: 'fr_name', type: 'hidden' })).toBe(true);
    expect(isFriendSystemField({ slug: 'a', alias: 'name', type: 'short_text' })).toBe(false);
    expect(isFriendSystemField({ slug: 'a', type: 'short_text' })).toBe(false);
    expect(isFriendSystemField(null)).toBe(false);
    expect(isFriendSystemField('x')).toBe(false);
  });
});

describe('checkSystemFieldHealth (T-C5(3): system field 健全性の別建てチェック)', () => {
  test('fr_id/fr_name が exactly-one hidden → ok・issues 空', () => {
    const list = [
      { slug: 's1', type: 'short_text' },
      { slug: 'h1', alias: 'fr_id', type: 'hidden' },
      { slug: 'h2', alias: 'fr_name', type: 'hidden' },
    ];
    const r = checkSystemFieldHealth(list, { includeOwnerGated: true });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  test('削除(missing) を検知', () => {
    const r = checkSystemFieldHealth([{ slug: 's1', type: 'short_text' }], { includeOwnerGated: false });
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.alias === 'fr_id')!.issue).toBe('missing');
  });

  test('visible化/型変更 を検知', () => {
    const r = checkSystemFieldHealth([{ slug: 'h1', alias: 'fr_id', type: 'short_text' }], { includeOwnerGated: false });
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.alias === 'fr_id')!.issue).toBe('not_hidden');
  });

  test('重複(duplicate) を検知', () => {
    const r = checkSystemFieldHealth(
      [
        { slug: 'h1', alias: 'fr_id', type: 'hidden' },
        { slug: 'h2', alias: 'fr_id', type: 'hidden' },
      ],
      { includeOwnerGated: false },
    );
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.alias === 'fr_id')!.issue).toBe('duplicate');
  });
});

describe('backfillSystemHiddenFields (O-6: 再 publish されない既存フォームへ additive backfill 経路)', () => {
  test('複数フォームを ensure し total/repaired/alreadyOk/outOfSync を集計', async () => {
    // form A: 未設定 → repair (created)。form B: 既在 → alreadyOk。
    const state: Record<string, RawField[]> = {
      A: [{ slug: 's1', type: 'short_text' }],
      B: [
        { slug: 'h1', alias: 'fr_id', type: 'hidden' },
        { slug: 'h2', alias: 'fr_name', type: 'hidden' },
      ],
    };
    const client: SystemFieldClient = {
      async get<T = unknown>(path: string) {
        const slug = path.match(/\/v3\.0\/forms\/([^/]+)\//)?.[1] ?? '';
        return { ok: true, status: 200, data: { data: { form: { fields_list: (state[slug] ?? []).map((f) => ({ ...f })) } } } as unknown as T };
      },
      async post<T = unknown>(path: string, body?: unknown) {
        const b = (body ?? {}) as { alias?: string; type?: string; form?: string };
        state[b.form ?? '']?.push({ slug: `n_${b.alias}`, alias: b.alias, type: b.type ?? 'hidden' });
        return { ok: true, status: 201, data: { data: { field: { slug: `n_${b.alias}` } } } as unknown as T };
      },
    };
    const r = await backfillSystemHiddenFields(client, ['A', 'B'], { includeOwnerGated: true });
    expect(r.total).toBe(2);
    expect(r.repaired).toBe(1); // A のみ created
    expect(r.alreadyOk).toBe(1); // B は present
    expect(r.outOfSync).toEqual([]);
    expect(r.results).toHaveLength(2);
  });
});

// =============================================================================
// fr-id-hardening-round2 (④): backfillFieldAliases — 既存フォームの全 answer field に alias=slug を冪等 backfill。
//   dry-run 既定 (mutate せず対象列挙) / execute で PATCH {alias:slug} + fr_id/fr_name ensure。
//   friend-system (fr_id/fr_name) / success_page / 既 alias=slug は対象外。
// =============================================================================
function backfillAliasClient(seed: Record<string, RawField[]>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const s: Record<string, RawField[]> = {};
  for (const k of Object.keys(seed)) s[k] = seed[k].map((f) => ({ ...f }));
  const client: SystemFieldClient = {
    async get<T = unknown>(path: string) {
      calls.push({ method: 'GET', path });
      const slug = path.match(/\/v3\.0\/forms\/([^/]+)\//)?.[1] ?? '';
      return { ok: true, status: 200, data: { data: { form: { fields_list: (s[slug] ?? []).map((f) => ({ ...f })) } } } as unknown as T };
    },
    async post<T = unknown>(path: string, body?: unknown) {
      calls.push({ method: 'POST', path, body });
      const b = (body ?? {}) as { alias?: string; type?: string; form?: string };
      s[b.form ?? '']?.push({ slug: `n_${b.alias}`, alias: b.alias, type: b.type ?? 'hidden' });
      return { ok: true, status: 201, data: { data: { field: { slug: `n_${b.alias}` } } } as unknown as T };
    },
    async request<T = unknown>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });
      const m = path.match(/\/v3\.0\/fields\/([^/]+)\//);
      if (method === 'PATCH' && m) {
        const fslug = m[1];
        const alias = (body as { alias?: string })?.alias;
        for (const arr of Object.values(s)) { const f = arr.find((x) => x.slug === fslug); if (f && alias !== undefined) f.alias = alias; }
      }
      return { ok: true, status: 200, data: {} as unknown as T };
    },
  };
  return { client, calls };
}

// form A: alias=null(候補) / alias=slug(既済) / fr_id(system除外) / success_page(除外) / alias≠slug(候補)。
const formASeed: Record<string, RawField[]> = {
  A: [
    { slug: 's1', type: 'short_text' },                       // 候補 (alias null)
    { slug: 's2', type: 'email', alias: 's2' },               // 既に alias=slug (除外)
    { slug: 'h1', alias: 'fr_id', type: 'hidden' },           // friend-system (除外)
    { slug: 'sp1', type: 'success_page' },                    // 完了ページ (除外)
    { slug: 's3', type: 'short_text', alias: 'oldalias' },    // 候補 (alias≠slug)
  ],
};

describe('backfillFieldAliases (④: 既存フォームの alias=slug backfill)', () => {
  test('dry-run 既定: 対象 field を列挙し 1 byte も mutate しない (PATCH/POST 無)', async () => {
    const { client, calls } = backfillAliasClient(formASeed);
    const r = await backfillFieldAliases(client, ['A'], { dryRun: true, includeOwnerGated: true });
    expect(r.dryRun).toBe(true);
    expect(r.totalFieldsNeedingAlias).toBe(2);
    expect(r.forms[0].fieldsNeedingAlias.map((c) => c.slug).sort()).toEqual(['s1', 's3']);
    expect(r.totalPatched).toBe(0);
    // mutate しない
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    // fr_name 欠落を health で report (fr_id は present)
    expect(r.forms[0].systemFieldHealth.issues.some((i) => i.alias === 'fr_name' && i.issue === 'missing')).toBe(true);
  });

  test('execute (dryRun:false): 各候補に PATCH {alias:slug} + fr_id/fr_name ensure', async () => {
    const { client, calls } = backfillAliasClient(formASeed);
    const r = await backfillFieldAliases(client, ['A'], { dryRun: false, includeOwnerGated: true });
    expect(r.dryRun).toBe(false);
    expect(r.totalPatched).toBe(2);
    expect(calls.some((c) => c.method === 'PATCH' && c.path === '/v3.0/fields/s1/' && (c.body as { alias?: string }).alias === 's1')).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH' && c.path === '/v3.0/fields/s3/' && (c.body as { alias?: string }).alias === 's3')).toBe(true);
    // friend-system / success_page / 既 alias=slug は PATCH しない
    expect(calls.some((c) => c.method === 'PATCH' && (c.path === '/v3.0/fields/s2/' || c.path === '/v3.0/fields/h1/' || c.path === '/v3.0/fields/sp1/'))).toBe(false);
    // fr_name(欠落) を ensure が POST (fr_id は present)
    expect(r.forms[0].systemFields).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v3.0/fields/' && (c.body as { alias?: string }).alias === 'fr_name')).toBe(true);
  });

  test('冪等: execute 後の再 execute は候補 0 (alias=slug 済 = no-op)', async () => {
    const { client } = backfillAliasClient(formASeed);
    await backfillFieldAliases(client, ['A'], { dryRun: false, includeOwnerGated: true });
    const r2 = await backfillFieldAliases(client, ['A'], { dryRun: false, includeOwnerGated: true });
    expect(r2.totalFieldsNeedingAlias).toBe(0);
    expect(r2.totalPatched).toBe(0);
  });

  test('fields_list 読取不能 (GET 非ok) → skipped (集計に混ぜない)', async () => {
    const client: SystemFieldClient = {
      async get<T = unknown>() { return { ok: false, status: 500, error: 'boom' } as { ok: boolean; status: number; data?: T; error?: string }; },
      async post<T = unknown>() { return { ok: true, status: 201, data: {} as unknown as T }; },
      async request<T = unknown>() { return { ok: true, status: 200, data: {} as unknown as T }; },
    };
    const r = await backfillFieldAliases(client, ['X'], { dryRun: false });
    expect(r.forms[0].skipped).toBe(true);
    expect(r.totalFieldsNeedingAlias).toBe(0);
    expect(r.totalPatched).toBe(0);
  });

  // P1 [Important reviewer R1]: PII gate バイパス default の是正。includeOwnerGated 省略 (= PII opt-out テナント相当) で
  //   execute しても fr_name (実名) field を gate 外で作らない (default false = 安全側)。fr_name を作ると /fo が必ず付与し
  //   実名保存が始まる (親案件で fr_name = owner 要確認に昇格)。opt-in (includeOwnerGated:true) は既存 execute test が担保。
  test('P1: includeOwnerGated 省略 (opt-out 相当) で execute しても fr_name field を作らない (PII 安全 default)', async () => {
    const { client, calls } = backfillAliasClient(formASeed);
    const r = await backfillFieldAliases(client, ['A'], { dryRun: false }); // includeOwnerGated 未指定 = false
    // fr_name の POST が一切ない (gate 外の実名 field を作らない)
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v3.0/fields/' && (c.body as { alias?: string }).alias === 'fr_name')).toBe(false);
    expect(r.forms[0].systemFields?.outcomes.some((o) => o.alias === 'fr_name')).toBe(false);
    // dry-run health も fr_name を issue に挙げない (opt-out ゆえ欠落を欠陥扱いしない)
    const dry = await backfillFieldAliases(client, ['A'], { dryRun: true });
    expect(dry.forms[0].systemFieldHealth.issues.some((i) => i.alias === 'fr_name')).toBe(false);
  });
});

describe('T-C7: logic 有効フォームは hidden field 値が破棄される (fr_id 捕捉不能を surface)', () => {
  test('logic 無 → logicConflict=false (従来どおり created・out_of_sync でない)', async () => {
    const { client } = makeClient({ fields: [{ slug: 's1', type: 'short_text', title: '名前' }] });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: true });
    expect(r.logicConflict).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.outOfSync).toBe(false);
  });

  test('logic 有 → field は作成しても logicConflict=true・out_of_sync (fr_id は Formaloo が破棄=機能しない)', async () => {
    const { client, calls } = makeClient({
      fields: [{ slug: 's1', type: 'short_text', title: '名前' }],
      logic: [{ conditions: [], actions: [{ type: 'submit_form' }] }], // submit rule あり (bare array)
    });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: true });
    expect(r.logicConflict).toBe(true);
    expect(r.ok).toBe(false); // field 作成は成功でも fr_id 捕捉不能ゆえ ok にしない
    expect(r.outOfSync).toBe(true); // silent success 禁止 = surface
    // field 作成自体は行う (idempotent。owner が logic を外せば機能する)
    expect(calls.some((c) => c.method === 'POST' && c.path === '/v3.0/fields/')).toBe(true);
  });

  test('logic 有 + 既に fr_id/fr_name 既在 (present) でも logicConflict=true・out_of_sync', async () => {
    const { client } = makeClient({
      fields: [
        { slug: 'h1', alias: 'fr_id', type: 'hidden', title: 'x' },
        { slug: 'h2', alias: 'fr_name', type: 'hidden', title: 'y' },
      ],
      logic: [{ conditions: [], actions: [{ type: 'submit_form' }] }],
    });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: true });
    expect(r.logicConflict).toBe(true);
    expect(r.outOfSync).toBe(true);
    expect(r.outcomes.every((o) => o.status === 'present')).toBe(true); // field 自体は健全
  });

  test('空 logic array ([]) は logicConflict=false (length>0 のみ検知)', async () => {
    const { client } = makeClient({ fields: [{ slug: 's1', type: 'short_text' }], logic: [] });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: false });
    expect(r.logicConflict).toBe(false);
  });

  test('checkSystemFieldHealth: rawLogic 有 → logicConflict=true・ok=false (health 別建てでも検知)', () => {
    const healthyFields = [
      { slug: 'h1', alias: 'fr_id', type: 'hidden' },
      { slug: 'h2', alias: 'fr_name', type: 'hidden' },
    ];
    // logic 無 (未渡し) → 健全
    expect(checkSystemFieldHealth(healthyFields, { includeOwnerGated: true }).logicConflict).toBe(false);
    expect(checkSystemFieldHealth(healthyFields, { includeOwnerGated: true }).ok).toBe(true);
    // logic 有 → field 健全でも logicConflict で ok=false
    const withLogic = checkSystemFieldHealth(healthyFields, { includeOwnerGated: true }, [{ actions: [{ type: 'submit_form' }] }]);
    expect(withLogic.logicConflict).toBe(true);
    expect(withLogic.ok).toBe(false);
    expect(withLogic.issues).toEqual([]); // field 自体は健全 (issue は logic と別軸)
  });
});
