import type { SuccessPageSpec } from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client.js';

// =============================================================================
// route-terminal-phase2 (Track 2) — Formaloo success-page (完了ページ) resource の CRUD reconcile。
// -----------------------------------------------------------------------------
// 🚨 Phase 1 + 本案件 spike 継承地雷 (spike-results.md §3):
//   - create = POST /v3.0/fields/success-page/ (body {form,title,description}) → HTTP 201 / slug=data.field.slug
//     (envelope status:200 との不一致を許容 = HTTP 2xx を採用)。
//   - read/update/delete は汎用 /v3.0/fields/{slug}/ (専用 path /v3.0/fields/success-page/{slug}/ は 404)。
//   - **再 POST は非冪等** (同一内容でも別 slug を新規作成) → POST 成功後は slug を即返し次回は再 POST しない
//     (slug クライアント永続で重複作成を根絶)。
//   - **form DELETE で SP は cascade しない** (孤児残存) → 削除対象 SP は明示 DELETE で回収する。
// formaloo-sync.ts / formaloo-copy.ts と同じ fail-soft (throw せず ok/error を返す)。
// =============================================================================

interface FieldCreateResp {
  data?: { field?: { slug?: string }; slug?: string };
}

/** POST/PATCH の共通 body。update では form を送らない (既存 field の再帰属を避ける)。 */
function createBody(formalooSlug: string, sp: SuccessPageSpec): Record<string, unknown> {
  return { form: formalooSlug, title: sp.title, description: sp.description ?? '' };
}
function updateBody(sp: SuccessPageSpec): Record<string, unknown> {
  return { title: sp.title, description: sp.description ?? '' };
}

/** SP を新規作成し slug を返す (非冪等 POST → 呼出側が slug を即永続する前提)。 */
async function createSuccessPage(
  client: FormalooClient,
  formalooSlug: string,
  sp: SuccessPageSpec,
): Promise<{ slug?: string; error?: string }> {
  const res = await client.post<FieldCreateResp>('/v3.0/fields/success-page/', createBody(formalooSlug, sp));
  if (!res.ok) return { error: `完了ページの作成に失敗しました (HTTP ${res.status})` };
  const slug = res.data?.data?.field?.slug ?? res.data?.data?.slug;
  if (!slug) return { error: '完了ページの作成応答に slug がありません' };
  return { slug };
}

export interface SuccessPagePushResult {
  ok: boolean;
  /** 割当 slug 付きの successPages (definition_json へ永続する。POST 成功分は必ず slug を持つ)。 */
  successPages: SuccessPageSpec[];
  /** harness SP id → Formaloo slug (logic resolver が submit target SP を解決するのに使う)。 */
  slugById: Record<string, string>;
  error?: string;
}

/**
 * successPages を Formaloo へ create/update reconcile する (delete は deleteSuccessPages で別フェーズ)。
 *   - slug 既知 (body or prev から carry) → PATCH /v3.0/fields/{slug}/ で更新。404 は self-heal で再 POST。
 *   - slug 未知 → POST /v3.0/fields/success-page/ で作成し slug を即永続 (非冪等ゆえ次回は再 POST しない)。
 *   - 途中失敗しても成功済 SP の slug は successPages に残す (POST 済 slug の喪失=次回重複作成を防ぐ)。
 * prev の slug を id で carry するのが非冪等防止の芯 (builder が slug を持たない save でも重複作成しない)。
 */
export async function pushSuccessPages(
  client: FormalooClient,
  formalooSlug: string,
  desired: SuccessPageSpec[],
  previous: SuccessPageSpec[] = [],
): Promise<SuccessPagePushResult> {
  const prevSlugById = new Map<string, string>();
  for (const p of previous) if (p.slug) prevSlugById.set(p.id, p.slug);

  const out: SuccessPageSpec[] = [];
  const slugById: Record<string, string> = {};
  let error: string | undefined;

  const persist = (sp: SuccessPageSpec, slug?: string) => {
    const rec: SuccessPageSpec = { id: sp.id, title: sp.title };
    if (sp.description) rec.description = sp.description;
    if (slug) { rec.slug = slug; slugById[sp.id] = slug; }
    out.push(rec);
  };

  for (const sp of desired) {
    const knownSlug = sp.slug ?? prevSlugById.get(sp.id);
    if (knownSlug) {
      const r = await client.request('PATCH', `/v3.0/fields/${knownSlug}/`, updateBody(sp));
      if (r.status === 404) {
        // self-heal: remote SP 削除済 → 再 POST で作り直す (slug は新規採番)。
        const c = await createSuccessPage(client, formalooSlug, sp);
        if (c.slug) persist(sp, c.slug);
        else { persist(sp, undefined); error = error ?? c.error; }
      } else if (r.ok) {
        persist(sp, knownSlug);
      } else {
        // 更新失敗でも slug は既知ゆえ carry (重複作成を作らない)。error を surface。
        persist(sp, knownSlug);
        error = error ?? `完了ページの更新に失敗しました (HTTP ${r.status})`;
      }
    } else {
      const c = await createSuccessPage(client, formalooSlug, sp);
      if (c.slug) persist(sp, c.slug);
      else { persist(sp, undefined); error = error ?? c.error; }
    }
  }

  return { ok: !error, successPages: out, slugById, error };
}

export interface SuccessPageDeleteResult {
  ok: boolean;
  deleted: string[];
  failed: string[];
  error?: string;
}

/**
 * SP slug 群を明示 DELETE で回収する (form DELETE は SP を cascade しない = 孤児回収 / T-E4 でも再利用)。
 *   - 404 (既に消滅) は成功扱い (冪等・二重削除で握り潰さない)。
 *   - 一部失敗は failed に記録し ok:false (孤児を握り潰さず呼出側が再試行/記録できる)。
 */
export async function deleteSuccessPages(
  client: FormalooClient,
  slugs: string[],
): Promise<SuccessPageDeleteResult> {
  const deleted: string[] = [];
  const failed: string[] = [];
  let error: string | undefined;
  for (const slug of slugs) {
    if (!slug) continue;
    const r = await client.request('DELETE', `/v3.0/fields/${slug}/`);
    if (r.ok || r.status === 404) deleted.push(slug);
    else { failed.push(slug); error = error ?? `完了ページの削除に失敗しました (HTTP ${r.status})`; }
  }
  return { ok: failed.length === 0, deleted, failed, error };
}
