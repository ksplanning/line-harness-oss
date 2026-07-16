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

import { FORMALOO_TO_HARNESS_TYPE, type HarnessFieldType } from './formaloo-forms';

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
  /** choice/dropdown/multiple_select の選択肢 title (position 昇順・その他行除外)。fromFormalooField 出力と同型。 */
  choices?: string[];
}

export interface CanonicalDefinition {
  fields: ProjectedField[];
  /** bare array (実 Formaloo logic 逐語) or 射影済 rule 群 (legacy synthetic)。順序は有意 (R0)。 */
  logic: unknown;
}

/** raw Formaloo field 要素 → 射影 (subset 外種別は null で drop = fromFormalooField と同じ保持集合)。 */
function projectField(el: unknown): ProjectedField | null {
  if (typeof el !== 'object' || el === null) return null;
  const o = el as Record<string, unknown>;
  const formalooType = typeof o.type === 'string' ? o.type : '';
  const harnessType: HarnessFieldType | undefined = FORMALOO_TO_HARNESS_TYPE[formalooType];
  if (!harnessType) return null; // MVP subset 外 = harness に反映されない → 射影対象外

  const proj: ProjectedField = {
    slug: typeof o.slug === 'string' ? o.slug : '',
    type: formalooType,
    title: typeof o.title === 'string' ? o.title : '',
    required: o.required === true,
    position: typeof o.position === 'number' ? o.position : 0,
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
export function canonicalDefinitionProjection(rawFieldsList: unknown, rawLogic: unknown): CanonicalDefinition {
  const fields = (Array.isArray(rawFieldsList) ? rawFieldsList : [])
    .map(projectField)
    .filter((f): f is ProjectedField => f !== null)
    .sort((a, b) => a.position - b.position || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const logic = Array.isArray(rawLogic) ? rawLogic : projectRulesObject(rawLogic);
  return { fields, logic };
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
export async function formalooDefinitionFingerprint(rawFieldsList: unknown, rawLogic: unknown): Promise<string> {
  const canon = stableStringify(canonicalDefinitionProjection(rawFieldsList, rawLogic));
  const bytes = new TextEncoder().encode(canon);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
