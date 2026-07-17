/**
 * route-terminal-phase2 (T-E2) — SP CRUD reconcile (create/update/delete + slug 永続 + 非cascade delete)。
 * 🚨 Phase 1 + 本案件 spike 継承地雷:
 *   - create=POST /v3.0/fields/success-page/ (HTTP 201 / slug=data.field.slug) / update・delete は汎用
 *     /v3.0/fields/{slug}/ (専用 path は 404)。
 *   - **再 POST は非冪等** (別 slug 増殖) → POST 成功後 slug を即返し次回は再 POST しない (重複作成なし)。
 *   - **form DELETE で SP は cascade しない** → 削除対象 SP を明示 DELETE で回収 (404 は既に消滅=成功扱い)。
 */
import { describe, expect, it } from 'vitest';
import { pushSuccessPages, deleteSuccessPages } from './formaloo-success-page.js';
import type { FormalooClient } from './formaloo-client.js';
import type { SuccessPageSpec } from '@line-crm/shared';

interface Call { method: string; path: string; body?: unknown }

/** POST は data.field.slug を採番する mock client (spike の 201/slug=data.field.slug を模倣)。 */
function mockClient(opts: {
  calls: Call[];
  slugSeq?: string[];
  postFailAt?: number; // N 回目 (1-based) の POST を失敗させる
  patch404?: boolean;  // PATCH を 404 (self-heal 経路)
  deleteStatus?: (slug: string) => number;
} = { calls: [] }): FormalooClient {
  let postN = 0;
  let slugI = 0;
  const seq = opts.slugSeq ?? ['SP_A', 'SP_B', 'SP_C'];
  return {
    post: async (path: string, body?: unknown) => {
      opts.calls.push({ method: 'POST', path, body });
      postN += 1;
      if (opts.postFailAt === postN) return { ok: false, status: 500 };
      const slug = seq[slugI++] ?? `SP_${slugI}`;
      return { ok: true, status: 201, data: { data: { field: { slug } } } };
    },
    request: async (method: string, path: string, body?: unknown) => {
      opts.calls.push({ method, path, body });
      if (method === 'PATCH') return opts.patch404 ? { ok: false, status: 404 } : { ok: true, status: 200, data: {} };
      if (method === 'DELETE') {
        const slug = path.split('/').filter(Boolean).pop() ?? '';
        const st = opts.deleteStatus ? opts.deleteStatus(slug) : 200;
        return { ok: st >= 200 && st < 300, status: st };
      }
      return { ok: true, status: 200, data: {} };
    },
  } as unknown as FormalooClient;
}

describe('pushSuccessPages — create/update + slug 永続 (非冪等)', () => {
  it('未 slug の SP を POST /v3.0/fields/success-page/ で作成し slug を永続する', async () => {
    const calls: Call[] = [];
    const client = mockClient({ calls, slugSeq: ['SP_A'] });
    const desired: SuccessPageSpec[] = [{ id: 'sp1', title: 'Aルート完了', description: 'ありがとう' }];
    const r = await pushSuccessPages(client, 'FORMSLUG', desired, []);
    expect(r.ok).toBe(true);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/v3.0/fields/success-page/');
    expect(post?.body).toMatchObject({ form: 'FORMSLUG', title: 'Aルート完了', description: 'ありがとう' });
    expect(r.successPages[0].slug).toBe('SP_A');
    expect(r.slugById).toEqual({ sp1: 'SP_A' });
  });

  it('slug 既知の SP は POST せず PATCH /v3.0/fields/{slug}/ で更新 (再 POST しない = 重複作成なし)', async () => {
    const calls: Call[] = [];
    const client = mockClient({ calls });
    const desired: SuccessPageSpec[] = [{ id: 'sp1', slug: 'SP_A', title: '更新後' }];
    const r = await pushSuccessPages(client, 'FORMSLUG', desired, [{ id: 'sp1', slug: 'SP_A', title: '旧' }]);
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // 再 POST しない
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/v3.0/fields/SP_A/');
    expect(r.successPages[0].slug).toBe('SP_A');
  });

  it('prev に slug がある id は body に slug 無しでも prev slug を carry して PATCH (非冪等防止)', async () => {
    const calls: Call[] = [];
    const client = mockClient({ calls });
    const desired: SuccessPageSpec[] = [{ id: 'sp1', title: '更新後' }]; // slug 無し (builder は slug を持たない場合)
    const r = await pushSuccessPages(client, 'FORMSLUG', desired, [{ id: 'sp1', slug: 'SP_A', title: '旧' }]);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(calls.find((c) => c.method === 'PATCH')?.path).toBe('/v3.0/fields/SP_A/');
    expect(r.successPages[0].slug).toBe('SP_A');
  });

  it('失敗注入: POST 成功(sp1 slug 採番)後に別 SP の POST が失敗 → sp1 の slug は永続され ok:false', async () => {
    const calls: Call[] = [];
    const client = mockClient({ calls, slugSeq: ['SP_A'], postFailAt: 2 });
    const desired: SuccessPageSpec[] = [{ id: 'sp1', title: 'A' }, { id: 'sp2', title: 'B' }];
    const r = await pushSuccessPages(client, 'FORMSLUG', desired, []);
    expect(r.ok).toBe(false);
    expect(r.error).toEqual(expect.any(String));
    expect(r.successPages.find((s) => s.id === 'sp1')?.slug).toBe('SP_A'); // 成功分の slug は永続
    expect(r.successPages.find((s) => s.id === 'sp2')?.slug).toBeUndefined(); // 失敗分は slug なし
    expect(r.slugById).toEqual({ sp1: 'SP_A' });
  });

  it('self-heal: PATCH が 404 (remote SP 削除済) → 再 POST で作り直す', async () => {
    const calls: Call[] = [];
    const client = mockClient({ calls, slugSeq: ['SP_NEW'], patch404: true });
    const desired: SuccessPageSpec[] = [{ id: 'sp1', slug: 'SP_GONE', title: 'T' }];
    const r = await pushSuccessPages(client, 'FORMSLUG', desired, [{ id: 'sp1', slug: 'SP_GONE', title: '旧' }]);
    expect(calls.find((c) => c.method === 'PATCH')?.path).toBe('/v3.0/fields/SP_GONE/');
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/v3.0/fields/success-page/');
    expect(r.successPages[0].slug).toBe('SP_NEW');
  });
});

describe('deleteSuccessPages — 明示 DELETE (非cascade 回収)', () => {
  it('slug を DELETE /v3.0/fields/{slug}/ で削除する', async () => {
    const calls: Call[] = [];
    const client = mockClient({ calls });
    const r = await deleteSuccessPages(client, ['SP_A', 'SP_B']);
    expect(r.ok).toBe(true);
    expect(r.deleted).toEqual(['SP_A', 'SP_B']);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/v3.0/fields/SP_A/', '/v3.0/fields/SP_B/']);
  });

  it('DELETE が 404 (既に消滅) は成功扱い (form DELETE 非cascade の明示回収で冪等)', async () => {
    const calls: Call[] = [];
    const client = mockClient({ calls, deleteStatus: () => 404 });
    const r = await deleteSuccessPages(client, ['SP_GONE']);
    expect(r.ok).toBe(true);
    expect(r.deleted).toEqual(['SP_GONE']);
  });

  it('一部 DELETE 失敗 (5xx) は failed に記録し ok:false (孤児を握り潰さない)', async () => {
    const calls: Call[] = [];
    const client = mockClient({ calls, deleteStatus: (s) => (s === 'SP_BAD' ? 500 : 200) });
    const r = await deleteSuccessPages(client, ['SP_OK', 'SP_BAD']);
    expect(r.ok).toBe(false);
    expect(r.deleted).toContain('SP_OK');
    expect(r.failed).toContain('SP_BAD');
    expect(r.error).toEqual(expect.any(String));
  });
});
