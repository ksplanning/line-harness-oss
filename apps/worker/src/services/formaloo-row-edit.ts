import type { UpsertFormalooSubmissionInput } from '@line-crm/db';
import { isDecorationType } from '@line-crm/shared';
import { verifyFriendToken } from './formaloo-friend-token.js';
import { renderedAliasValue, FRIEND_TOKEN_ALIAS } from './formaloo-webhook.js';

// =============================================================================
// Formaloo row 編集 純関数群 (弾M form-post-edit / T-B1)
// -----------------------------------------------------------------------------
// ①管理者編集の core ロジックを副作用なしで括り出す (単体テスト可能・edit endpoint が組み立てる)。
//   - buildFlatRowPatchBody: D1 answer → **flat top-level field-slug map** (`{data:{}}` で包まない = soft-200
//     回避の要 / planner 実測1)。free-value 型のみ (choice/dropdown/multiple_select/file は label 送信が
//     silent 無視されるため除外 / R-i)。answer キーが slug でなければ fieldMap で slug へ変換 (S-1 結論 / R-h)。
//   - resolveRowSlug: (a) stored formaloo_row_slug 優先 (b) NULL は rows-list submit_code 照合で解決
//     (c) 照合不能は null。row_slug は編集の唯一有効な addressing (submit_code は 404 / 実測3)。
//   - findEmptyRequired: 必須項目を空で保存しようとしたら止める (Formaloo は REST edit で required 非強制ゆえ
//     harness 側で検証 / 実測2)。
// =============================================================================

/**
 * 編集対象にできる free-value 型 (harness field type)。
 * choice/dropdown/multiple_select/file は choice-slug 解決が要り label 送信は silent 無視 = soft 失敗ゆえ除外
 * (弾M+ で choice-slug map を用意して対応)。section/page_break は装飾で回答値なし。
 */
export const FREE_VALUE_FIELD_TYPES: ReadonlySet<string> = new Set([
  'text', 'textarea', 'number', 'email', 'phone', 'date',
]);

export function isEditableFieldType(fieldType: string): boolean {
  return FREE_VALUE_FIELD_TYPES.has(fieldType);
}

/** あと編集 (①管理者編集 + ②本人再入場) の全体 kill-switch 判定 (未設定=無効 fail-closed / 単一正本)。 */
export function isPostEditEnabled(flag: string | undefined | null): boolean {
  return flag === 'true' || flag === '1';
}

// =============================================================================
// form-response-display-fix (T-A1): field slug→label 解決の共有 join。
//   回答データ画面 (cockpit) の列ヘッダー label 化 (/rows の additive fields) と、
//   回答詳細の編集コンテキスト (buildRowEditContext) が同じ「定義 fields × field_map slug」の join を要する。
//   二重管理を避けるため純関数として括り出し、両者が共有する (DRY)。
// =============================================================================

/** field_map row の slug 解決に要る最小形 (formaloo_field_map の id + formaloo_field_slug)。 */
export interface FieldSlugMapEntry {
  /** harness field id (定義 field.id と join するキー)。 */
  id: string;
  /** Formaloo field slug (未 push フォームは null)。 */
  formaloo_field_slug: string | null;
}

/** join 入力の定義 field 最小形 (harness id + label + type + required)。 */
export interface DefinitionFieldForJoin {
  id: string;
  label: string;
  type: string;
  required?: boolean;
}

/** join 済 field メタ (slug 非 null 保証)。 */
export interface JoinedFieldMeta {
  slug: string;
  label: string;
  type: string;
  required: boolean;
  editable: boolean;
}

/**
 * 定義 fields を field_map の formaloo_field_slug で join し、richer な field メタ list を作る (純関数)。
 *   - 装飾 (section/page_break/video/image) は除外 (回答値なし)。
 *   - slug 未 push (null) は除外 (回答キーに現れず addressable でない)。
 *   - 定義順 (質問順) を保持。
 * buildRowEditContext (編集コンテキスト) と /rows の fields (列ヘッダー) が共有する唯一の join。
 */
export function joinDefinitionFieldsWithSlug(
  fieldMap: FieldSlugMapEntry[],
  fields: DefinitionFieldForJoin[],
): JoinedFieldMeta[] {
  const slugById = new Map<string, string | null>();
  for (const r of fieldMap) slugById.set(r.id, r.formaloo_field_slug);
  return fields
    .filter((f) => !isDecorationType(f.type))
    .map((f) => ({
      slug: (slugById.get(f.id) ?? null) as string | null,
      label: f.label,
      type: f.type,
      required: f.required === true,
      editable: isEditableFieldType(f.type),
    }))
    .filter((f): f is JoinedFieldMeta => f.slug != null);
}

/**
 * 列ヘッダー表示用の {slug,label} list (回答データ画面 /rows の additive fields)。
 * joinDefinitionFieldsWithSlug の {slug,label} 射影 (装飾/slug 無し除外・定義順)。
 */
export function buildFieldLabelList(
  fieldMap: FieldSlugMapEntry[],
  fields: DefinitionFieldForJoin[],
): Array<{ slug: string; label: string }> {
  return joinDefinitionFieldsWithSlug(fieldMap, fields).map((f) => ({ slug: f.slug, label: f.label }));
}

/**
 * reconcile-pull の friend_id 復元に使う実効 secret を解決する (line-reentry-prefill-fix / Layer A rollback)。
 *   `FORMALOO_RECONCILE_FRIEND_LINK_DISABLE='true'` の時は **null** を返す = friend_id 復元だけを緊急停止
 *   (reconcile のミラー充填自体は継続 = 一覧表示は従来通り)。secret 未設定も null (fail-closed)。単一正本。
 */
export function friendLinkSecret(env: {
  FORMALOO_FRIEND_TOKEN_SECRET?: string | null;
  FORMALOO_RECONCILE_FRIEND_LINK_DISABLE?: string;
}): string | null {
  if (env.FORMALOO_RECONCILE_FRIEND_LINK_DISABLE === 'true') return null;
  return env.FORMALOO_FRIEND_TOKEN_SECRET ?? null;
}

/** 編集判定に要る最小 field メタ (formaloo_field_map + definition から endpoint が組む)。 */
export interface EditFieldMeta {
  /** harness field id。 */
  id: string;
  /** Formaloo field slug (未 push フォームは null)。 */
  slug: string | null;
  /** harness field type (text/textarea/number/email/phone/date/choice/dropdown/multiple_select/file/...)。 */
  fieldType: string;
  /** 必須か (definition 由来)。 */
  required?: boolean;
}

/**
 * 編集後 answers を **flat top-level slug-keyed map** に射影する (soft-200 回避の要)。
 * - answer キーが既知 slug → そのまま採用 / harness field id → fieldMap で slug へ変換 / それ以外 → 除外。
 * - free-value 型のみ採用 (choice/dropdown/multiple_select/file/装飾は除外)。
 * - `{data:{...}}` で **包まない** (研究の soft-200 の真因)。
 */
export function buildFlatRowPatchBody(
  answers: Record<string, unknown>,
  fields: EditFieldMeta[],
): Record<string, unknown> {
  const knownSlugs = new Set<string>();
  const idToSlug = new Map<string, string>();
  const typeBySlug = new Map<string, string>();
  for (const f of fields) {
    if (!f.slug) continue;
    knownSlugs.add(f.slug);
    idToSlug.set(f.id, f.slug);
    typeBySlug.set(f.slug, f.fieldType);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    // slug 解決: 既知 slug 先勝ち (answers は slug-keyed が基本) → harness id → 未知は除外。
    const slug = knownSlugs.has(key) ? key : idToSlug.get(key);
    if (!slug) continue;
    const type = typeBySlug.get(slug);
    if (!type || !isEditableFieldType(type)) continue; // free-value 型のみ
    out[slug] = value;
  }
  return out;
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * 必須検証 (Formaloo は REST edit で required 非強制ゆえ harness 側で担保)。
 * patchBody に含まれ **かつ** 必須 **かつ** 空値の slug を返す (= 保存を止める対象)。
 * body に無い必須 slug は「触っていない項目」= 既存値保持ゆえ対象外 (部分更新)。
 */
export function findEmptyRequired(patchBody: Record<string, unknown>, requiredSlugs: ReadonlySet<string>): string[] {
  return Object.keys(patchBody).filter((slug) => requiredSlugs.has(slug) && isEmptyValue(patchBody[slug]));
}

/**
 * row_slug 解決の 3 経路 (編集の唯一有効 addressing = row_slug / submit_code は 404 / 実測3)。
 *   (a) stored formaloo_row_slug present → 即返す。
 *   (b) NULL (legacy) → rowsListResolver(submit_code) で rows-list 照合し slug 解決。
 *   (c) 照合不能 → null (endpoint 側で正直エラー = 殻完了を出さない)。
 */
export async function resolveRowSlug(
  submission: { id: string; formaloo_row_slug: string | null },
  rowsListResolver: (submitCode: string) => Promise<string | null>,
): Promise<string | null> {
  if (submission.formaloo_row_slug) return submission.formaloo_row_slug;
  return rowsListResolver(submission.id);
}

/** rows-list scan で扱う最小 client 契約 (FormalooClient.get と構造互換)。 */
export interface RowsListGetClient {
  get<T = unknown>(path: string): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; error: string }>;
}

interface RowsListResolverOptions {
  /** 走査する最大ページ数 (bounded backfill = 無限走査しない / R-k)。 */
  maxPages?: number;
  /** ページサイズ。 */
  pageSize?: number;
}

export function extractRows(data: unknown): Array<Record<string, unknown>> {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return [];
  const candidates: unknown[] = [
    (d.data as Record<string, unknown> | undefined)?.rows,
    d.rows,
    d.data,
    d.results,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  }
  return [];
}

/**
 * legacy row (formaloo_row_slug=NULL) を rows-list の submit_code 照合で解決する resolver factory。
 * bounded page scan (maxPages) で submit_code 一致 row の slug を返す。専用 submit_code フィルタ API の有無は
 * live 未確定ゆえ、直近ページを上限走査する防御実装 (見つからねば null → endpoint が正直エラー / R-k)。
 */
export function makeRowsListRowSlugResolver(
  client: RowsListGetClient,
  formSlug: string,
  opts: RowsListResolverOptions = {},
): (submitCode: string) => Promise<string | null> {
  const maxPages = opts.maxPages ?? 5;
  const pageSize = opts.pageSize ?? 25;
  return async (submitCode: string): Promise<string | null> => {
    if (!submitCode) return null;
    for (let page = 1; page <= maxPages; page++) {
      const r = await client.get(`/v3.0/forms/${formSlug}/rows/?page=${page}&page_size=${pageSize}`);
      if (!r.ok) return null; // fail-safe (誤 slug を返すより null で正直エラーへ)
      const rows = extractRows(r.data);
      if (rows.length === 0) break; // これ以上ページなし
      for (const row of rows) {
        if (row.submit_code === submitCode || row.id === submitCode) {
          const slug = row.slug;
          if (typeof slug === 'string' && slug) return slug;
        }
      }
    }
    return null;
  };
}

/**
 * rows-list の 1 row を回答ミラー upsert 入力へ写像する (submissions-visibility-fix / T-A6)。
 * S-1 live 実測 shape (2026-07-17 / form GMOxoMtK) に基づく:
 *   - answers  = `row.data` (field-slug キーの flat map)。
 *   - addressable id = `row.slug` (20ch)。詳細 drill `/v3.0/rows/{slug}/` が 200 で解決する唯一の値
 *     (submit_code は 404 / `/v3.0/forms/{slug}/rows/{slug}/` も 404 = S-1 実測)。ゆえ mirror id も row.slug。
 *   - submittedAt = `row.created_at` (ISO)。
 *   - friendId (line-reentry-prefill-fix / Layer A): pull 行の**署名 fr_id を verify 成功時のみ**復元する。
 *     webhook 未配線テナント (piecemaker) では reconcile-pull が friend_id を設定する唯一経路になるため、
 *     webhook path と同一の `renderedAliasValue`+`verifyFriendToken` で fr_id を検証し friend_id を得る。
 *     **fail-closed**: secret 未供給 / alias 欠落 / 改ざん / 別鍵署名 は friend_id=null のまま
 *     (他人の回答を prefill する取り違え=PII を絶対に起こさない / 弾M F-H1 継承)。opts 未指定は従来 byte 同等
 *     (friend_id=null)。fr_id present 行のみ crypto を回す (CI-3: reconcile ループの CPU 予算保護)。
 *   - verified=false: pull 由来は未署名扱いのまま (LINE 後処理は発火しない / friend_id 復元と直交)。
 *   - rowSlug=row.slug: 弾M 編集 (PATCH /v3.0/rows/{row_slug}/) が要る addressable slug を write-once で入れる。
 * slug 欠落 row は addressable でない (id にできない) ため null を返し呼び出し側が skip する。crypto 検証のため async。
 */
export interface MapFormalooRowOptions {
  /** 署名 fr_id 検証用の専用 secret (FORMALOO_FRIEND_TOKEN_SECRET)。供給時のみ verify 成功で friend_id 復元。 */
  friendTokenSecret?: string | null;
  /** 署名 fr_id の alias (既定 fr_id)。 */
  friendTokenAlias?: string;
}

export async function mapFormalooListRowToUpsert(
  row: Record<string, unknown>,
  form: { id: string; formaloo_slug: string | null },
  opts: MapFormalooRowOptions = {},
): Promise<UpsertFormalooSubmissionInput | null> {
  const slug = typeof row.slug === 'string' && row.slug ? row.slug : null;
  if (!slug) return null;
  const rawData = row.data;
  const answers = rawData && typeof rawData === 'object' && !Array.isArray(rawData)
    ? (rawData as Record<string, unknown>)
    : {};
  const createdAt = typeof row.created_at === 'string' && row.created_at ? row.created_at : new Date().toISOString();

  // 順方向 friend_id 復元 (fail-closed): 署名 fr_id を verify 成功時のみ friend_id に採る。webhook path と
  //   同一 renderedAliasValue を再利用 (rendered_data 配列/object 形 → data[alias] fallback)。fr_id が全く
  //   present でない / secret 未供給 / verify 失敗 は friend_id=null 維持 (byte 不変・PII fail-closed)。
  let friendId: string | null = null;
  if (opts.friendTokenSecret) {
    const alias = opts.friendTokenAlias ?? FRIEND_TOKEN_ALIAS;
    const signedToken = renderedAliasValue(row.rendered_data, alias) ?? renderedAliasValue(rawData, alias);
    if (signedToken) {
      friendId = await verifyFriendToken(signedToken, opts.friendTokenSecret);
    }
  }

  return {
    id: slug,
    formId: form.id,
    formalooSlug: form.formaloo_slug,
    answersJson: JSON.stringify(answers),
    submittedAt: createdAt,
    rowSlug: slug,
    friendId,
    verified: false,
  };
}

/**
 * /fo 再入場 targeted pull (line-reentry-prefill-fix / Layer A / T-A6 / CI-1 の要)。
 *   reconcile (admin `/rows` GET) は再入場経路では発火しないため、prefill lookup の直前に対象 form の直近
 *   rows を **bounded** pull → `mapFormalooListRowToUpsert` で friend_id 復元 → upsert 入力の配列を返す
 *   (呼び出し側が upsert して mirror を埋めてから getFriendLatestSubmission を引く)。
 *   hot path 保護 (CI-4): maxPages を小さく (既定 2) 抑える。非2xx / 空 rows でループ終了 (fail-safe)。
 *   formaloo_slug 欠落は pull を一切呼ばず空配列。例外は呼び出し側の try/catch が拾う (fail-soft / 302 degrade)。
 */
export async function pullFriendReconcileInputs(
  client: RowsListGetClient,
  form: { id: string; formaloo_slug: string | null },
  opts: MapFormalooRowOptions & { maxPages?: number; pageSize?: number } = {},
): Promise<UpsertFormalooSubmissionInput[]> {
  if (!form.formaloo_slug) return [];
  const maxPages = opts.maxPages ?? 2;
  const pageSize = opts.pageSize ?? 50;
  const out: UpsertFormalooSubmissionInput[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await client.get(`/v3.0/forms/${form.formaloo_slug}/rows/?page=${page}&page_size=${pageSize}`);
    if (!r.ok) break;
    const rows = extractRows(r.data);
    if (rows.length === 0) break;
    for (const row of rows) {
      const input = await mapFormalooListRowToUpsert(row, form, {
        friendTokenSecret: opts.friendTokenSecret,
        friendTokenAlias: opts.friendTokenAlias,
      });
      if (input) out.push(input);
    }
  }
  return out;
}
