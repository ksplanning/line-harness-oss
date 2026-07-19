// =============================================================================
// Formaloo 定義 fingerprint (formaloo-auto-pull / drift 検知の primary シグナル)
// -----------------------------------------------------------------------------
// 目的: cron の定期 drift 検知が「Formaloo 側で harness が意味を持つ定義キーが変わったか」を
//   安定して判定するための canonical 射影 + SHA-256。
//
// 設計原則 (spec §4):
//  - 射影キー = 変換器 fromFormalooField / fromFormalooLogic が実読するキー集合と一致させる
//    (これが「harness が意味を持つ定義」の定義そのもの)。→ volatile キー (submit_count / url /
//    server timestamp) は射影に含めず false-positive を出さない。
//  - **Formaloo slug をキーに使い field_map 非依存** (auto-apply で field_map が churn しても
//    fingerprint は安定 = false re-fire しない)。射影は raw Formaloo body から直接組む
//    (pull 済み harness 表現は field_map 解決に依存するため使わない)。
//  - fields は subset 種別 (fromFormalooField が保持する type) のみ含める (非 subset は harness に
//    反映されず drop されるため fingerprint 対象外 = 「反映すべき定義キー」の一致)。
//  - logic は R0 実測の bare array (preserve-raw の格納素材) を **そのまま canonical に含める**。
//    複合/calc/variable/jump も含め logic 側 drift を欠けなく検知する (preserve 済み rawLogic と整合)。
//    legacy synthetic `{rules}` 形は field/operator/value に射影 (Formaloo slug keyed)。
//  - fields は (position, slug) 昇順に安定ソート (順序ノイズ排除 / 既存 pull の W2 と整合)。
// =============================================================================

import { FORMALOO_TO_HARNESS_TYPE, VARIABLE_SUB_TYPES, isSystemHiddenField, type HarnessFieldType } from './formaloo-forms';
import { parseImageDescription } from './form-image';
import { extractFormOperationsSettings, type FormOperationsSettings } from './form-operations';

// crypto.subtle / TextEncoder は Node18+ / Cloudflare Workers 双方の runtime global。
// 本パッケージの tsconfig lib=ES2022 は Web Crypto / TextEncoder を型宣言しないため、
// 使用箇所のみ module-scoped ambient で型付けする (lib を DOM/WebWorker へ広げて他モジュールの
// 型検査面を変えない = 最小 blast radius)。実体は runtime global で解決される。
declare const crypto: {
  subtle: { digest(algorithm: string, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer> };
};
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

/** 射影後の 1 field (fromFormalooField が実読するキーのみ)。 */
export interface ProjectedField {
  slug: string;
  type: string; // raw Formaloo type (short_text 等)
  title: string;
  required: boolean;
  position: number;
  /** 入力項目の補足説明 (Help text)。非空時のみ射影 (既存 field は description 無/空 → 射影不変 = false-drift 回避)。 */
  description?: string;
  max_length?: number;
  min_length?: number;
  allow_multiple_files?: boolean;
  allowed_extensions?: string[];
  /** file: 最大サイズ (Formaloo max_size / KB)。既定 2048 は射影しない (既存 file-field の false-drift 回避 / form-media-limits)。 */
  max_size?: number;
  /** choice/dropdown/multiple_select の選択肢 title (position 昇順・その他行除外)。fromFormalooField 出力と同型。 */
  choices?: string[];
  /** rating（既定 star は除外）または variable（必須）の sub_type。 */
  subType?: string;
  /** oembed(video) の埋め込み URL (treasure-b1-palette)。非空時のみ射影 (url 空/未載は false-drift 回避)。 */
  videoUrl?: string;
  /**
   * form-image-decoration: 差し込み画像 (meta/section で description=canonical <img>) の parse 済み値。
   * raw description HTML でなく parse 済み値を射影する = Formaloo の遅延 HTML 再正規化 (data-* 属性や空白) での
   * false-drift を回避する生命線 (spike T-C3 は byte 完全一致だが二重の安全)。imageWidth は表示領域=render に
   * 効くため射影に含める (video height=cosmetic 非射影とは逆扱い / R-2)。散文 section は非射影 (projectField で null)。
   */
  imageUrl?: string;
  imageAlt?: string;
  imageWidth?: string;
  /** variable/formula の式 (非空時のみ)。 */
  formula?: string;
  /** variable の decimal_places (有効な非負整数のみ)。 */
  decimalPlaces?: number;
  /** choice_fetch の choices_source (非空時のみ)。 */
  choicesSource?: string;
}

export interface CanonicalDefinition {
  fields: ProjectedField[];
  /** bare array (実 Formaloo logic 逐語) or 射影済 rule 群 (legacy synthetic)。順序は有意 (R0)。 */
  logic: unknown;
  /** Formaloo 既定(false/null)を落とした form-level 運用設定。未設定時は key 自体を持たない。 */
  formSettings?: FormOperationsSettings;
}

/** system field の先頭挿入で押し下げられた通常 field の position を、挿入前の値へ戻す。 */
function projectPosition(position: unknown, systemPositions: readonly number[]): number {
  const raw = typeof position === 'number' && Number.isFinite(position) ? position : 0;
  return raw - systemPositions.filter((systemPosition) => systemPosition < raw).length;
}

/** raw Formaloo field 要素 → 射影 (subset 外種別は null で drop = fromFormalooField と同じ保持集合)。 */
function projectField(el: unknown, systemPositions: readonly number[]): ProjectedField | null {
  if (typeof el !== 'object' || el === null) return null;
  const o = el as Record<string, unknown>;
  // fr-id-capture-fix (R4/T-C5): 予約 friend system field (alias fr_id/fr_name) を fingerprint に含めない。
  //   type=hidden は下の subset 判定で既に null になるが、alias キーで明示除外し、system field の有無で
  //   fingerprint byte が不変であること (false-drift ゼロ) を保証する (pull/drift と同一 helper = 共通 projection)。
  if (isSystemHiddenField(o)) return null;
  const formalooType = typeof o.type === 'string' ? o.type : '';
  // form-image-decoration: meta/section で description が canonical <img> のものだけを差し込み画像として射影する。
  //   parse 済み {imageUrl,imageAlt,imageWidth} を射影 (raw HTML 非依存 = 再正規化 false-drift 回避 / R-2)。
  //   散文 section / page_break は従来どおり非射影 (return null) = 既存フォーム byte 不変 (R-1)。
  if (formalooType === 'meta') {
    const parsed = parseImageDescription(typeof o.description === 'string' ? o.description : '');
    if (!parsed) return null;
    return {
      slug: typeof o.slug === 'string' ? o.slug : '',
      type: 'meta',
      title: typeof o.title === 'string' ? o.title : '',
      required: false,
      position: projectPosition(o.position, systemPositions),
      imageUrl: parsed.url,
      imageAlt: parsed.alt,
      imageWidth: parsed.width,
    };
  }
  // treasure-b1-palette: oembed(video) は装飾ゆえ FORMALOO_TO_HARNESS_TYPE 逆引きに載らない → meta と異なり
  //   fromFormalooField が oembed→video を保持するため fingerprint も explicit に射影する (drift 検知対象)。
  //   url 非空時のみ videoUrl を載せる (url 空/未載の false-drift 回避 / max_size=2048 ガードと同型)。
  //   b1-field-polish: config.height (videoHeight) は cosmetic ゆえ **射影しない** (色と同型で fingerprint 対象外)。
  //   height 変更で drift を鳴らさない + 既存 video に config.height を push しても SHA 不変 (false-drift ゼロ)。
  if (formalooType === 'oembed') {
    const proj: ProjectedField = {
      slug: typeof o.slug === 'string' ? o.slug : '',
      type: 'oembed',
      title: typeof o.title === 'string' ? o.title : '',
      required: false,
      position: projectPosition(o.position, systemPositions),
    };
    if (typeof o.url === 'string' && o.url) proj.videoUrl = o.url;
    return proj;
  }
  const harnessType: HarnessFieldType | undefined = FORMALOO_TO_HARNESS_TYPE[formalooType];
  if (!harnessType) return null; // MVP subset 外 = harness に反映されない → 射影対象外
  // Dynamic fields have server-required discriminators. Pull drops an invalid field, so fingerprint must also
  // drop it; otherwise drift would detect a field that auto-apply cannot represent (permanent false drift).
  if (
    harnessType === 'variable'
    && (typeof o.sub_type !== 'string' || !(VARIABLE_SUB_TYPES as readonly string[]).includes(o.sub_type))
  ) return null;
  if (harnessType === 'choice_fetch' && (typeof o.choices_source !== 'string' || !o.choices_source)) return null;

  const proj: ProjectedField = {
    slug: typeof o.slug === 'string' ? o.slug : '',
    type: formalooType,
    title: typeof o.title === 'string' ? o.title : '',
    required: harnessType === 'variable' ? false : o.required === true,
    position: projectPosition(o.position, systemPositions),
  };
  // 入力項目の補足説明を射影に含める (変換器 fromFormalooField の読取集合と一致)。
  // 非空ガード: description 無/空の既存 field は key を持たず fingerprint byte 不変 (false-drift 回避 / S-2)。
  if (typeof o.description === 'string' && o.description) proj.description = o.description;
  if (typeof o.max_length === 'number' && Number.isFinite(o.max_length)) proj.max_length = o.max_length;
  if (typeof o.min_length === 'number' && Number.isFinite(o.min_length)) proj.min_length = o.min_length;
  if (typeof o.allow_multiple_files === 'boolean') proj.allow_multiple_files = o.allow_multiple_files;
  if (Array.isArray(o.allowed_extensions) && o.allowed_extensions.every((e) => typeof e === 'string')) {
    proj.allowed_extensions = [...(o.allowed_extensions as string[])];
  }
  // form-media-limits ①: max_size を射影。既定 2048 は落とす (既存 file-field フォームの fingerprint byte 不変 =
  // cron 全件 false-drift 回避 / RK-1)。description 非空ガード (S-2) と同型の後方互換ガード。
  if (typeof o.max_size === 'number' && Number.isFinite(o.max_size) && o.max_size !== 2048) proj.max_size = o.max_size;
  // treasure-b1-palette: rating の sub_type を射影。既定 star は落とす (star rating の false-drift 回避 = 後方互換ガード)。
  if (harnessType === 'rating' && typeof o.sub_type === 'string' && o.sub_type !== 'star') proj.subType = o.sub_type;
  if (harnessType === 'variable' && typeof o.sub_type === 'string' && (VARIABLE_SUB_TYPES as readonly string[]).includes(o.sub_type)) {
    proj.subType = o.sub_type;
    const config = o.config && typeof o.config === 'object' && !Array.isArray(o.config)
      ? o.config as Record<string, unknown>
      : {};
    if (o.sub_type === 'formula' && typeof config.formula === 'string' && config.formula) proj.formula = config.formula;
    if (typeof o.decimal_places === 'number' && Number.isInteger(o.decimal_places) && o.decimal_places >= 0) {
      proj.decimalPlaces = o.decimal_places;
    }
  }
  if (harnessType === 'choice_fetch' && typeof o.choices_source === 'string' && o.choices_source) {
    proj.choicesSource = o.choices_source;
  }
  if (harnessType === 'choice' || harnessType === 'dropdown' || harnessType === 'multiple_select') {
    const rawItems = Array.isArray(o.choice_items) ? (o.choice_items as unknown[]) : [];
    proj.choices = rawItems
      .map((it) => (it && typeof it === 'object' ? (it as Record<string, unknown>) : {}))
      .filter((it) => typeof it.title === 'string' && it.is_other_choice !== true)
      .map((it, i) => ({ title: it.title as string, pos: typeof it.position === 'number' ? it.position : i }))
      .sort((a, b) => a.pos - b.pos)
      .map((it) => it.title);
  }
  return proj;
}

/** legacy synthetic `{rules:[{conditions,actions}]}` → Formaloo-slug-keyed 射影 (順序保持)。 */
function projectRulesObject(rawLogic: unknown): unknown[] {
  const rules =
    rawLogic && typeof rawLogic === 'object' && Array.isArray((rawLogic as { rules?: unknown }).rules)
      ? ((rawLogic as { rules: unknown[] }).rules)
      : [];
  return rules.map((r) => {
    const ro = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const conditions = (Array.isArray(ro.conditions) ? ro.conditions : []).map((c) => {
      const co = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      return {
        field: typeof co.field === 'string' ? co.field : String(co.field ?? ''),
        operator: typeof co.operator === 'string' ? co.operator : String(co.operator ?? ''),
        value: co.value === undefined || co.value === null ? '' : String(co.value),
      };
    });
    const actions = (Array.isArray(ro.actions) ? ro.actions : []).map((a) => {
      const ao = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
      return {
        type: typeof ao.type === 'string' ? ao.type : String(ao.type ?? ''),
        field: typeof ao.field === 'string' ? ao.field : String(ao.field ?? ''),
      };
    });
    return { conditions, actions };
  });
}

/**
 * raw Formaloo body の fields_list + logic → canonical 定義射影。
 *  - rawFieldsList: extractFieldsList(res.data) の結果 (raw Formaloo field 要素の配列)。
 *  - rawLogic: extractRawLogic(res.data) の bare array (未載時は extractLogic の `{rules}` を渡す)。
 */
export function canonicalDefinitionProjection(rawFieldsList: unknown, rawLogic: unknown, rawForm?: unknown): CanonicalDefinition {
  const rawFields = Array.isArray(rawFieldsList) ? rawFieldsList : [];
  const systemPositions = rawFields
    .filter((field) => isSystemHiddenField(field))
    .map((field) => (field as Record<string, unknown>).position)
    .filter((position): position is number => typeof position === 'number' && Number.isFinite(position));
  const fields = rawFields
    .map((field) => projectField(field, systemPositions))
    .filter((f): f is ProjectedField => f !== null)
    .sort((a, b) => a.position - b.position || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const logic = Array.isArray(rawLogic) ? rawLogic : projectRulesObject(rawLogic);
  const formSettings = extractFormOperationsSettings(rawForm);
  return {
    fields,
    logic,
    ...(Object.keys(formSettings).length ? { formSettings } : {}),
  };
}

/** object の key を再帰的にソートした決定的 JSON (配列順は保持 = R0 順序有意)。formaloo-forms の canonicalStringify と同型。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Formaloo 定義 fingerprint = hex(SHA-256(stableStringify(canonicalDefinitionProjection(...))))。
 * Web Crypto (Workers ネイティブ / 依存追加なし)。前回 baseline と等値比較して drift を判定する。
 */
export async function formalooDefinitionFingerprint(rawFieldsList: unknown, rawLogic: unknown, rawForm?: unknown): Promise<string> {
  const canon = stableStringify(canonicalDefinitionProjection(rawFieldsList, rawLogic, rawForm));
  const bytes = new TextEncoder().encode(canon);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
