import { FRIEND_SYSTEM_FIELDS, isFriendSystemAlias, type FriendSystemFieldSpec } from '@line-crm/shared';
import { extractFieldsList, extractRawLogic } from './formaloo-pull.js';

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
//   - 既存の通常 field は PATCH/DELETE しない。位置ずれした system field だけ position=0 へ PATCH する。
//   - **fail-closed (T-C3 round2)**: fields_list を読めない (GET 非ok / 例外 / shape 不一致) は out_of_sync で surface する
//     (throw はしない = 回答導線 hot path を落とさない)。旧 skipped(silent) 挙動は closer 独立検証 (Codex) が
//     silent-success gap として発見。ensure は admin 保存経路のみで呼ばれ /fo 回答経路では呼ばれないため surface が正。
//   - **owner-gate**: fr_name は氏名=PII ゆえ includeOwnerGated=false で push しない (codex#8)。
//   - **T-C7 (grammar 実測 2026-07-19)**: is_answered(X)→submit は X 以降の field を保存しない。
//     fr_id を先頭へ固定すれば共存でき、fr_id が X より後ろの場合だけ logicConflict を surface する。
// =============================================================================

/** ensure/backfill が使う FormalooClient の最小 surface (FormalooClient がこれを満たす / テストは mock)。 */
export interface SystemFieldClient {
  get<T = unknown>(path: string): Promise<{ ok: boolean; status: number; data?: T; error?: string }>;
  post<T = unknown>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data?: T; error?: string }>;
  /** fr-id-hardening-round2 (O-6 ④): alias=slug backfill の PATCH に使う (ensure/health は不要ゆえ optional)。 */
  request?<T = unknown>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data?: T; error?: string }>;
}

export type SystemFieldStatus = 'created' | 'repositioned' | 'present' | 'conflict' | 'error';
export interface SystemFieldOutcome {
  alias: string;
  status: SystemFieldStatus;
  detail?: string;
}
export interface SystemFieldEnsureResult {
  /** 対象 alias が全て exactly-one hidden + 先頭で確定 (created|repositioned|present) した。 */
  ok: boolean;
  /**
   * conflict/error/読取不能があり再試行対象 (silent success 禁止)。
   * T-C3 round2: form-state fetch 失敗/読取不能も fail-closed で outOfSync=true にする (closer 独立検証 Codex 発見の
   * silent-success gap 是正)。ensure は admin 保存経路のみで呼ばれ /fo 回答 hot path では呼ばれないため surface は
   * 回答導線を落とさない。
   */
  outOfSync: boolean;
  /** fields_list を読めず判定を見送った (fetch 失敗時は skipped=false・outOfSync=true で surface する / T-C3 round2)。 */
  skipped: boolean;
  /**
   * T-C7: fr_id が is_answered→submit のトリガーより後ろにあり、保存対象外になる時だけ true。
   */
  logicConflict: boolean;
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

interface SystemFieldMatch {
  slug: string;
  type: string;
  position: number | null;
}

/** raw fields_list から alias 一致要素を集める (type/position 判定込み)。 */
function matchesForAlias(list: unknown[], alias: string): SystemFieldMatch[] {
  const out: SystemFieldMatch[] = [];
  for (const el of list) {
    if (!el || typeof el !== 'object') continue;
    const o = el as Record<string, unknown>;
    if (o.alias === alias) {
      out.push({
        slug: typeof o.slug === 'string' ? o.slug : '',
        type: typeof o.type === 'string' ? o.type : '',
        position: typeof o.position === 'number' && Number.isFinite(o.position) ? o.position : null,
      });
    }
  }
  return out;
}

/**
 * Formaloo は複数 field へ順に position=0 を適用すると 0,1,... に再採番することがある。
 * そのため spec 順の prefix (fr_id=0, fr_name<=1) を「先頭」として受理する。position 欠落時は前後関係を
 * 証明できないため fail-closed とする。
 */
function isAtSystemPrefix(match: SystemFieldMatch, targetIndex: number, list: unknown[]): boolean {
  if (match.position === null) return false;
  const regularFields = list.filter(
    (field) => field && typeof field === 'object' && !isFriendSystemAlias((field as Record<string, unknown>).alias),
  ) as Record<string, unknown>[];
  if (regularFields.some((field) => typeof field.position !== 'number' || !Number.isFinite(field.position))) return false;
  const regularPositions = regularFields.map((field) => field.position as number);
  const firstRegularPosition = regularPositions.length > 0 ? Math.min(...regularPositions) : null;
  return match.position <= targetIndex && (firstRegularPosition === null || match.position < firstRegularPosition);
}

/**
 * GET /v3.0/forms/{slug}/ → fields_list + raw logic (読めなければ fields=null = skip 判定)。
 */
async function fetchFormState(
  client: SystemFieldClient,
  formSlug: string,
): Promise<{ fields: unknown[] | null; rawLogic: unknown[] | null }> {
  const res = await client.get(`/v3.0/forms/${formSlug}/`);
  if (!res.ok) return { fields: null, rawLogic: null };
  return { fields: extractFieldsList(res.data), rawLogic: extractRawLogic(res.data) };
}

/** is_answered(X)→submit は X 以降を保存しないため、fr_id が X より後ろにある時だけ競合とする。 */
function hasSubmitPositionConflict(list: unknown[], rawLogic: unknown): boolean {
  const frId = matchesForAlias(list, 'fr_id');
  if (frId.length !== 1 || frId[0].type !== 'hidden' || frId[0].position === null || !Array.isArray(rawLogic)) return false;

  const positions = new Map<string, number>();
  for (const field of list) {
    if (!field || typeof field !== 'object') continue;
    const raw = field as Record<string, unknown>;
    if (typeof raw.slug === 'string' && typeof raw.position === 'number' && Number.isFinite(raw.position)) positions.set(raw.slug, raw.position);
  }

  for (const item of rawLogic) {
    if (!item || typeof item !== 'object') continue;
    const actions = (item as Record<string, unknown>).actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      if (!action || typeof action !== 'object') continue;
      const rawAction = action as Record<string, unknown>;
      if (rawAction.action !== 'submit' || !Array.isArray(rawAction.args) || rawAction.args.length !== 0) continue;
      const when = rawAction.when;
      if (!when || typeof when !== 'object') continue;
      const rawWhen = when as Record<string, unknown>;
      if (rawWhen.operation !== 'is_answered' || !Array.isArray(rawWhen.args) || rawWhen.args.length !== 1) continue;
      const operand = rawWhen.args[0];
      if (!operand || typeof operand !== 'object') continue;
      const rawOperand = operand as Record<string, unknown>;
      if (rawOperand.type !== 'field' || typeof rawOperand.value !== 'string') continue;
      const triggerPosition = positions.get(rawOperand.value);
      if (triggerPosition !== undefined && frId[0].position > triggerPosition) return true;
    }
  }
  return false;
}

/**
 * 予約 system hidden field (fr_id / fr_name) を冪等 ensure する。
 *  - 無 → POST {type:'hidden',alias,title,form,position:0} → re-GET で exactly-one/先頭を確認 → created。
 *  - 位置ずれ → PATCH {position:0} → re-GET で先頭を確認 → repositioned。
 *  - 正常既在(type=hidden) → no-op (present)。
 *  - 衝突(visible/型違い/重複) → 自動修復せず conflict (out_of_sync / fail-closed)。
 *  - POST 失敗/201消失 → error (out_of_sync)。fields_list 読取不能 → out_of_sync (fail-closed / T-C3 round2)。throw しない。
 */
export async function ensureSystemHiddenFields(
  client: SystemFieldClient,
  formSlug: string,
  opts?: EnsureOptions,
): Promise<SystemFieldEnsureResult> {
  const includeOwnerGated = opts?.includeOwnerGated ?? true;
  const targets = targetFields(includeOwnerGated);
  // T-C3 round2 (fail-closed): form-state を読めない (GET 非ok / 例外 / shape 不一致) は「system field が
  //   本当に揃っているか不明」= silent success を絶対に許さない → outOfSync=true で surface する (throw はしない
  //   ゆえ publish 本体=回答導線は落とさない)。旧 skipped:true/outOfSync:false は closer 独立検証 (Codex) が
  //   silent-success gap として発見した挙動。
  const unreadable = (): SystemFieldEnsureResult => ({ ok: false, outOfSync: true, skipped: false, logicConflict: false, outcomes: [] });

  let state: { fields: unknown[] | null; rawLogic: unknown[] | null };
  try {
    state = await fetchFormState(client, formSlug);
  } catch {
    return unreadable(); // 読取例外を握り潰して成功にしない (fail-closed surface)
  }
  if (state.fields === null) return unreadable();
  const list = state.fields;
  let finalFields = list;
  let finalRawLogic = state.rawLogic;

  type InitialDisposition = 'create' | 'reposition' | 'present' | 'conflict';
  const initialDisposition = new Map<string, InitialDisposition>();
  const initialConflictDetails = new Map<string, string>();
  const toCreate: FriendSystemFieldSpec[] = [];
  const toReposition: { spec: FriendSystemFieldSpec; slug: string }[] = [];

  for (const [targetIndex, spec] of targets.entries()) {
    const m = matchesForAlias(list, spec.alias);
    if (m.length === 0) {
      toCreate.push(spec);
      initialDisposition.set(spec.alias, 'create');
    } else if (m.length === 1) {
      if (m[0].type === 'hidden' && !isAtSystemPrefix(m[0], targetIndex, list)) {
        toReposition.push({ spec, slug: m[0].slug });
        initialDisposition.set(spec.alias, 'reposition');
      } else if (m[0].type === 'hidden') {
        initialDisposition.set(spec.alias, 'present');
      } else {
        initialDisposition.set(spec.alias, 'conflict');
        initialConflictDetails.set(spec.alias, `alias 既在だが type=${m[0].type || 'unknown'} (hidden でない)`);
      }
    } else {
      initialDisposition.set(spec.alias, 'conflict');
      initialConflictDetails.set(spec.alias, `alias 重複 ${m.length} 件`);
    }
  }

  type SystemFieldMutation =
    | { kind: 'create'; spec: FriendSystemFieldSpec; slug: '' }
    | { kind: 'reposition'; spec: FriendSystemFieldSpec; slug: string };
  const mutations: SystemFieldMutation[] = [];
  for (const spec of targets) {
    if (toCreate.includes(spec)) mutations.push({ kind: 'create', spec, slug: '' });
    const reposition = toReposition.find((candidate) => candidate.spec === spec);
    if (reposition) mutations.push({ kind: 'reposition', spec, slug: reposition.slug });
  }
  mutations.reverse(); // position=0 を後から適用した fr_id が最終的に先頭となるよう fr_name→fr_id の順で mutate。

  const mutationErrors: Record<string, string> = {};
  const normalizedAliases = new Set<string>();
  const mutate = async (mutation: SystemFieldMutation): Promise<void> => {
    const { spec } = mutation;
    let res: { ok: boolean; status: number; error?: string };
    try {
      res = mutation.kind === 'create'
        ? await client.post('/v3.0/fields/', { type: spec.type, alias: spec.alias, title: spec.title, form: formSlug, position: spec.position })
        : client.request
          ? await client.request('PATCH', `/v3.0/fields/${mutation.slug}/`, { position: spec.position })
          : { ok: false, status: 0, error: 'client.request 未実装 (position PATCH 不能)' };
    } catch (e) {
      res = { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
    if (!res.ok) {
      const operation = mutation.kind === 'create' ? 'POST' : 'position PATCH';
      mutationErrors[spec.alias] = `${operation} 失敗 HTTP ${res.status}${res.error ? ` (${res.error})` : ''}`;
    }
  };

  let verificationFailed = false;
  if (mutations.length > 0) {
    for (const mutation of mutations) await mutate(mutation);
    // mutate 後 re-GET で全 target を再検証する。1 field の先頭挿入で既存 system field が押し下がる場合も見逃さない。
    try {
      const verifyState = await fetchFormState(client, formSlug);
      if (verifyState.fields !== null) {
        finalFields = verifyState.fields;
        finalRawLogic = verifyState.rawLogic;
      } else {
        verificationFailed = true;
      }
    } catch {
      verificationFailed = true;
    }

    if (!verificationFailed) {
      const normalization: SystemFieldMutation[] = [];
      for (const [targetIndex, spec] of targets.entries()) {
        const m = matchesForAlias(finalFields, spec.alias);
        if (m.length === 1 && m[0].type === 'hidden' && !isAtSystemPrefix(m[0], targetIndex, finalFields) && m[0].slug) {
          normalization.push({ kind: 'reposition', spec, slug: m[0].slug });
        }
      }
      normalization.reverse();
      if (normalization.length > 0) {
        for (const mutation of normalization) {
          normalizedAliases.add(mutation.spec.alias);
          await mutate(mutation);
        }
        try {
          const normalizedState = await fetchFormState(client, formSlug);
          if (normalizedState.fields !== null) {
            finalFields = normalizedState.fields;
            finalRawLogic = normalizedState.rawLogic;
          } else {
            verificationFailed = true;
          }
        } catch {
          verificationFailed = true;
        }
      }
    }
  }

  const outcomes: SystemFieldOutcome[] = [];
  for (const [targetIndex, spec] of targets.entries()) {
    const disposition = initialDisposition.get(spec.alias);
    if (verificationFailed) {
      if (disposition === 'conflict') outcomes.push({ alias: spec.alias, status: 'conflict', detail: initialConflictDetails.get(spec.alias) });
      else outcomes.push({ alias: spec.alias, status: 'error', detail: mutationErrors[spec.alias] ?? 're-GET 不能で最終位置を確認できず' });
      continue;
    }

    const m = matchesForAlias(finalFields, spec.alias);
    if (m.length === 0) {
      outcomes.push({ alias: spec.alias, status: 'error', detail: mutationErrors[spec.alias] ?? 'mutate 後も未作成 (201消失/timeout)' });
    } else if (m.length > 1) {
      outcomes.push({ alias: spec.alias, status: 'conflict', detail: `alias 重複 ${m.length} 件` });
    } else if (m[0].type !== 'hidden') {
      outcomes.push({ alias: spec.alias, status: 'conflict', detail: `alias 既在だが type=${m[0].type || 'unknown'} (hidden でない)` });
    } else if (!isAtSystemPrefix(m[0], targetIndex, finalFields)) {
      outcomes.push({ alias: spec.alias, status: 'error', detail: mutationErrors[spec.alias] ?? `position=${m[0].position ?? 'unknown'} (先頭を確認できない)` });
    } else if (disposition === 'create') {
      outcomes.push({ alias: spec.alias, status: 'created' });
    } else if (disposition === 'reposition' || normalizedAliases.has(spec.alias)) {
      outcomes.push({ alias: spec.alias, status: 'repositioned' });
    } else {
      outcomes.push({ alias: spec.alias, status: 'present' });
    }
  }

  const bad = outcomes.some((o) => o.status === 'conflict' || o.status === 'error');
  const logicConflict = hasSubmitPositionConflict(finalFields, finalRawLogic);
  // is_answered→submit のトリガーより fr_id が後ろなら、その回答が保存対象外になるため out_of_sync で surface する。
  return { ok: !bad && !logicConflict, outOfSync: bad || logicConflict, skipped: false, logicConflict, outcomes };
}

export type SystemFieldIssueKind = 'missing' | 'not_hidden' | 'duplicate' | 'not_first';
export interface SystemFieldHealthResult {
  ok: boolean;
  issues: { alias: string; issue: SystemFieldIssueKind }[];
  /**
   * T-C7: is_answered→submit のトリガー位置より fr_id が後ろなら true。先頭固定なら logic と共存できる。
   */
  logicConflict: boolean;
}

/**
 * T-C5(3): 通常 drift とは別建ての system-field 健全性チェック。fingerprint/drift は system field を除外するため
 * 削除/visible化/型変更/重複を検知できない。本チェックが raw fields_list に対し予約 alias が exactly-one hidden か
 * を監査する (drift cron や監査から呼ぶ純関数 / API 非依存)。
 * T-C7: rawLogic を渡すと is_answered→submit host と fr_id の position を比較し、fr_id が後ろの場合だけ surface する。
 */
export function checkSystemFieldHealth(rawFieldsList: unknown, opts?: EnsureOptions, rawLogic?: unknown): SystemFieldHealthResult {
  const list = Array.isArray(rawFieldsList) ? rawFieldsList : [];
  const targets = targetFields(opts?.includeOwnerGated ?? true);
  const issues: { alias: string; issue: SystemFieldIssueKind }[] = [];
  for (const [targetIndex, spec] of targets.entries()) {
    const m = matchesForAlias(list, spec.alias);
    if (m.length === 0) issues.push({ alias: spec.alias, issue: 'missing' });
    else if (m.length > 1) issues.push({ alias: spec.alias, issue: 'duplicate' });
    else if (m[0].type !== 'hidden') issues.push({ alias: spec.alias, issue: 'not_hidden' });
    else if (!isAtSystemPrefix(m[0], targetIndex, list)) issues.push({ alias: spec.alias, issue: 'not_first' });
  }
  const logicConflict = hasSubmitPositionConflict(list, rawLogic);
  return { ok: issues.length === 0 && !logicConflict, issues, logicConflict };
}

export interface BackfillResult {
  total: number;
  repaired: number;
  alreadyOk: number;
  outOfSync: string[];
  results: { formSlug: string; result: SystemFieldEnsureResult }[];
}

/**
 * O-6 code path: 再 publish されない既存フォームへ system hidden field を backfill する。
 * 呼び出し側 (owner_role: infra-ops) がテナント別稼働フォームの inventory (formSlugs) を供給し、本関数が各 form に
 * ensureSystemHiddenFields を適用して集計を返す。通常 field/回答は不可触で、予約 system field の追加・位置修復だけを行う。除外フォーム
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
    else if (result.outcomes.some((o) => o.status === 'created' || o.status === 'repositioned')) repaired += 1;
    else alreadyOk += 1;
  }
  return { total: formSlugs.length, repaired, alreadyOk, outOfSync, results };
}

// =============================================================================
// fr-id-hardening-round2 (④ / O-6 同梱): 既存フォームの **全 answer field に alias=slug** を冪等 backfill する経路。
// -----------------------------------------------------------------------------
// Formaloo hosted の URL prefill は field の alias 一致でのみ発火し、/fo は本人再入場の回答 prefill を field slug を
// キーに組む (?<slug>=<value>)。既存フォームは createField を通らない (再 publish されない) ため alias=null のままで
// 回答 prefill が全滅する。本経路が各 field に `alias=slug` を PATCH 付与し、併せて fr_id/fr_name system field を
// ensureSystemHiddenFields で冪等付与する。
//   - **dry-run 既定** (dryRun:true): 一切 mutate せず、alias 付与対象 field と system field の現状 (health) を列挙する
//     のみ (owner が対象を確認して GO を判断 = 本番一括実行は generator がしない)。
//   - **execute** (dryRun:false / owner GO 後): 対象 field に PATCH {alias:slug} + ensureSystemHiddenFields を実行。
//   - **対象外**: friend system field (fr_id/fr_name は意図的に非 slug alias) / success_page / 既に alias=slug の field。
//   - alias 追加は fingerprint/pull に不可視 = false-drift ゼロ。除外フォーム (Z5IEH85R/puw7lh) は呼び出し側が formSlugs
//     から外す責務 (本関数は渡された slug のみ触る)。
// =============================================================================

/** raw fields_list から alias=slug backfill 対象 field を列挙する (friend-system / success_page / 既 alias=slug は除外)。 */
function fieldAliasCandidates(list: unknown[]): { slug: string; currentAlias: string | null }[] {
  const out: { slug: string; currentAlias: string | null }[] = [];
  for (const el of list) {
    if (!el || typeof el !== 'object') continue;
    const o = el as Record<string, unknown>;
    const slug = typeof o.slug === 'string' ? o.slug : '';
    if (!slug) continue;
    if (isFriendSystemField(o)) continue; // fr_id/fr_name は意図的に非 slug alias (予約) ゆえ触らない
    if (o.type === 'success_page') continue; // 完了ページは回答 field でない
    const alias = typeof o.alias === 'string' ? o.alias : null;
    if (alias === slug) continue; // 既に alias=slug = 冪等 no-op
    out.push({ slug, currentAlias: alias });
  }
  return out;
}

export interface FieldAliasBackfillFormResult {
  formSlug: string;
  /** fields_list を読めず見送った (GET 非ok / shape 不一致)。 */
  skipped: boolean;
  /** alias=slug が必要な field (dry-run/execute 双方で列挙)。 */
  fieldsNeedingAlias: { slug: string; currentAlias: string | null }[];
  /** fr_id/fr_name system field の現状健全性 (missing/not_hidden/duplicate/not_first/logicConflict)。 */
  systemFieldHealth: SystemFieldHealthResult;
  /** execute で alias PATCH 成功した field 数 (dry-run は 0)。 */
  patched: number;
  /** execute で alias PATCH 失敗した field。 */
  failed: { slug: string; error: string }[];
  /** execute で実行した ensureSystemHiddenFields の結果 (dry-run は未載)。 */
  systemFields?: SystemFieldEnsureResult;
}
export interface FieldAliasBackfillResult {
  dryRun: boolean;
  total: number;                    // 処理した form 数
  totalFieldsNeedingAlias: number;  // 全 form 合計の alias 付与対象 field 数
  totalPatched: number;             // execute で PATCH 成功した field 総数
  forms: FieldAliasBackfillFormResult[];
}

/**
 * ④ 既存フォームの全 answer field に alias=slug を冪等 backfill する (dry-run 既定)。
 * @param formSlugs テナント別稼働フォームの inventory (除外フォームは呼び出し側が外す)。
 * @param opts.dryRun 既定 true = 一切 mutate せず対象列挙のみ。false (owner GO) で PATCH/ensure を実行。
 * @param opts.includeOwnerGated fr_name (氏名=PII) も付与するか。**既定 false (PII 安全側)**: bulk backfill で
 *   PII opt-out テナント (FORMALOO_FR_NAME_AUTOPUSH_DISABLE=1) に対し fr_name (実名) field を gate 外で作ると、
 *   /fo が fr_name を必ず付与し実名保存が始まってしまう。fr_name は親案件で owner 要確認に昇格したゆえ、呼び出し側が
 *   明示 true を渡した時のみ ensure/health 対象にする (opt-in / codex#8 と整合)。
 */
export async function backfillFieldAliases(
  client: SystemFieldClient,
  formSlugs: string[],
  opts?: EnsureOptions & { dryRun?: boolean },
): Promise<FieldAliasBackfillResult> {
  const dryRun = opts?.dryRun ?? true; // 既定 dry-run: 本番一括実行は owner GO 後にのみ dryRun:false で呼ぶ
  const includeOwnerGated = opts?.includeOwnerGated ?? false; // PII 安全側: fr_name は明示 opt-in の時のみ (P1 / codex#8)
  const forms: FieldAliasBackfillFormResult[] = [];
  let totalFieldsNeedingAlias = 0;
  let totalPatched = 0;

  for (const formSlug of formSlugs) {
    let res: { ok: boolean; status: number; data?: unknown };
    try {
      res = await client.get(`/v3.0/forms/${formSlug}/`);
    } catch {
      forms.push({ formSlug, skipped: true, fieldsNeedingAlias: [], systemFieldHealth: { ok: false, issues: [], logicConflict: false }, patched: 0, failed: [] });
      continue;
    }
    const fields = res.ok ? extractFieldsList(res.data) : null;
    if (fields === null) {
      forms.push({ formSlug, skipped: true, fieldsNeedingAlias: [], systemFieldHealth: { ok: false, issues: [], logicConflict: false }, patched: 0, failed: [] });
      continue;
    }
    const rawLogic = extractRawLogic(res.data);
    const candidates = fieldAliasCandidates(fields);
    const health = checkSystemFieldHealth(fields, { includeOwnerGated }, rawLogic);
    totalFieldsNeedingAlias += candidates.length;

    const failed: { slug: string; error: string }[] = [];
    let patched = 0;
    let systemFields: SystemFieldEnsureResult | undefined;

    if (!dryRun) {
      // execute: 各対象 field に PATCH {alias:slug} (additive・既存 alias 上書きは対象を alias!==slug に絞ってあるゆえ発生しない)。
      for (const cand of candidates) {
        try {
          const pr = client.request
            ? await client.request('PATCH', `/v3.0/fields/${cand.slug}/`, { alias: cand.slug })
            : { ok: false, status: 0, error: 'client.request 未実装 (PATCH 不能)' };
          if (pr.ok) patched += 1;
          else failed.push({ slug: cand.slug, error: `alias PATCH 失敗 HTTP ${pr.status}${pr.error ? ` (${pr.error})` : ''}` });
        } catch (e) {
          failed.push({ slug: cand.slug, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // fr_id/fr_name system field も冪等付与 (再 publish されないフォームの system field 抜けも同時に埋める)。
      systemFields = await ensureSystemHiddenFields(client, formSlug, { includeOwnerGated });
      totalPatched += patched;
    }

    forms.push({ formSlug, skipped: false, fieldsNeedingAlias: candidates, systemFieldHealth: health, patched, failed, ...(systemFields ? { systemFields } : {}) });
  }

  return { dryRun, total: formSlugs.length, totalFieldsNeedingAlias, totalPatched, forms };
}
