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

function extractRows(data: unknown): Array<Record<string, unknown>> {
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
