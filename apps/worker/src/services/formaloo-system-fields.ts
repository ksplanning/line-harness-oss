import { FRIEND_SYSTEM_FIELDS, isFriendSystemAlias, type FriendSystemFieldSpec } from '@line-crm/shared';
import { extractFieldsList } from './formaloo-pull.js';

// =============================================================================
// fr-id-capture-fix (R3/R4 / T-C2/T-C5/O-6) — friend system hidden field の冪等 ensure。
// -----------------------------------------------------------------------------
// planner LIVE spike で確定: Formaloo hosted prefill は field の **alias** でのみ URL param を捕捉する
// (slug 名 param は無効)。ゆえに /fo が付ける `?fr_id=<署名>` を row に載せるには、対象 form に
// alias='fr_id' の hidden field が実在しなければならない。本モジュールは publish 経路 (両テナント共通) が
// 呼ぶ冪等 ensure と、drift とは別建ての健全性チェック / 再 publish されない既存フォームの backfill 経路を提供する。
//
// 規律:
//   - **予約 alias ちょうど 1 件かつ type=hidden** を保証 (codex#4)。無→POST・正常既在→no-op・
//     衝突(visible/型違い/重複)→自動修復せず out_of_sync (fail-closed / codex#4)。
//   - POST 後 re-GET で exactly-one を確認 (POST 非2xx/timeout/201消失 を out_of_sync で surface / codex#14)。
//   - **additive only**: 既存 field を PATCH/DELETE しない。POST は新規 system field のみ。
//   - **fail-soft**: fields_list を読めない (GET 非ok / shape 不一致) は skipped で見送る (out_of_sync にしない・
//     回答導線 hot path を落とさない / codex#3 は「読めたのに欠落」を out_of_sync 化する分岐で担保)。
//   - **owner-gate**: fr_name は氏名=PII ゆえ includeOwnerGated=false で push しない (codex#8)。
// =============================================================================

/** ensure/backfill が使う FormalooClient の最小 surface (FormalooClient がこれを満たす / テストは mock)。 */
export interface SystemFieldClient {
  get<T = unknown>(path: string): Promise<{ ok: boolean; status: number; data?: T; error?: string }>;
  post<T = unknown>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data?: T; error?: string }>;
}

export type SystemFieldStatus = 'created' | 'present' | 'conflict' | 'error';
export interface SystemFieldOutcome {
  alias: string;
  status: SystemFieldStatus;
  detail?: string;
}
export interface SystemFieldEnsureResult {
  /** 対象 alias が全て exactly-one hidden で確定 (created|present) した。 */
  ok: boolean;
  /** conflict/error があり再試行対象 (silent success 禁止)。skipped は out_of_sync にしない。 */
  outOfSync: boolean;
  /** fields_list を読めず判定を見送った (fail-soft / hot path 保護)。 */
  skipped: boolean;
  outcomes: SystemFieldOutcome[];
}

export interface EnsureOptions {
  /** fr_name (PII owner-gate) も ensure するか。default true (fr_name auto-push は env で切れる / T-C1)。 */
  includeOwnerGated?: boolean;
}

/** raw Formaloo field 要素が予約 friend system field (alias 一致) か。 */
export function isFriendSystemField(field: unknown): boolean {
  if (!field || typeof field !== 'object') return false;
  return isFriendSystemAlias((field as { alias?: unknown }).alias);
}

/** ensure 対象の予約 field 群 (owner-gate 適用後)。 */
function targetFields(includeOwnerGated: boolean): readonly FriendSystemFieldSpec[] {
  return FRIEND_SYSTEM_FIELDS.filter((f) => (f.ownerGated ? includeOwnerGated : true));
}

/** raw fields_list から alias 一致要素を集める (type 判定込み)。 */
function matchesForAlias(list: unknown[], alias: string): { slug: string; type: string }[] {
  const out: { slug: string; type: string }[] = [];
  for (const el of list) {
    if (!el || typeof el !== 'object') continue;
    const o = el as Record<string, unknown>;
    if (o.alias === alias) {
      out.push({ slug: typeof o.slug === 'string' ? o.slug : '', type: typeof o.type === 'string' ? o.type : '' });
    }
  }
  return out;
}

/** GET /v3.0/forms/{slug}/ → fields_list (読めなければ null = skip 判定)。 */
async function fetchFieldsList(client: SystemFieldClient, formSlug: string): Promise<unknown[] | null> {
  const res = await client.get(`/v3.0/forms/${formSlug}/`);
  if (!res.ok) return null;
  return extractFieldsList(res.data);
}

/**
 * 予約 system hidden field (fr_id / fr_name) を冪等 ensure する。
 *  - 無 → POST {type:'hidden',alias,title,form} → re-GET で exactly-one 確認 → created。
 *  - 正常既在(type=hidden) → no-op (present)。
 *  - 衝突(visible/型違い/重複) → 自動修復せず conflict (out_of_sync / fail-closed)。
 *  - POST 失敗/201消失 → error (out_of_sync)。fields_list 読取不能 → skipped。throw しない。
 */
export async function ensureSystemHiddenFields(
  client: SystemFieldClient,
  formSlug: string,
  opts?: EnsureOptions,
): Promise<SystemFieldEnsureResult> {
  const includeOwnerGated = opts?.includeOwnerGated ?? true;
  const targets = targetFields(includeOwnerGated);
  const empty = (): SystemFieldEnsureResult => ({ ok: false, outOfSync: false, skipped: true, outcomes: [] });

  let list: unknown[] | null;
  try {
    list = await fetchFieldsList(client, formSlug);
  } catch {
    return empty(); // hot path 保護: 読取例外は見送り (回答導線を落とさない)
  }
  if (list === null) return empty();

  const outcomes: SystemFieldOutcome[] = [];
  const toCreate: FriendSystemFieldSpec[] = [];

  for (const spec of targets) {
    const m = matchesForAlias(list, spec.alias);
    if (m.length === 0) {
      toCreate.push(spec);
    } else if (m.length === 1) {
      if (m[0].type === 'hidden') outcomes.push({ alias: spec.alias, status: 'present' });
      else outcomes.push({ alias: spec.alias, status: 'conflict', detail: `alias 既在だが type=${m[0].type || 'unknown'} (hidden でない)` });
    } else {
      outcomes.push({ alias: spec.alias, status: 'conflict', detail: `alias 重複 ${m.length} 件` });
    }
  }

  if (toCreate.length > 0) {
    const postErrors: Record<string, string> = {};
    for (const spec of toCreate) {
      let res: { ok: boolean; status: number; error?: string };
      try {
        res = await client.post('/v3.0/fields/', { type: 'hidden', alias: spec.alias, title: spec.title, form: formSlug });
      } catch (e) {
        res = { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
      }
      if (!res.ok) postErrors[spec.alias] = `POST 失敗 HTTP ${res.status}${res.error ? ` (${res.error})` : ''}`;
    }
    // POST 後 re-GET で exactly-one を確認 (201消失/timeout-but-created/重複を determinisitc に判定 / codex#14)。
    let verifyList: unknown[] | null;
    try {
      verifyList = await fetchFieldsList(client, formSlug);
    } catch {
      verifyList = null;
    }
    for (const spec of toCreate) {
      if (verifyList === null) {
        outcomes.push({ alias: spec.alias, status: 'error', detail: postErrors[spec.alias] ?? 're-GET 不能で作成確認できず' });
        continue;
      }
      const m = matchesForAlias(verifyList, spec.alias);
      if (m.length === 1 && m[0].type === 'hidden') {
        outcomes.push({ alias: spec.alias, status: 'created' });
      } else if (m.length === 0) {
        outcomes.push({ alias: spec.alias, status: 'error', detail: postErrors[spec.alias] ?? 'POST 後も未作成 (201消失/timeout)' });
      } else if (m.length === 1) {
        outcomes.push({ alias: spec.alias, status: 'conflict', detail: `作成後 type=${m[0].type} (hidden でない)` });
      } else {
        outcomes.push({ alias: spec.alias, status: 'conflict', detail: `作成後 alias 重複 ${m.length} 件` });
      }
    }
  }

  const bad = outcomes.some((o) => o.status === 'conflict' || o.status === 'error');
  return { ok: !bad, outOfSync: bad, skipped: false, outcomes };
}

export type SystemFieldIssueKind = 'missing' | 'not_hidden' | 'duplicate';
export interface SystemFieldHealthResult {
  ok: boolean;
  issues: { alias: string; issue: SystemFieldIssueKind }[];
}

/**
 * T-C5(3): 通常 drift とは別建ての system-field 健全性チェック。fingerprint/drift は system field を除外するため
 * 削除/visible化/型変更/重複を検知できない。本チェックが raw fields_list に対し予約 alias が exactly-one hidden か
 * を監査する (drift cron や監査から呼ぶ純関数 / API 非依存)。
 */
export function checkSystemFieldHealth(rawFieldsList: unknown, opts?: EnsureOptions): SystemFieldHealthResult {
  const list = Array.isArray(rawFieldsList) ? rawFieldsList : [];
  const targets = targetFields(opts?.includeOwnerGated ?? true);
  const issues: { alias: string; issue: SystemFieldIssueKind }[] = [];
  for (const spec of targets) {
    const m = matchesForAlias(list, spec.alias);
    if (m.length === 0) issues.push({ alias: spec.alias, issue: 'missing' });
    else if (m.length > 1) issues.push({ alias: spec.alias, issue: 'duplicate' });
    else if (m[0].type !== 'hidden') issues.push({ alias: spec.alias, issue: 'not_hidden' });
  }
  return { ok: issues.length === 0, issues };
}

export interface BackfillResult {
  total: number;
  repaired: number;
  alreadyOk: number;
  outOfSync: string[];
  results: { formSlug: string; result: SystemFieldEnsureResult }[];
}

/**
 * O-6 code path: 再 publish されない既存フォームへ system hidden field を additive backfill する。
 * 呼び出し側 (owner_role: infra-ops) がテナント別稼働フォームの inventory (formSlugs) を供給し、本関数が各 form に
 * ensureSystemHiddenFields を適用して集計を返す。既存 field/回答は不可触 (additive only)。除外フォーム
 * (Z5IEH85R/puw7lh 等 owner 実フォーム) は呼び出し側が formSlugs から外す責務 (本関数は渡された slug のみ触る)。
 */
export async function backfillSystemHiddenFields(
  client: SystemFieldClient,
  formSlugs: string[],
  opts?: EnsureOptions,
): Promise<BackfillResult> {
  const results: { formSlug: string; result: SystemFieldEnsureResult }[] = [];
  let repaired = 0;
  let alreadyOk = 0;
  const outOfSync: string[] = [];
  for (const formSlug of formSlugs) {
    const result = await ensureSystemHiddenFields(client, formSlug, opts);
    results.push({ formSlug, result });
    if (result.outOfSync) outOfSync.push(formSlug);
    else if (result.skipped) { /* 見送り: repaired/alreadyOk どちらにも数えない */ }
    else if (result.outcomes.some((o) => o.status === 'created')) repaired += 1;
    else alreadyOk += 1;
  }
  return { total: formSlugs.length, repaired, alreadyOk, outOfSync, results };
}
