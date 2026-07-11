// =============================================================================
// harness フォーム定義 ↔ Formaloo field/logic マッピング (F-2 / T-B2 / 単一正典 = worker + web 共有)
// -----------------------------------------------------------------------------
// SoT (§4): Formaloo = 定義の権威。harness は authoring proxy。本モジュールは
//   「素人向け harness モデル」↔「Formaloo API 形式」の双方向変換 + 検証を担う。
// N-13 MVP subset: text/textarea/choice/dropdown/multiple_select/number/email/phone/date/file + 基本 logic のみ。
//   matrix/repeating_section/linked-rows/lookup/product/oembed/ai-box は F-2b 以降 (段階スコープ)。
// M-21: validateFlex 教訓 = 未知プロパティ素通し禁止。field/logic は明示 whitelist で正規化し不正を弾く。
// M-8: serialize whitelist round-trip (worker push / builder pull の双方で同一定義)。
// =============================================================================

/** harness 側 field 種別 (MVP subset / 素人向け日本語ラベルは web が付与)。 */
export const FORMALOO_FIELD_TYPES = [
  'text',
  'textarea',
  'choice',
  'dropdown',
  'multiple_select',
  'number',
  'email',
  'phone',
  'date',
  'file',
] as const;

export type HarnessFieldType = (typeof FORMALOO_FIELD_TYPES)[number];

/** harness 種別 → Formaloo field type 名 (実 API 名 / R10)。 */
export const HARNESS_TO_FORMALOO_TYPE: Record<HarnessFieldType, string> = {
  text: 'short_text',
  textarea: 'long_text',
  choice: 'choice',
  dropdown: 'dropdown',
  multiple_select: 'multiple_select',
  number: 'number',
  email: 'email',
  phone: 'phone',
  date: 'date',
  file: 'file',
};

/** 逆引き (Formaloo type 名 → harness 種別 / pull 用)。 */
export const FORMALOO_TO_HARNESS_TYPE: Record<string, HarnessFieldType> = Object.fromEntries(
  (Object.entries(HARNESS_TO_FORMALOO_TYPE) as [HarnessFieldType, string][]).map(([h, f]) => [f, h]),
) as Record<string, HarnessFieldType>;

export interface HarnessFieldConfig {
  /** text/textarea の文字数上限 (R2 / Formaloo max_length。実機で short_text=255 を確認済)。 */
  maxLength?: number;
  /** text/textarea の文字数下限。 */
  minLength?: number;
  /** choice/dropdown/multiple_select の選択肢。 */
  choices?: string[];
  /** file: 複数ファイル許可 (R3)。 */
  allowMultipleFiles?: boolean;
  /** file: 許可拡張子 (R3 / 拡張子文字列の配列)。 */
  allowedExtensions?: string[];
}

export interface HarnessField {
  id: string;
  type: HarnessFieldType;
  label: string;
  required: boolean;
  position: number;
  config: HarnessFieldConfig;
}

/** 条件分岐アクション (R1)。 */
export type LogicAction = 'show' | 'hide' | 'skip';
export type LogicOperator = 'equals' | 'not_equals';

/** 「もし [sourceField] が [value] [operator] なら [target] を [action]」。 */
export interface HarnessLogicRule {
  id: string;
  sourceFieldId: string;
  operator: LogicOperator;
  value: string;
  action: LogicAction;
  targetFieldId: string;
}

export interface HarnessFormDefinition {
  fields: HarnessField[];
  logic: HarnessLogicRule[];
}

// ─── Formaloo logic object 形 (push-sync 形式 / conditions + actions) ─────────
export interface FormalooLogicCondition {
  field: string; // Formaloo field slug
  operator: LogicOperator;
  value: string;
}
export interface FormalooLogicAction {
  type: LogicAction;
  field: string; // Formaloo field slug
}
export interface FormalooLogicRule {
  conditions: FormalooLogicCondition[];
  actions: FormalooLogicAction[];
}
export interface FormalooLogicObject {
  rules: FormalooLogicRule[];
}

function isFieldType(v: unknown): v is HarnessFieldType {
  return typeof v === 'string' && (FORMALOO_FIELD_TYPES as readonly string[]).includes(v);
}

/**
 * 未知プロパティを剥がし MVP subset に正規化。subset 外種別・不正 config は reject (M-21)。
 */
export function validateHarnessField(
  input: unknown,
): { ok: true; field: HarnessField } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'field is not an object' };
  const o = input as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return { ok: false, error: 'field.id required' };
  if (!isFieldType(o.type)) return { ok: false, error: `unsupported field type: ${String(o.type)} (MVP subset のみ / N-13)` };
  if (typeof o.label !== 'string') return { ok: false, error: 'field.label must be string' };

  const rawCfg = (typeof o.config === 'object' && o.config !== null ? o.config : {}) as Record<string, unknown>;
  const config: HarnessFieldConfig = {};
  if (rawCfg.maxLength !== undefined) {
    if (typeof rawCfg.maxLength !== 'number' || !Number.isFinite(rawCfg.maxLength)) return { ok: false, error: 'config.maxLength must be a number' };
    config.maxLength = rawCfg.maxLength;
  }
  if (rawCfg.minLength !== undefined) {
    if (typeof rawCfg.minLength !== 'number' || !Number.isFinite(rawCfg.minLength)) return { ok: false, error: 'config.minLength must be a number' };
    config.minLength = rawCfg.minLength;
  }
  if (rawCfg.choices !== undefined) {
    if (!Array.isArray(rawCfg.choices) || !rawCfg.choices.every((c) => typeof c === 'string')) return { ok: false, error: 'config.choices must be string[]' };
    config.choices = [...rawCfg.choices];
  }
  if (rawCfg.allowMultipleFiles !== undefined) {
    if (typeof rawCfg.allowMultipleFiles !== 'boolean') return { ok: false, error: 'config.allowMultipleFiles must be boolean' };
    config.allowMultipleFiles = rawCfg.allowMultipleFiles;
  }
  if (rawCfg.allowedExtensions !== undefined) {
    if (!Array.isArray(rawCfg.allowedExtensions) || !rawCfg.allowedExtensions.every((c) => typeof c === 'string')) return { ok: false, error: 'config.allowedExtensions must be string[]' };
    config.allowedExtensions = [...rawCfg.allowedExtensions];
  }

  return {
    ok: true,
    field: {
      id: o.id,
      type: o.type,
      label: o.label,
      required: o.required === true,
      position: typeof o.position === 'number' ? o.position : 0,
      config,
    },
  };
}

/** harness field → Formaloo field POST payload (未知プロパティを持たない明示形 / M-8)。 */
export function toFormalooFieldPayload(field: HarnessField): Record<string, unknown> {
  const p: Record<string, unknown> = {
    type: HARNESS_TO_FORMALOO_TYPE[field.type],
    title: field.label,
    required: field.required,
    position: field.position,
  };
  const c = field.config;
  if (c.maxLength !== undefined) p.max_length = c.maxLength;
  if (c.minLength !== undefined) p.min_length = c.minLength;
  // choice/dropdown/multiple_select の選択肢は Formaloo writeOnly `choice_items` ([{title}] 形式) で送る。
  // slug 無しの item = 新規選択肢として作成される (live 実証 2026-07-10 / OpenAPI ChoiceFieldRequest.choice_items)。
  // 🚨 旧実装の `choices: string[]` は実 API に無視され、choice field は作成されても選択肢が
  //    Formaloo 側で落ちていた (silent data loss / latent defect)。以後 `choices` キーは送らない。
  if (c.choices !== undefined) p.choice_items = c.choices.map((title) => ({ title }));
  if (c.allowMultipleFiles !== undefined) p.allow_multiple_files = c.allowMultipleFiles;
  if (c.allowedExtensions !== undefined) p.allowed_extensions = [...c.allowedExtensions];
  return p;
}

/**
 * Formaloo field オブジェクト (form detail の `fields_list` 要素 / read-shape) → harness field 再構成。
 * builder open 時に Formaloo→harness へ選択肢を読み戻す pull 経路 (N-8) の単一 field 変換。
 *  - MVP subset 外の Formaloo type (matrix 等) は null で捨てる (M-21)。
 *  - choice 系は read-shape の `choice_items[]` から `title` を復元 (position 昇順 / `is_other_choice` は
 *    自由記述「その他」なので選択肢から除外)。push の [{title}] 形も position 無しで順序保持して復元できる。
 *  - 未知プロパティは無視 (whitelist / M-8)。id は resolveId?.(slug) があればそれを、無ければ Formaloo slug。
 */
export function fromFormalooField(
  input: unknown,
  resolveId?: (formalooFieldSlug: string) => string | undefined,
): HarnessField | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  const formalooType = typeof o.type === 'string' ? o.type : '';
  const type = FORMALOO_TO_HARNESS_TYPE[formalooType];
  if (!type) return null; // MVP subset 外 = 復元しない (M-21)

  const slug = typeof o.slug === 'string' ? o.slug : '';
  const id = (slug ? resolveId?.(slug) : undefined) ?? slug;

  const config: HarnessFieldConfig = {};
  if (typeof o.max_length === 'number' && Number.isFinite(o.max_length)) config.maxLength = o.max_length;
  if (typeof o.min_length === 'number' && Number.isFinite(o.min_length)) config.minLength = o.min_length;
  if (typeof o.allow_multiple_files === 'boolean') config.allowMultipleFiles = o.allow_multiple_files;
  if (Array.isArray(o.allowed_extensions) && o.allowed_extensions.every((e) => typeof e === 'string')) {
    config.allowedExtensions = [...(o.allowed_extensions as string[])];
  }
  if (type === 'choice' || type === 'dropdown' || type === 'multiple_select') {
    const rawItems = Array.isArray(o.choice_items) ? (o.choice_items as unknown[]) : [];
    config.choices = rawItems
      .map((it) => (it && typeof it === 'object' ? (it as Record<string, unknown>) : {}))
      .filter((it) => typeof it.title === 'string' && it.is_other_choice !== true)
      .map((it, i) => ({ title: it.title as string, pos: typeof it.position === 'number' ? it.position : i }))
      .sort((a, b) => a.pos - b.pos)
      .map((it) => it.title);
  }

  return {
    id,
    type,
    label: typeof o.title === 'string' ? o.title : '',
    required: o.required === true,
    position: typeof o.position === 'number' ? o.position : 0,
    config,
  };
}

/**
 * harness logic rules → Formaloo logic object。field は harness id → Formaloo slug に解決。
 * resolveSlug が undefined を返す (未 push field 等) rule は捨てる (孤立参照を Formaloo に送らない)。
 */
export function toFormalooLogic(
  rules: HarnessLogicRule[],
  resolveSlug: (harnessFieldId: string) => string | undefined,
): FormalooLogicObject {
  const out: FormalooLogicRule[] = [];
  for (const r of rules) {
    const srcSlug = resolveSlug(r.sourceFieldId);
    const tgtSlug = resolveSlug(r.targetFieldId);
    if (!srcSlug || !tgtSlug) continue;
    out.push({
      conditions: [{ field: srcSlug, operator: r.operator, value: r.value }],
      actions: [{ type: r.action, field: tgtSlug }],
    });
  }
  return { rules: out };
}

/**
 * Formaloo logic object → harness logic rules (builder open 時の pull / N-8)。
 * whitelist 抽出 (未知プロパティ無視 / M-8)。resolve できない slug の rule は捨てる (N-11 孤立防止)。
 * rule id は安定的に再生成 (r1, r2, ...)。
 */
export function fromFormalooLogic(
  obj: FormalooLogicObject,
  resolveFieldId: (formalooFieldSlug: string) => string | undefined,
): HarnessLogicRule[] {
  const rulesIn = Array.isArray(obj?.rules) ? obj.rules : [];
  const out: HarnessLogicRule[] = [];
  let n = 0;
  for (const r of rulesIn) {
    const cond = r?.conditions?.[0];
    const act = r?.actions?.[0];
    if (!cond || !act) continue;
    const sourceFieldId = resolveFieldId(cond.field);
    const targetFieldId = resolveFieldId(act.field);
    if (!sourceFieldId || !targetFieldId) continue;
    const operator: LogicOperator = cond.operator === 'not_equals' ? 'not_equals' : 'equals';
    const action: LogicAction = act.type === 'hide' ? 'hide' : act.type === 'skip' ? 'skip' : 'show';
    n += 1;
    out.push({
      id: `r${n}`,
      sourceFieldId,
      operator,
      value: typeof cond.value === 'string' ? cond.value : String(cond.value ?? ''),
      action,
      targetFieldId,
    });
  }
  return out;
}

/**
 * Formaloo logic object 内の「複合ロジックルール」件数を数える (pull-fidelity 弱化検知 / additive)。
 * harness の HarnessLogicRule は単一 condition + 単一 action 設計のため、Formaloo 側の
 * conditions.length>1 または actions.length>1 の rule は fromFormalooLogic で index-0 に弱化される。
 * その件数を返して pull note で運用者に surface する目的の純関数 (fromFormalooLogic 自体は無改変)。
 * 入力は Formaloo raw shape ゆえ非配列を許容的に 0 扱い (fail-soft)。
 */
export function countWeakenedFormalooRules(obj: FormalooLogicObject): number {
  const rulesIn = Array.isArray(obj?.rules) ? obj.rules : [];
  return rulesIn.filter(
    (r) =>
      (Array.isArray(r?.conditions) && r.conditions.length > 1) ||
      (Array.isArray(r?.actions) && r.actions.length > 1),
  ).length;
}
