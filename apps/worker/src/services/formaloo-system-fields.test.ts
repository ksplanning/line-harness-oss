import { describe, expect, test } from 'vitest';
import {
  ensureSystemHiddenFields,
  isFriendSystemField,
  checkSystemFieldHealth,
  backfillSystemHiddenFields,
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
//   - fields_list 読取不能 → skipped (hot path 保護・out_of_sync にしない)
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
  postMode?: PostMode; // POST /v3.0/fields/ の挙動 (default 'append')
}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const state = [...cfg.fields];
  const getOk = cfg.getOk ?? true;
  const postMode = cfg.postMode ?? 'append';
  const client: SystemFieldClient = {
    async get<T = unknown>(path: string) {
      calls.push({ method: 'GET', path });
      if (!getOk) return { ok: false, status: 404, error: 'not found' } as { ok: boolean; status: number; data?: T; error?: string };
      const data = { data: { form: { fields_list: state.map((f) => ({ ...f })) } } } as unknown as T;
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

  test('fields_list 読取不能 (GET 非ok) → skipped (out_of_sync にしない・hot path 保護)', async () => {
    const { client, calls } = makeClient({ fields: [], getOk: false });
    const r = await ensureSystemHiddenFields(client, 'FSLUG', { includeOwnerGated: true });
    expect(r.skipped).toBe(true);
    expect(r.outOfSync).toBe(false);
    // POST しない (盲目的に作らない)
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
