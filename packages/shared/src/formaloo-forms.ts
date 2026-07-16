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

export const DECORATION_FIELD_TYPES = ['section', 'page_break'] as const;
export type HarnessDecorationType = (typeof DECORATION_FIELD_TYPES)[number];

export type HarnessFieldType = (typeof FORMALOO_FIELD_TYPES)[number] | HarnessDecorationType;

export function isDecorationType(t: string): t is HarnessDecorationType {
  return (DECORATION_FIELD_TYPES as readonly string[]).includes(t);
}

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
  section: 'meta',
  page_break: 'meta',
};

/** 逆引き (Formaloo type 名 → harness 種別 / pull 用)。 */
export const FORMALOO_TO_HARNESS_TYPE: Record<string, HarnessFieldType> = Object.fromEntries(
  FORMALOO_FIELD_TYPES.map((h) => [HARNESS_TO_FORMALOO_TYPE[h], h]),
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
  /** section の本文=description */
  text?: string;
  /** 入力項目の補足説明 (Help text / Formaloo field description)。全入力型で表示。section 本文(text)とは別欄。 */
  description?: string;
  /**
   * choice/dropdown/multiple_select の選択肢を title+slug で additive 保持 (form-route-branching)。
   * pull 時に Formaloo `choice_items[].slug` を取り込む (全項目が slug を持つ完全形の時のみ)。既存 `choices`(title のみ) は不変。
   * 用途 = choice source の jump/show/hide を hosted で発火させるため `when` を `{type:'choice',value:<slug>}` 生成する
   * (spike T-A0 実測: choice source は choice_slug のみ発火・constant(title) は API 200 だが hosted 不発)。
   * push 由来の `[{title}]`(slug 無し) では未設定 = 新規未 push field は case-b (保存後 再 pull で解決)。
   */
  choiceItems?: { title: string; slug: string }[];
}

export interface HarnessField {
  id: string;
  type: HarnessFieldType;
  label: string;
  required: boolean;
  position: number;
  config: HarnessFieldConfig;
}

/** 条件分岐アクション (R1)。
 * 'jump' = 指定ページ (page_break) へ丸ごと飛ぶ真のルート分岐 (form-route-branching / multi_step でのみ発火)。
 * 'skip' = レガシー射影名 (旧 UI で jump/jump_to_success_page を 'skip' に丸めていた) / 後方互換で残置。
 */
export type LogicAction = 'show' | 'hide' | 'jump' | 'skip';
export type LogicOperator = 'equals' | 'not_equals';

/**
 * フォーム表示形式 (form-route-branching R2)。Formaloo `form_type` top-level キーに対応 (spike T-A0 確定)。
 *  - 'simple' = 1 画面複数問 (既定) / 'multi_step' = 1 問ずつ表示 (jump ルート分岐はこの形式でのみ hosted 発火)。
 * enum は spike 実測でこの 2 値のみ (`"multistep"` 等は Formaloo が 400)。
 */
export type FormDisplayType = 'simple' | 'multi_step';

// ─── R0 実測: Formaloo logic の実 operator / action 語彙 (formaloo-logic-fidelity Batch 0 spike) ───
// harness の LogicOperator(equals/not_equals) / LogicAction(show/hide/skip) は Formaloo の真部分集合。
// 複合ルールの additive 保持 (下記 HarnessLogicCondition/ActionRef) では実語彙をそのまま持つ。
export type FormalooConditionOperator =
  | 'is' | 'is_not' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_answered'
  | 'and' | 'or' | 'always' | 'otherwise';
export type FormalooActionVerb =
  | 'show' | 'hide' | 'jump' | 'jump_to_success_page' | 'submit'
  | 'set' | 'add' | 'subtract' | 'multiply' | 'divide'
  | 'send_email' | 'send_webhook' | 'send_slack' | 'generate_pdf' | 'redirect';

/**
 * 複合ルールの 1 条件 (additive / Batch 1 は保持のみ・表示/編集は Batch 2)。
 * operator は R0 実測語彙 (harness の equals/not_equals も許容)。sourceFieldId は resolve 済 harness id か slug。
 */
export interface HarnessLogicCondition {
  sourceFieldId: string;
  operator: FormalooConditionOperator | LogicOperator;
  value: string;
}
/** 複合ルールの 1 アクション参照 (additive)。action は R0 実測語彙。 */
export interface HarnessLogicActionRef {
  action: FormalooActionVerb | LogicAction;
  targetFieldId: string;
}

/** 「もし [sourceField] が [value] [operator] なら [target] を [action]」。 */
export interface HarnessLogicRule {
  id: string;
  sourceFieldId: string;
  operator: LogicOperator;
  value: string;
  action: LogicAction;
  targetFieldId: string;
  // ── additive optional (compound / pulled 時のみ populate・single は付けない = R2 一意固定) ──
  // 既存 6 フィールドは byte 不変・常に populate。以下は「欠けない保持」用の追加のみ (後方互換の要)。
  /** 全条件 (index-0 含む・複合の AND/OR 木を平坦化した leaf 群)。 */
  conditions?: HarnessLogicCondition[];
  /** 最上位の結合子 (R0 実測: when.operation の and/or)。単一条件時は未設定。 */
  conditionJoin?: 'and' | 'or';
  /** 全アクション (index-0 含む)。 */
  actions?: HarnessLogicActionRef[];
  /** Formaloo logic item 断片の逐語 (未モデル prop passthrough / preserve-raw の per-rule 断片)。 */
  raw?: unknown;
}

export interface HarnessFormDefinition {
  fields: HarnessField[];
  logic: HarnessLogicRule[];
  /**
   * フォーム表示形式 (form-route-branching R2 / additive optional)。design と同じく値があるときだけ persist。
   * 未設定フォームは definition_json に載らない = 後方互換 (byte 不変)。
   */
  formType?: FormDisplayType;
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
  return typeof v === 'string' && (
    (FORMALOO_FIELD_TYPES as readonly string[]).includes(v)
    || (DECORATION_FIELD_TYPES as readonly string[]).includes(v)
  );
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
  if (rawCfg.choiceItems !== undefined) {
    // form-route-branching: choice_slug 保持 (additive)。{title,slug}[] を whitelist で通す。
    const items = rawCfg.choiceItems;
    const valid = Array.isArray(items) && items.every(
      (c) => c !== null && typeof c === 'object' && typeof (c as Record<string, unknown>).title === 'string' && typeof (c as Record<string, unknown>).slug === 'string',
    );
    if (!valid) return { ok: false, error: 'config.choiceItems must be {title,slug}[]' };
    config.choiceItems = (items as { title: string; slug: string }[]).map((c) => ({ title: c.title, slug: c.slug }));
  }
  if (rawCfg.allowMultipleFiles !== undefined) {
    if (typeof rawCfg.allowMultipleFiles !== 'boolean') return { ok: false, error: 'config.allowMultipleFiles must be boolean' };
    config.allowMultipleFiles = rawCfg.allowMultipleFiles;
  }
  if (rawCfg.allowedExtensions !== undefined) {
    if (!Array.isArray(rawCfg.allowedExtensions) || !rawCfg.allowedExtensions.every((c) => typeof c === 'string')) return { ok: false, error: 'config.allowedExtensions must be string[]' };
    config.allowedExtensions = [...rawCfg.allowedExtensions];
  }
  if (rawCfg.text !== undefined) {
    if (typeof rawCfg.text !== 'string') return { ok: false, error: 'config.text must be string' };
    config.text = rawCfg.text;
  }
  if (rawCfg.description !== undefined) {
    if (typeof rawCfg.description !== 'string') return { ok: false, error: 'config.description must be string' };
    config.description = rawCfg.description;
  }

  return {
    ok: true,
    field: {
      id: o.id,
      type: o.type,
      label: o.label,
      required: isDecorationType(o.type) ? false : o.required === true,
      position: typeof o.position === 'number' ? o.position : 0,
      config,
    },
  };
}

/** harness field → Formaloo field POST payload (未知プロパティを持たない明示形 / M-8)。 */
export function toFormalooFieldPayload(field: HarnessField): Record<string, unknown> {
  if (field.type === 'section') {
    return {
      type: 'meta',
      sub_type: 'section',
      title: field.label,
      description: field.config.text ?? '',
      position: field.position,
    };
  }
  if (field.type === 'page_break') {
    return {
      type: 'meta',
      sub_type: 'page_break',
      position: field.position,
    };
  }
  const p: Record<string, unknown> = {
    type: HARNESS_TO_FORMALOO_TYPE[field.type],
    title: field.label,
    required: field.required,
    position: field.position,
  };
  const c = field.config;
  // 入力項目の補足説明 (Help text)。Formaloo は全入力型 field で `description` を Help text として配信する
  // (spike 実測: CharFieldRequest/TextFieldRequest 共通プロパティ)。section 経路 (上) の description=本文とは別。
  if (c.description !== undefined) p.description = c.description;
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
  const slug = typeof o.slug === 'string' ? o.slug : '';
  const id = (slug ? resolveId?.(slug) : undefined) ?? slug;

  if (formalooType === 'meta') {
    const subType = typeof o.sub_type === 'string' ? o.sub_type : '';
    if (subType === 'section') {
      return {
        id,
        type: 'section',
        label: typeof o.title === 'string' ? o.title : '',
        required: false,
        position: typeof o.position === 'number' ? o.position : 0,
        config: { text: typeof o.description === 'string' ? o.description : '' },
      };
    }
    if (subType === 'page_break') {
      return {
        id,
        type: 'page_break',
        label: typeof o.title === 'string' ? o.title : '',
        required: false,
        position: typeof o.position === 'number' ? o.position : 0,
        config: {},
      };
    }
    return null;
  }

  const type = FORMALOO_TO_HARNESS_TYPE[formalooType];
  if (!type) return null; // MVP subset 外 = 復元しない (M-21)

  const config: HarnessFieldConfig = {};
  // 入力項目の補足説明 (Help text) を復元。section 経路 (上) は description→config.text にマップ済のためここは入力型のみ。
  if (typeof o.description === 'string') config.description = o.description;
  if (typeof o.max_length === 'number' && Number.isFinite(o.max_length)) config.maxLength = o.max_length;
  if (typeof o.min_length === 'number' && Number.isFinite(o.min_length)) config.minLength = o.min_length;
  if (typeof o.allow_multiple_files === 'boolean') config.allowMultipleFiles = o.allow_multiple_files;
  if (Array.isArray(o.allowed_extensions) && o.allowed_extensions.every((e) => typeof e === 'string')) {
    config.allowedExtensions = [...(o.allowed_extensions as string[])];
  }
  if (type === 'choice' || type === 'dropdown' || type === 'multiple_select') {
    const rawItems = Array.isArray(o.choice_items) ? (o.choice_items as unknown[]) : [];
    const sorted = rawItems
      .map((it) => (it && typeof it === 'object' ? (it as Record<string, unknown>) : {}))
      .filter((it) => typeof it.title === 'string' && it.is_other_choice !== true)
      .map((it, i) => ({
        title: it.title as string,
        slug: typeof it.slug === 'string' ? it.slug : '',
        pos: typeof it.position === 'number' ? it.position : i,
      }))
      .sort((a, b) => a.pos - b.pos);
    config.choices = sorted.map((it) => it.title);
    // form-route-branching: 全項目が slug を持つ pull 完全形の時のみ choiceItems を additive 保持
    // (push 由来 `[{title}]` は slug 空 → 非保持 = 後方互換 / choice_slug は jump 発火の前提)。
    if (sorted.length > 0 && sorted.every((it) => it.slug)) {
      config.choiceItems = sorted.map((it) => ({ title: it.title, slug: it.slug }));
    }
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

// ─── form-route-branching: R0 bare-array 生成 (edited-push 是正 + jump 有効化) ───
// spike T-A0 実測: 書込は `PATCH /v3.0/forms/{slug}/ {logic:<bare array>}`。旧 `PUT {logic:{rules}}` は
// method(full-replace)/shape(object container) 双方誤りで本番 500。本関数は R0 item 形を生成する:
//   { type:'field', identifier:<src_slug>,
//     actions:[ { action:<verb>, args:[{type:'field', identifier:<tgt_slug>}],
//                 when:{ operation:<op>, args:[ {type:'field', value:<src_slug>}, <valueOperand> ] } } ] }
// args 混在型 (取り違え 400 地雷): actions[].args=identifier キー / when.args=value キー。

/** when 第2オペランド (比較値) を生成。choice source は choice_slug で発火 (spike T-A0)・非 choice は constant。 */
function resolveWhenValueOperand(
  rule: HarnessLogicRule,
  srcField: HarnessField | undefined,
): { type: 'choice'; value: string } | { type: 'constant'; value: string } {
  const isChoice =
    srcField !== undefined &&
    (srcField.type === 'choice' || srcField.type === 'dropdown' || srcField.type === 'multiple_select');
  if (isChoice && srcField) {
    const items = srcField.config.choiceItems ?? [];
    // rule.value が既に slug (pull 由来) ならそのまま / title (builder select) なら slug へ写像。
    const bySlug = items.find((it) => it.slug === rule.value);
    if (bySlug) return { type: 'choice', value: bySlug.slug };
    const byTitle = items.find((it) => it.title === rule.value);
    if (byTitle) return { type: 'choice', value: byTitle.slug };
    // choice source だが slug 未解決 (choiceItems 無 = 新規未 push field / case-b BACKLOG) →
    // constant 近似で構造保持 (hosted 不発だが保存後 再 pull→再編集で解決)。
  }
  return { type: 'constant', value: rule.value };
}

/**
 * harness logic rules → Formaloo R0 bare-array logic (edited-push の是正生成形)。
 * field は harness id → Formaloo slug に解決。resolveSlug が undefined を返す rule は捨てる (孤立参照防止)。
 * fieldById (任意) を渡すと source field の型を見て choice/constant のオペランド型を判定する (choice_slug 発火)。
 * action: show/hide/jump はそのまま・レガシー 'skip' → Formaloo 'jump' に動詞変換。
 */
export function toFormalooRawLogic(
  rules: HarnessLogicRule[],
  resolveSlug: (harnessFieldId: string) => string | undefined,
  fieldById?: (harnessFieldId: string) => HarnessField | undefined,
): unknown[] {
  // form-route-branching compound-fix (2026-07-16 closer O-1 実機再現): 同一 source field の複数ルールを
  // **別々の top-level item として push すると Formaloo は 2 番目以降の item の when を無視し常に最初を適用**する
  // (A/B/C 多岐分岐が黙って誤動作)。同一 source を **1 つの item にまとめ actions 配列に複数** {action,args,when} を
  // 格納する compound 形にすると 3 ルート正しく分岐する (spike 実機実証)。→ source slug でグルーピングして生成。
  // 単一ルールは 1 item・1 action = 従来と byte 一致 (回帰なし)。source 出現順・action 順は builder 順を保持。
  const order: string[] = [];
  const actionsBySrc = new Map<string, unknown[]>();
  for (const r of rules) {
    const srcSlug = resolveSlug(r.sourceFieldId);
    const tgtSlug = resolveSlug(r.targetFieldId);
    if (!srcSlug || !tgtSlug) continue; // 未 push field 等の孤立参照は Formaloo に送らない
    const verb: FormalooActionVerb = r.action === 'skip' ? 'jump' : r.action; // レガシー skip→jump 動詞変換
    const operation: FormalooConditionOperator = r.operator === 'not_equals' ? 'is_not' : 'is';
    const valueOperand = resolveWhenValueOperand(r, fieldById?.(r.sourceFieldId));
    const action = {
      action: verb,
      args: [{ type: 'field', identifier: tgtSlug }],
      when: { operation, args: [{ type: 'field', value: srcSlug }, valueOperand] },
    };
    if (!actionsBySrc.has(srcSlug)) {
      actionsBySrc.set(srcSlug, []);
      order.push(srcSlug);
    }
    actionsBySrc.get(srcSlug)!.push(action);
  }
  return order.map((srcSlug) => ({ type: 'field', identifier: srcSlug, actions: actionsBySrc.get(srcSlug) }));
}

/**
 * Formaloo logic object → harness logic rules (builder open 時の pull / N-8)。
 * whitelist 抽出 (未知プロパティ無視 / M-8)。resolve できない slug の rule は捨てる (N-11 孤立防止)。
 * rule id は安定的に再生成 (r1, r2, ...)。
 */
export function fromFormalooLogic(
  obj: FormalooLogicObject | readonly unknown[],
  resolveFieldId: (formalooFieldSlug: string) => string | undefined,
): HarnessLogicRule[] {
  // R0 実測: 実 Formaloo logic は `.data.form.logic` の bare array (再帰 when 木)。
  // bare array が渡されたら実 item 射影へ委譲 (単純 show/hide の弱化射影 + compound は additive 保持)。
  // legacy synthetic `{rules:[{conditions,actions}]}` 形は従来経路 (byte-unchanged / 既存テスト green)。
  if (Array.isArray(obj)) return fromFormalooRawLogic(obj, resolveFieldId);
  const rulesIn = Array.isArray((obj as FormalooLogicObject)?.rules) ? (obj as FormalooLogicObject).rules : [];
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
export function countWeakenedFormalooRules(obj: FormalooLogicObject | readonly unknown[]): number {
  // R0 実測: bare array (実 Formaloo logic) は harness flat model に射影しきれない item を数える
  // = 「ハーネス表示に映らない部分の点数」。legacy synthetic `{rules}` 形は従来の条件/アクション複数を数える。
  // form-route-branching compound-fix: 展開可能な multi-jump item は N 本の flat rule に逐語展開され欠けが無いため
  // 弱化として数えない (isExpandableMultiJumpItem を除外)。show/hide 複数・AND/OR compound は従来どおり数える。
  if (Array.isArray(obj)) return obj.filter((it) => isCompoundRawLogicItem(it) && !isExpandableMultiJumpItem(it)).length;
  const rulesIn = Array.isArray((obj as FormalooLogicObject)?.rules) ? (obj as FormalooLogicObject).rules : [];
  return rulesIn.filter(
    (r) =>
      (Array.isArray(r?.conditions) && r.conditions.length > 1) ||
      (Array.isArray(r?.actions) && r.actions.length > 1),
  ).length;
}

// =============================================================================
// preserve-raw (formaloo-logic-fidelity Batch 1) — R0 実測: Formaloo logic は
// `.data.form.logic` の bare array of `{ type, identifier, actions:[{action,args,when}] }`。
// when は入れ子 and/or 再帰木。harness flat model の真部分集合にすら収まらないため、
// 「モデル化」でなく「raw 配列を欠けなく保持 + 未編集なら verbatim 再送 (PATCH)」で往復不変を保証する。
// 射影 (下記) は builder への弱化表示用 (Batch 1 は保持のみ・忠実表示は Batch 2)。
// =============================================================================

/** Formaloo logic item の `when` 木を平坦化して leaf 条件群 + 最上位結合子を返す (弱化射影用)。 */
function flattenRawWhen(
  when: unknown,
  resolveFieldId: (slug: string) => string | undefined,
): { conditions: HarnessLogicCondition[]; join?: 'and' | 'or' } {
  if (!when || typeof when !== 'object') return { conditions: [] };
  const w = when as Record<string, unknown>;
  const op = w.operation;
  if (op === 'and' || op === 'or') {
    const conditions: HarnessLogicCondition[] = [];
    const args = Array.isArray(w.args) ? w.args : [];
    for (const sub of args) conditions.push(...flattenRawWhen(sub, resolveFieldId).conditions);
    return { conditions, join: op };
  }
  // leaf: { operation:<op>, args:[ fieldOperand, valueOperand ] }。when.args の field operand は `value`=slug。
  const args = Array.isArray(w.args) ? w.args : [];
  const operands = args.map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}));
  const fieldOperand = operands.find((x) => x.type === 'field');
  const otherOperand = operands.find((x) => x !== fieldOperand);
  const srcSlug = typeof fieldOperand?.value === 'string' ? (fieldOperand.value as string) : '';
  const sourceFieldId = srcSlug ? resolveFieldId(srcSlug) ?? srcSlug : '';
  const rawVal = otherOperand?.value;
  const value = rawVal === undefined || rawVal === null ? '' : String(rawVal);
  const operator = (typeof op === 'string' ? op : 'is') as FormalooConditionOperator | LogicOperator;
  return { conditions: [{ sourceFieldId, operator, value }] };
}

/**
 * Formaloo logic item が harness の単一条件・単一アクション simple rule で表せない (= 弱化される) か。
 * countWeakenedFormalooRules (bare array) と fromFormalooRawLogic (additive 付与判定) の共通述語。
 */
export function isCompoundRawLogicItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const it = item as Record<string, unknown>;
  const rawActions = Array.isArray(it.actions) ? it.actions : [];
  if (rawActions.length === 0) return false;
  if (rawActions.length > 1) return true; // 複数アクション
  const primary = (rawActions[0] && typeof rawActions[0] === 'object' ? rawActions[0] : {}) as Record<string, unknown>;
  const flat = flattenRawWhen(primary.when, (s) => s);
  if (flat.join) return true; // and/or 結合
  if (flat.conditions.length > 1) return true; // 複数条件
  const c0 = flat.conditions[0];
  if (c0 && c0.operator !== 'is' && c0.operator !== 'is_not') return true; // 未モデル operator (gt/gte/is_answered 等)
  const verb = primary.action;
  if (verb !== undefined && verb !== 'show' && verb !== 'hide' && verb !== 'jump' && verb !== 'jump_to_success_page') {
    return true; // 未モデル action (set/add/send_email 等)
  }
  return false;
}

/**
 * 「同一 source field への複数 jump ルールを 1 item にまとめた compound-fix 形」= N 本の独立 flat jump rule に
 * 逐語展開できる item か (form-route-branching compound-fix / pull 対称)。判定:
 *  - actions 2 本以上 かつ 全 action が route verb (jump / jump_to_success_page)
 *  - 各 action の when が単一 leaf (and/or 結合なし・単一条件・operator is/is_not)
 * show/hide 複数アクション (matrix fixture item2) や AND/OR compound は非該当 = 従来の弱化射影のまま (回帰なし)。
 */
export function isExpandableMultiJumpItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const it = item as Record<string, unknown>;
  const rawActions = Array.isArray(it.actions) ? it.actions : [];
  if (rawActions.length < 2) return false; // 単一 action は従来経路 (byte 一致)
  return rawActions.every((a) => {
    const ao = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    if (ao.action !== 'jump' && ao.action !== 'jump_to_success_page') return false; // route verb のみ
    const flat = flattenRawWhen(ao.when, (s) => s);
    if (flat.join) return false; // and/or 結合は展開しない
    if (flat.conditions.length !== 1) return false; // 単一 leaf のみ
    const op = flat.conditions[0].operator;
    return op === 'is' || op === 'is_not';
  });
}

/**
 * 実 Formaloo logic (bare array) → harness rule 射影。simple item は従来同型の flat 弱化射影、
 * compound item (isCompoundRawLogicItem) のみ additive フィールド (conditions/conditionJoin/actions/raw) を付与 (R2)。
 * source/target slug は resolveFieldId で harness id へ (未解決は slug fallback)。弱化不能 item は drop。
 */
export function fromFormalooRawLogic(
  items: readonly unknown[],
  resolveFieldId: (formalooFieldSlug: string) => string | undefined,
): HarnessLogicRule[] {
  const out: HarnessLogicRule[] = [];
  let n = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const rawActions = Array.isArray(it.actions) ? it.actions : [];
    if (rawActions.length === 0) continue;

    // form-route-branching compound-fix (pull 対称): 同一 source への複数 jump を 1 item にまとめた compound 形は
    // N 本の独立 flat jump rule に逐語展開する (builder が全ルートを編集可能に表示)。additive は付けない
    // (各 action = 独立した単一条件単一アクション)。preserve-raw (未編集 verbatim 再送) は route 側で別途担保。
    if (isExpandableMultiJumpItem(item)) {
      for (const a of rawActions) {
        const ao = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
        const aArgs = Array.isArray(ao.args) ? ao.args : [];
        const tgt = aArgs
          .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
          .find((x) => typeof x.identifier === 'string');
        const tgtSlug = typeof tgt?.identifier === 'string' ? (tgt.identifier as string) : '';
        const targetFieldId = tgtSlug ? resolveFieldId(tgtSlug) ?? tgtSlug : '';
        const flat = flattenRawWhen(ao.when, resolveFieldId);
        const c0 = flat.conditions[0];
        if (!c0 || !c0.sourceFieldId || !targetFieldId) continue; // 孤立参照 → drop
        n += 1;
        out.push({
          id: `r${n}`,
          sourceFieldId: c0.sourceFieldId,
          operator: c0.operator === 'is_not' || c0.operator === 'not_equals' ? 'not_equals' : 'equals',
          value: c0.value,
          action: 'jump',
          targetFieldId,
        });
      }
      continue; // 展開済 → 従来の弱化射影経路はスキップ
    }

    const actionRefs: HarnessLogicActionRef[] = [];
    for (const a of rawActions) {
      const ao = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
      const aArgs = Array.isArray(ao.args) ? ao.args : [];
      const tgt = aArgs
        .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
        .find((x) => typeof x.identifier === 'string');
      const tgtSlug = typeof tgt?.identifier === 'string' ? (tgt.identifier as string) : '';
      const targetFieldId = tgtSlug ? resolveFieldId(tgtSlug) ?? tgtSlug : '';
      const verb = (typeof ao.action === 'string' ? ao.action : 'show') as FormalooActionVerb | LogicAction;
      actionRefs.push({ action: verb, targetFieldId });
    }

    const primary = (rawActions[0] && typeof rawActions[0] === 'object' ? rawActions[0] : {}) as Record<string, unknown>;
    const flat = flattenRawWhen(primary.when, resolveFieldId);
    const cond0 = flat.conditions[0];
    const act0 = actionRefs[0];
    if (!cond0 || !act0 || !cond0.sourceFieldId || !act0.targetFieldId) continue; // 弱化不能 / 孤立参照 → drop

    n += 1;
    const flatOperator: LogicOperator =
      cond0.operator === 'is_not' || cond0.operator === 'not_equals' ? 'not_equals' : 'equals';
    // 射影 (form-route-branching R1): jump/jump_to_success_page → 'jump' 正規表示。
    // 'skip' は旧射影名としてレガシー互換で残す (未知動詞→'show')。
    const flatAction: LogicAction =
      act0.action === 'hide'
        ? 'hide'
        : act0.action === 'jump' || act0.action === 'jump_to_success_page'
          ? 'jump'
          : act0.action === 'skip'
            ? 'skip'
            : 'show';
    const rule: HarnessLogicRule = {
      id: `r${n}`,
      sourceFieldId: cond0.sourceFieldId,
      operator: flatOperator,
      value: cond0.value,
      action: flatAction,
      targetFieldId: act0.targetFieldId,
    };
    if (isCompoundRawLogicItem(item)) {
      rule.conditions = flat.conditions;
      if (flat.join) rule.conditionJoin = flat.join;
      rule.actions = actionRefs;
      rule.raw = item;
    }
    out.push(rule);
  }
  return out;
}

/** object の key を再帰的にソートした canonical JSON (配列順は保持 = R0 順序有意)。 */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * logic の semantic deep-equal (R0: object key 順は無意・配列順は有意・server-managed prop 無し)。
 * preserve-raw の往復不変判定 (Formaloo GET canonical object 突合) に使う。
 */
export function semanticLogicEqual(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

/**
 * 射影 logic (HarnessLogicRule[]) の canonical fingerprint。pull 時と save 時に同一関数で算出し
 * deep-equal 比較して「未編集」を判定する (edit-detection / R7)。
 */
export function logicFingerprint(rules: readonly HarnessLogicRule[]): string {
  return canonicalStringify(rules);
}

/**
 * preserve-only push: 未編集時に Formaloo へ再送する logic 配列を返す。
 * R0 実測: 書込は `PATCH /v3.0/forms/{slug}/ {logic:<bare array>}`。raw 配列を **変換せず** そのまま返す
 * (compound / calc / variable / jump / 未モデル構造を欠けなく保持)。array でなければ null (preserve 不成立)。
 */
export function serializeRawLogicForPush(rawLogic: unknown): unknown[] | null {
  return Array.isArray(rawLogic) ? [...rawLogic] : null;
}
