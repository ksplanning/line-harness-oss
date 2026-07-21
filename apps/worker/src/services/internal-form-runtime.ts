import {
  DECORATION_FIELD_TYPES,
  FORMALOO_FIELD_TYPES,
  INTERNAL_ONLY_FIELD_TYPES,
  INTERNAL_FORM_CHANNEL_SOURCE_ID,
  isDecorationType,
  normalizeFormDesign,
  normalizeFormOperationsSettings,
  normalizeFormRedirect,
  normalizeSuccessPages,
  validateHarnessField,
  type FormDesign,
  type FormDisplayType,
  type FormOperationsSettings,
  type FormRedirect,
  type HarnessField,
  type HarnessFieldConfig,
  type HarnessFieldType,
  type HarnessLogicRule,
  type SuccessPageSpec,
} from '@line-crm/shared';

type SupportedInternalFieldType = Exclude<HarnessFieldType, 'choice_fetch'>;

const SUPPORTED_INTERNAL_TYPES = new Set<string>([
  ...FORMALOO_FIELD_TYPES.filter((type) => type !== 'choice_fetch'),
  ...INTERNAL_ONLY_FIELD_TYPES,
  ...DECORATION_FIELD_TYPES,
]);

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const HTML_NUMBER_PATTERN = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SIGNATURE_DATA_URL_PATTERN = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;
const MAX_FORMULA_LENGTH = 2_000;
const MAX_FORMULA_NODES = 512;
const MAX_REPEATING_ROWS = 1_000;

export const JAPAN_PREFECTURES = [
  '北海道',
  '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県',
  '沖縄県',
] as const;

const JAPAN_PREFECTURE_SET = new Set<string>(JAPAN_PREFECTURES);

export interface PostalAutofillConfig {
  zipField: string;
  prefField: string;
  cityField: string;
  townField: string;
}

export type InternalFormField = Omit<HarnessField, 'type' | 'config'> & {
  type: SupportedInternalFieldType;
  config: HarnessFieldConfig & { postalAutofill?: PostalAutofillConfig };
};

function parsePostalAutofill(raw: unknown): PostalAutofillConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const keys = ['zipField', 'prefField', 'cityField', 'townField'] as const;
  if (keys.some((key) => typeof value[key] !== 'string' || !(value[key] as string).trim())) return null;
  return {
    zipField: (value.zipField as string).trim(),
    prefField: (value.prefField as string).trim(),
    cityField: (value.cityField as string).trim(),
    townField: (value.townField as string).trim(),
  };
}

export interface InternalFormDefinition {
  fields: InternalFormField[];
  logic: HarnessLogicRule[];
  buttonText: string | null;
  successMessage: string | null;
  errorMessage: string | null;
  design: FormDesign;
  formType: FormDisplayType;
  formRedirect: FormRedirect;
  successPages: SuccessPageSpec[];
  operationsSettings: FormOperationsSettings;
}

export type InternalAnswerInputValue = string | File | (string | File)[] | undefined;
export type InternalAnswerInput = Record<string, InternalAnswerInputValue>;

export interface PendingInternalUpload {
  fieldId: string;
  fieldIndex: number;
  files: File[];
}

export type InternalAnswerValidationResult =
  | {
      ok: true;
      answers: Record<string, unknown>;
      pendingUploads: PendingInternalUpload[];
    }
  | { ok: false; error: string };

type FormulaNode =
  | { kind: 'number'; value: number }
  | { kind: 'reference'; id: string }
  | { kind: 'unary'; operator: '+' | '-'; operand: FormulaNode }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode };

class FormulaSyntaxError extends Error {}

class FormulaParser {
  private cursor = 0;
  private nodeCount = 0;

  constructor(private readonly source: string) {}

  parse(): FormulaNode {
    if (!this.source.trim() || this.source.length > MAX_FORMULA_LENGTH) {
      throw new FormulaSyntaxError('invalid formula length');
    }
    const node = this.expression();
    this.skipWhitespace();
    if (this.cursor !== this.source.length) throw new FormulaSyntaxError('unexpected token');
    return node;
  }

  private make<T extends FormulaNode>(node: T): T {
    this.nodeCount += 1;
    if (this.nodeCount > MAX_FORMULA_NODES) throw new FormulaSyntaxError('formula too complex');
    return node;
  }

  private expression(): FormulaNode {
    let left = this.term();
    while (true) {
      this.skipWhitespace();
      const operator = this.source[this.cursor];
      if (operator !== '+' && operator !== '-') return left;
      this.cursor += 1;
      left = this.make({ kind: 'binary', operator, left, right: this.term() });
    }
  }

  private term(): FormulaNode {
    let left = this.unary();
    while (true) {
      this.skipWhitespace();
      const operator = this.source[this.cursor];
      if (operator !== '*' && operator !== '/') return left;
      this.cursor += 1;
      left = this.make({ kind: 'binary', operator, left, right: this.unary() });
    }
  }

  private unary(): FormulaNode {
    this.skipWhitespace();
    const operator = this.source[this.cursor];
    if (operator === '+' || operator === '-') {
      this.cursor += 1;
      return this.make({ kind: 'unary', operator, operand: this.unary() });
    }
    return this.primary();
  }

  private primary(): FormulaNode {
    this.skipWhitespace();
    if (this.source[this.cursor] === '(') {
      this.cursor += 1;
      const node = this.expression();
      this.skipWhitespace();
      if (this.source[this.cursor] !== ')') throw new FormulaSyntaxError('missing closing parenthesis');
      this.cursor += 1;
      return node;
    }
    if (this.source[this.cursor] === '{') {
      const close = this.source.indexOf('}', this.cursor + 1);
      if (close < 0) throw new FormulaSyntaxError('missing reference close');
      const id = this.source.slice(this.cursor + 1, close).trim();
      if (!id || id.includes('{')) throw new FormulaSyntaxError('invalid reference');
      this.cursor = close + 1;
      return this.make({ kind: 'reference', id });
    }

    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.cursor));
    if (!match) throw new FormulaSyntaxError('number expected');
    this.cursor += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new FormulaSyntaxError('non-finite number literal');
    return this.make({ kind: 'number', value });
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.cursor] ?? '')) this.cursor += 1;
  }
}

function parseFormula(formula: string): { ok: true; node: FormulaNode } | { ok: false; error: string } {
  try {
    return { ok: true, node: new FormulaParser(formula).parse() };
  } catch {
    return { ok: false, error: '計算式の形式が正しくありません' };
  }
}

function formulaReferences(node: FormulaNode, result: string[] = []): string[] {
  if (node.kind === 'reference') {
    if (!result.includes(node.id)) result.push(node.id);
    return result;
  }
  if (node.kind === 'unary') return formulaReferences(node.operand, result);
  if (node.kind === 'binary') {
    formulaReferences(node.left, result);
    formulaReferences(node.right, result);
  }
  return result;
}

function formulaValue(value: unknown, id: string): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
  if (typeof value === 'boolean') return { ok: true, value: value ? 1 : 0 };
  if (typeof value === 'string' && HTML_NUMBER_PATTERN.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return { ok: true, value: parsed };
  }
  return { ok: false, error: `計算式の参照値がありません: ${id}` };
}

function evaluateFormulaNode(
  node: FormulaNode,
  values: Record<string, unknown>,
): { ok: true; value: number } | { ok: false; error: string } {
  if (node.kind === 'number') return { ok: true, value: node.value };
  if (node.kind === 'reference') {
    if (!Object.prototype.hasOwnProperty.call(values, node.id)) {
      return { ok: false, error: `計算式の参照値がありません: ${node.id}` };
    }
    return formulaValue(values[node.id], node.id);
  }
  if (node.kind === 'unary') {
    const operand = evaluateFormulaNode(node.operand, values);
    if (!operand.ok) return operand;
    const value = node.operator === '-' ? -operand.value : operand.value;
    return Number.isFinite(value)
      ? { ok: true, value: Object.is(value, -0) ? 0 : value }
      : { ok: false, error: '計算結果が有限の数値になりません' };
  }

  const left = evaluateFormulaNode(node.left, values);
  if (!left.ok) return left;
  const right = evaluateFormulaNode(node.right, values);
  if (!right.ok) return right;
  if (node.operator === '/' && right.value === 0) {
    return { ok: false, error: '計算式で0除算はできません' };
  }
  const value = node.operator === '+'
    ? left.value + right.value
    : node.operator === '-'
      ? left.value - right.value
      : node.operator === '*'
        ? left.value * right.value
        : left.value / right.value;
  return Number.isFinite(value)
    ? { ok: true, value: Object.is(value, -0) ? 0 : value }
    : { ok: false, error: '計算結果が有限の数値になりません' };
}

/** `eval` を使わず、四則演算・括弧・数値・`{fieldId}` だけを評価する。 */
export function evaluateInternalFormula(
  formula: string,
  values: Record<string, unknown>,
): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = parseFormula(formula);
  if (!parsed.ok) return parsed;
  return evaluateFormulaNode(parsed.node, values);
}

function safeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function matrixColumns(field: InternalFormField): Array<{ key: string; title: string }> {
  return Object.entries(field.config.matrixChoiceItems ?? {}).flatMap(([key, item]) => (
    item && typeof item === 'object' && !Array.isArray(item) && typeof item.title === 'string'
      ? [{ key, title: item.title }]
      : []
  ));
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function validatePerFieldDefinition(field: InternalFormField): string | null {
  const config = field.config;
  if (config.minLength !== undefined || config.maxLength !== undefined) {
    if (field.type !== 'text' && field.type !== 'textarea') return '文字数制限はテキスト項目だけに設定できます';
    if (config.minLength !== undefined && (!Number.isInteger(config.minLength) || config.minLength < 0)) {
      return '文字数下限が正しくありません';
    }
    if (config.maxLength !== undefined && (!Number.isInteger(config.maxLength) || config.maxLength < 1)) {
      return '文字数上限が正しくありません';
    }
    if (config.minLength !== undefined && config.maxLength !== undefined && config.minLength > config.maxLength) {
      return '文字数下限は上限以下にしてください';
    }
  }

  if (field.type === 'choice' || field.type === 'dropdown' || field.type === 'multiple_select') {
    const choices = field.config.choices;
    if (!choices?.length || duplicate(choices) || choices.some((choice) => !choice)) return '選択肢が正しくありません';
    if (field.type === 'multiple_select') {
      if (config.defaultValue !== undefined) return '複数選択の既定値が正しくありません';
      const defaults = config.defaultValues ?? [];
      if (duplicate(defaults) || defaults.some((value) => !choices.includes(value))) return '複数選択の既定値が正しくありません';
    } else {
      if (config.defaultValues !== undefined) return '既定選択肢が正しくありません';
      if (config.defaultValue !== undefined && !choices.includes(config.defaultValue)) return '既定選択肢が正しくありません';
    }
  } else if (config.defaultValue !== undefined || config.defaultValues !== undefined) {
    return '既定選択肢を設定できない項目です';
  }

  if (field.type === 'file' && config.allowedExtensions !== undefined) {
    const extensions = config.allowedExtensions.map((value) => value.replace(/^\./, '').toLowerCase());
    if (
      extensions.some((value) => !/^[a-z0-9]+$/.test(value))
      || duplicate(extensions)
    ) return 'ファイルの許可拡張子が正しくありません';
    field.config.allowedExtensions = extensions;
  }

  if (field.type === 'matrix') {
    const columns = matrixColumns(field);
    const rawColumnCount = Object.keys(field.config.matrixChoiceItems ?? {}).length;
    const rows = field.config.matrixChoiceGroups ?? [];
    const columnTitles = columns.map((column) => column.title.trim());
    const rowTitles = rows.map((row) => row.title.trim());
    if (
      !columns.length
      || columns.length !== rawColumnCount
      || !rows.length
      || duplicate(columnTitles)
      || duplicate(rowTitles)
      || [...columnTitles, ...rowTitles].some((title) => !title.trim() || UNSAFE_OBJECT_KEYS.has(title))
    ) return '行列の行と列は重複しない名前で設定してください';
  }

  if (field.type === 'video' && !safeHttpUrl(field.config.videoUrl ?? '')) {
    return '動画URLは http(s) で指定してください';
  }

  if (field.type === 'variable' && field.config.decimalPlaces !== undefined && field.config.decimalPlaces > 20) {
    return '計算結果の小数桁数は20以下にしてください';
  }

  return null;
}

function formulaReferenceAllowed(field: InternalFormField, repeatingTemplates: ReadonlySet<string>): boolean {
  return !isDecorationType(field.type)
    && field.type !== 'file'
    && field.type !== 'signature'
    && field.type !== 'matrix'
    && field.type !== 'repeating_section'
    && !(field.type === 'variable' && field.config.variableSubType !== 'formula')
    && !repeatingTemplates.has(field.id);
}

function validateDefinitionRelationships(fields: InternalFormField[]): string | null {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const repeatingTemplates = new Set<string>();

  for (const repeat of fields.filter((field) => field.type === 'repeating_section')) {
    const columnIds = (repeat.config.repeatingColumns ?? []).map((column) => column.columnField);
    if (!columnIds.length || duplicate(columnIds)) return '繰り返しセクションの列が正しくありません';
    for (const id of columnIds) {
      const template = byId.get(id);
      if (
        !template
        || isDecorationType(template.type)
        || template.type === 'variable'
        || template.type === 'matrix'
        || template.type === 'repeating_section'
        || template.type === 'file'
      ) return '繰り返しセクションの参照項目が正しくありません';
      repeatingTemplates.add(id);
    }
  }

  const formulaNodes = new Map<string, FormulaNode>();
  const formulaFields = fields.filter(
    (field) => field.type === 'variable' && field.config.variableSubType === 'formula',
  );
  for (const field of formulaFields) {
    const parsed = parseFormula(field.config.formula ?? '');
    if (!parsed.ok) return `${field.label}: ${parsed.error}`;
    for (const id of formulaReferences(parsed.node)) {
      const target = byId.get(id);
      if (!target || !formulaReferenceAllowed(target, repeatingTemplates)) {
        return `${field.label} の計算式の参照先が正しくありません: ${id}`;
      }
    }
    formulaNodes.set(field.id, parsed.node);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    const node = formulaNodes.get(id);
    if (node) {
      for (const ref of formulaReferences(node)) {
        if (formulaNodes.has(ref) && !visit(ref)) return false;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const field of formulaFields) {
    if (!visit(field.id)) return '計算式の参照が循環しています';
  }
  return null;
}

export function parseInternalFormDefinition(
  definitionJson: string,
): { ok: true; definition: InternalFormDefinition } | { ok: false; error: string } {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(definitionJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid definition');
    raw = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'フォーム定義を読み込めません' };
  }

  if (!Array.isArray(raw.fields)) return { ok: false, error: 'フォーム項目を読み込めません' };
  if (raw.formType !== undefined && raw.formType !== 'simple' && raw.formType !== 'multi_step') {
    return { ok: false, error: 'フォーム表示形式を読み込めません' };
  }

  const ids = new Set<string>();
  const fields: InternalFormField[] = [];
  for (const item of raw.fields) {
    const result = validateHarnessField(item, { allowInternalOnly: true });
    if (!result.ok || !SUPPORTED_INTERNAL_TYPES.has(result.field.type)) {
      return { ok: false, error: '未対応の項目を含むため自前配信できません' };
    }
    if (ids.has(result.field.id)) return { ok: false, error: '項目IDが重複しています' };
    ids.add(result.field.id);

    const rawConfig = item && typeof item === 'object' && !Array.isArray(item)
      ? (item as { config?: unknown }).config
      : undefined;
    const rawPostal = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
      ? (rawConfig as Record<string, unknown>).postalAutofill
      : undefined;
    const postalAutofill = rawPostal === undefined ? undefined : parsePostalAutofill(rawPostal);
    if (rawPostal !== undefined && !postalAutofill) {
      return { ok: false, error: '郵便番号自動入力の項目設定が正しくありません' };
    }
    const field = {
      ...result.field,
      config: { ...result.field.config, ...(postalAutofill ? { postalAutofill } : {}) },
    } as InternalFormField;
    const configError = validatePerFieldDefinition(field);
    if (configError) return { ok: false, error: configError };
    fields.push(field);
  }

  fields.sort((a, b) => a.position - b.position);
  const relationshipError = validateDefinitionRelationships(fields);
  if (relationshipError) return { ok: false, error: relationshipError };

  const fieldForPostal = new Map(fields.map((field) => [field.id, field]));
  for (const field of fields) {
    const postal = field.config.postalAutofill;
    if (!postal) continue;
    const referencedIds = [postal.zipField, postal.prefField, postal.cityField, postal.townField];
    if (
      postal.zipField !== field.id
      || new Set(referencedIds).size !== referencedIds.length
      || referencedIds.some((id) => fieldForPostal.get(id)?.type !== 'text')
    ) {
      return { ok: false, error: '郵便番号自動入力の項目設定が正しくありません' };
    }
  }
  if (raw.logic !== undefined && !Array.isArray(raw.logic)) {
    return { ok: false, error: '分岐設定を読み込めません' };
  }
  const successPages = normalizeSuccessPages(raw.successPages);
  const successPageIds = new Set(successPages.map((page) => page.id));
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const compoundOperators = new Set([
    'equals', 'not_equals', 'is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'is_answered',
  ]);
  const internalActions = new Set(['show', 'hide', 'jump', 'skip', 'submit']);
  const validSource = (sourceFieldId: string) => (
    sourceFieldId === INTERNAL_FORM_CHANNEL_SOURCE_ID || fieldById.has(sourceFieldId)
  );
  const validTarget = (action: string, targetFieldId: string) => (
    action === 'submit'
      ? (!targetFieldId || successPageIds.has(targetFieldId))
      : fieldById.has(targetFieldId)
  );
  const logic: HarnessLogicRule[] = [];
  for (const candidate of Array.isArray(raw.logic) ? raw.logic : []) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { ok: false, error: '分岐設定を読み込めません' };
    }
    const rule = candidate as Partial<HarnessLogicRule>;
    if (
      typeof rule.id !== 'string' || !rule.id
      || typeof rule.sourceFieldId !== 'string'
      || (rule.operator !== 'equals' && rule.operator !== 'not_equals')
      || typeof rule.value !== 'string'
      || !['show', 'hide', 'jump', 'skip', 'submit'].includes(String(rule.action))
      || typeof rule.targetFieldId !== 'string'
    ) return { ok: false, error: '分岐設定を読み込めません' };
    const channelSource = rule.sourceFieldId === INTERNAL_FORM_CHANNEL_SOURCE_ID;
    if (!channelSource && !fieldById.has(rule.sourceFieldId)) {
      return { ok: false, error: '分岐元の項目が見つかりません' };
    }
    if (channelSource && rule.value !== 'line' && rule.value !== 'web') {
      return { ok: false, error: '経由チャネルは LINE または直リンクを指定してください' };
    }
    if (rule.action === 'submit') {
      if (rule.targetFieldId && !successPageIds.has(rule.targetFieldId)) {
        return { ok: false, error: '完了ページが見つかりません' };
      }
    } else if (!fieldById.has(rule.targetFieldId)) {
      return { ok: false, error: '分岐先の項目が見つかりません' };
    }
    if (rule.conditionJoin !== undefined && rule.conditionJoin !== 'and' && rule.conditionJoin !== 'or') {
      return { ok: false, error: '分岐設定を読み込めません' };
    }
    if (rule.conditions !== undefined) {
      if (!Array.isArray(rule.conditions)) return { ok: false, error: '分岐設定を読み込めません' };
      for (const condition of rule.conditions) {
        if (
          !condition || typeof condition !== 'object' || Array.isArray(condition)
          || typeof condition.sourceFieldId !== 'string' || !validSource(condition.sourceFieldId)
          || !compoundOperators.has(String(condition.operator))
          || typeof condition.value !== 'string'
          || (condition.sourceFieldId === INTERNAL_FORM_CHANNEL_SOURCE_ID
            && condition.value !== 'line' && condition.value !== 'web')
        ) return { ok: false, error: '分岐設定を読み込めません' };
      }
    }
    if (rule.actions !== undefined) {
      if (!Array.isArray(rule.actions)) return { ok: false, error: '分岐設定を読み込めません' };
      for (const action of rule.actions) {
        if (
          !action || typeof action !== 'object' || Array.isArray(action)
          || !internalActions.has(String(action.action))
          || typeof action.targetFieldId !== 'string'
          || !validTarget(String(action.action), action.targetFieldId)
        ) return { ok: false, error: '分岐設定を読み込めません' };
      }
    }
    logic.push(candidate as HarnessLogicRule);
  }
  const formCopy = raw.formCopy && typeof raw.formCopy === 'object' && !Array.isArray(raw.formCopy)
    ? raw.formCopy as Record<string, unknown>
    : {};
  const formRedirect = normalizeFormRedirect(raw.formRedirect);
  if (formRedirect.url && /[\u0000-\u001f\u007f]/.test(formRedirect.url)) {
    return { ok: false, error: '送信後の飛び先URLに使用できない文字が含まれています' };
  }
  const operationsSettings = normalizeFormOperationsSettings(raw.operationsSettings);
  if (
    operationsSettings.submitStartTime
    && operationsSettings.submitEndTime
    && Date.parse(operationsSettings.submitEndTime) <= Date.parse(operationsSettings.submitStartTime)
  ) {
    return { ok: false, error: '受付終了は受付開始より後の日時にしてください' };
  }
  return {
    ok: true,
    definition: {
      fields,
      logic,
      buttonText: typeof formCopy.buttonText === 'string' && formCopy.buttonText.trim()
        ? formCopy.buttonText.trim()
        : null,
      successMessage: typeof formCopy.successMessage === 'string' && formCopy.successMessage.trim()
        ? formCopy.successMessage.trim()
        : null,
      errorMessage: typeof formCopy.errorMessage === 'string' && formCopy.errorMessage.trim()
        ? formCopy.errorMessage.trim()
        : null,
      design: normalizeFormDesign(raw.design),
      formType: raw.formType === 'multi_step' ? 'multi_step' : 'simple',
      formRedirect,
      successPages,
      operationsSettings,
    },
  };
}

export type InternalFormAvailability = {
  status: 'open' | 'upcoming' | 'ended' | 'limit_reached';
  message: string | null;
};

function japaneseMonthDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric',
  }).formatToParts(date);
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  return `${month}月${day}日`;
}

export function evaluateInternalFormAvailability(
  definition: Pick<InternalFormDefinition, 'operationsSettings'>,
  submissionCount: number,
  now = new Date(),
): InternalFormAvailability {
  const settings = definition.operationsSettings;
  const start = settings.submitStartTime ? new Date(settings.submitStartTime) : null;
  const end = settings.submitEndTime ? new Date(settings.submitEndTime) : null;
  if (start && now.getTime() < start.getTime()) {
    return { status: 'upcoming', message: `受付開始前・${japaneseMonthDay(start)}から` };
  }
  if (end && now.getTime() >= end.getTime()) {
    return { status: 'ended', message: '受付は終了しました' };
  }
  if (settings.maxSubmitCount !== undefined && submissionCount >= settings.maxSubmitCount) {
    return { status: 'limit_reached', message: '回答上限に達したため受付を終了しました' };
  }
  return { status: 'open', message: null };
}

function valuesAt(input: InternalAnswerInput, key: string): Array<string | File> {
  const value = input[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function stringsAt(
  input: InternalAnswerInput,
  key: string,
  label: string,
): { ok: true; values: string[] } | { ok: false; error: string } {
  const values = valuesAt(input, key);
  if (values.some((value) => typeof value !== 'string')) return invalidFormat(label);
  return { ok: true, values: values as string[] };
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function validTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  return !!match && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] ?? 0) < 60;
}

function validDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)$/.exec(value);
  return !!match && validDate(match[1]) && validTime(match[2]);
}

function invalidFormat(label: string) {
  return { ok: false as const, error: `${label} の形式が正しくありません` };
}

type NormalizedValue =
  | { ok: true; present: true; value: unknown }
  | { ok: true; present: false }
  | { ok: false; error: string };

function normalizeRating(field: InternalFormField, value: string, label: string): NormalizedValue {
  const subType = field.config.ratingSubType ?? 'star';
  if (subType === 'like_dislike') {
    return value === 'like' || value === 'dislike'
      ? { ok: true, present: true, value }
      : invalidFormat(label);
  }
  if (!HTML_NUMBER_PATTERN.test(value)) return invalidFormat(label);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return invalidFormat(label);
  if ((subType === 'star' || subType === 'embeded') && (!Number.isInteger(parsed) || parsed < 1 || parsed > 5)) {
    return invalidFormat(label);
  }
  if (subType === 'nps' && (!Number.isInteger(parsed) || parsed < 0 || parsed > 10)) return invalidFormat(label);
  return { ok: true, present: true, value: parsed };
}

function normalizeScalarField(
  field: InternalFormField,
  input: InternalAnswerInput,
  inputName: string,
  label = field.label,
): NormalizedValue {
  const raw = stringsAt(input, inputName, label);
  if (!raw.ok) return raw;

  if (field.type === 'multiple_select') {
    const selected = [...new Set(raw.values.filter((value) => value !== ''))];
    if (field.required && selected.length === 0) return { ok: false, error: `${label} は必須項目です` };
    const choices = field.config.choices ?? [];
    if (selected.some((value) => !choices.includes(value))) {
      return { ok: false, error: `${label} の選択肢が正しくありません` };
    }
    return { ok: true, present: true, value: selected };
  }

  if (raw.values.length > 1) return invalidFormat(label);
  const value = raw.values[0] ?? '';
  if (field.required && value.trim() === '') return { ok: false, error: `${label} は必須項目です` };
  if (value === '') {
    return field.type === 'number'
      ? { ok: true, present: false }
      : { ok: true, present: true, value: '' };
  }

  if (field.type === 'text' || field.type === 'textarea') {
    const length = Array.from(value).length;
    if (field.config.minLength !== undefined && length < field.config.minLength) {
      return { ok: false, error: `${label} は${field.config.minLength}文字以上で入力してください` };
    }
    if (field.config.maxLength !== undefined && length > field.config.maxLength) {
      return { ok: false, error: `${label} は${field.config.maxLength}文字以内で入力してください` };
    }
    return { ok: true, present: true, value };
  }

  if (field.type === 'number') {
    if (!HTML_NUMBER_PATTERN.test(value)) return invalidFormat(label);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? { ok: true, present: true, value: parsed } : invalidFormat(label);
  }

  if (field.type === 'email') {
    const normalized = value.trim();
    return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
      ? { ok: true, present: true, value: normalized }
      : invalidFormat(label);
  }

  if (field.type === 'phone') {
    const normalized = value.trim();
    const digitCount = normalized.replace(/\D/g, '').length;
    return /^[+\d][\d\s()+-]*$/.test(normalized) && digitCount >= 6 && digitCount <= 15
      ? { ok: true, present: true, value: normalized }
      : invalidFormat(label);
  }

  if (field.type === 'date') return validDate(value)
    ? { ok: true, present: true, value }
    : invalidFormat(label);
  if (field.type === 'time') return validTime(value)
    ? { ok: true, present: true, value }
    : invalidFormat(label);
  if (field.type === 'datetime') return validDateTime(value)
    ? { ok: true, present: true, value }
    : invalidFormat(label);

  if (field.type === 'website') {
    const normalized = value.trim();
    return safeHttpUrl(normalized)
      ? { ok: true, present: true, value: normalized }
      : invalidFormat(label);
  }

  if (field.type === 'choice' || field.type === 'dropdown') {
    return (field.config.choices ?? []).includes(value)
      ? { ok: true, present: true, value }
      : { ok: false, error: `${label} の選択肢が正しくありません` };
  }

  if (field.type === 'yes_no') {
    if (value === 'yes') return { ok: true, present: true, value: true };
    if (value === 'no') return { ok: true, present: true, value: false };
    return invalidFormat(label);
  }

  if (field.type === 'rating') return normalizeRating(field, value, label);

  if (field.type === 'signature') {
    const match = SIGNATURE_DATA_URL_PATTERN.exec(value);
    if (!match) return invalidFormat(label);
    const padding = match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0;
    const bytes = Math.floor((match[1].length * 3) / 4) - padding;
    return bytes <= MAX_SIGNATURE_BYTES
      ? { ok: true, present: true, value }
      : { ok: false, error: `${label} のデータが大きすぎます` };
  }

  if (field.type === 'postal_code') {
    const normalized = value.trim().replace(/[\s\-ー－]/g, '');
    return /^\d{7}$/.test(normalized)
      ? { ok: true, present: true, value: normalized }
      : invalidFormat(label);
  }

  if (field.type === 'prefecture') {
    return JAPAN_PREFECTURE_SET.has(value)
      ? { ok: true, present: true, value }
      : { ok: false, error: `${label} の選択肢が正しくありません` };
  }

  if (
    field.type === 'country'
    || field.type === 'city'
    || field.type === 'address_city'
    || field.type === 'address_street'
    || field.type === 'address_building'
  ) return { ok: true, present: true, value: value.trim() };

  return { ok: true, present: true, value };
}

function validateFileField(
  field: InternalFormField,
  input: InternalAnswerInput,
  inputName: string,
  fieldIndex: number,
): { ok: true; pending: PendingInternalUpload | null } | { ok: false; error: string } {
  const values = valuesAt(input, inputName);
  if (values.some((value) => typeof value === 'string' && value !== '')) return invalidFormat(field.label);
  if (values.some((value) => typeof value === 'string')) {
    return values.every((value) => value === '')
      ? field.required
        ? { ok: false, error: `${field.label} は必須項目です` }
        : { ok: true, pending: null }
      : invalidFormat(field.label);
  }
  const files = (values as File[]).filter((file) => file.name !== '' || file.size > 0);
  if (field.required && files.length === 0) return { ok: false, error: `${field.label} は必須項目です` };
  if (files.length === 0) return { ok: true, pending: null };
  if (field.config.allowMultipleFiles !== true && files.length > 1) {
    return { ok: false, error: `${field.label} は1つのファイルだけ添付できます` };
  }
  const allowed = new Set((field.config.allowedExtensions ?? []).map((value) => value.replace(/^\./, '').toLowerCase()));
  const maxBytes = (field.config.maxSizeKb ?? 2048) * 1024;
  for (const file of files) {
    const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    if (allowed.size > 0 && !allowed.has(extension)) {
      return { ok: false, error: `${field.label} の拡張子は許可されていません` };
    }
    if (file.size > maxBytes) return { ok: false, error: `${field.label} のファイルサイズが上限を超えています` };
  }
  return { ok: true, pending: { fieldId: field.id, fieldIndex, files } };
}

function validateMatrixField(
  field: InternalFormField,
  input: InternalAnswerInput,
  fieldIndex: number,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const columns = matrixColumns(field);
  const columnByKey = new Map(columns.map((column) => [column.key, column.title]));
  const value: Record<string, string> = {};
  for (const [rowIndex, row] of (field.config.matrixChoiceGroups ?? []).entries()) {
    const raw = stringsAt(input, `a_${fieldIndex}_m_${rowIndex}`, field.label);
    if (!raw.ok) return raw;
    if (raw.values.length > 1) return invalidFormat(field.label);
    const selected = raw.values[0] ?? '';
    if (!selected) {
      if (field.required) return { ok: false, error: `${field.label} は必須項目です` };
      continue;
    }
    const title = columnByKey.get(selected);
    if (!title) return { ok: false, error: `${field.label} の選択肢が正しくありません` };
    Object.defineProperty(value, row.title, { value: title, enumerable: true, configurable: true });
  }
  return { ok: true, value };
}

function validateRepeatingField(
  field: InternalFormField,
  input: InternalAnswerInput,
  fieldIndex: number,
  byId: ReadonlyMap<string, InternalFormField>,
): { ok: true; value: Record<string, unknown>[] } | { ok: false; error: string } {
  const countInput = stringsAt(input, `a_${fieldIndex}_count`, field.label);
  if (!countInput.ok) return countInput;
  if (countInput.values.length > 1) return invalidFormat(field.label);
  const rawCount = countInput.values[0] ?? '0';
  if (!/^\d+$/.test(rawCount)) return invalidFormat(field.label);
  const count = Number(rawCount);
  const configuredMin = field.config.minRows ?? 0;
  const min = field.required ? Math.max(1, configuredMin) : configuredMin;
  const max = Math.min(field.config.maxRows ?? MAX_REPEATING_ROWS, MAX_REPEATING_ROWS);
  if (count < min) return { ok: false, error: `${field.label} は${min}行以上入力してください` };
  if (count > max) return { ok: false, error: `${field.label} は${max}行以内で入力してください` };

  const columns = field.config.repeatingColumns ?? [];
  const rows: Record<string, unknown>[] = [];
  for (let rowIndex = 0; rowIndex < count; rowIndex++) {
    const row: Record<string, unknown> = {};
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columns[columnIndex];
      const template = byId.get(column.columnField);
      if (!template) return { ok: false, error: `${field.label} の列定義が正しくありません` };
      const normalized = normalizeScalarField(
        template,
        input,
        `a_${fieldIndex}_r_${rowIndex}_${columnIndex}`,
        `${field.label} ${column.title}`,
      );
      if (!normalized.ok) return normalized;
      if (normalized.present) Object.defineProperty(row, template.id, {
        value: normalized.value,
        enumerable: true,
        configurable: true,
      });
    }
    rows.push(row);
  }
  return { ok: true, value: rows };
}

function roundedFormulaValue(value: number, decimalPlaces: number | undefined): number | null {
  if (decimalPlaces === undefined) return value;
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 20) return null;
  const rounded = Number(value.toFixed(decimalPlaces));
  return Number.isFinite(rounded) ? rounded : null;
}

export function validateInternalFormAnswers(
  fields: InternalFormField[],
  input: InternalAnswerInput,
  options: { visibleFieldIds?: string[] } = {},
): InternalAnswerValidationResult {
  const answers = Object.create(null) as Record<string, unknown>;
  const pendingUploads: PendingInternalUpload[] = [];
  const visible = options.visibleFieldIds ? new Set(options.visibleFieldIds) : null;
  const byId = new Map(fields.map((field) => [field.id, field]));
  const repeatingTemplates = new Set(
    fields
      .filter((field) => field.type === 'repeating_section')
      .flatMap((field) => (field.config.repeatingColumns ?? []).map((column) => column.columnField)),
  );

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (visible && !visible.has(field.id)) continue;
    if (repeatingTemplates.has(field.id) || isDecorationType(field.type) || field.type === 'variable') continue;

    if (field.type === 'file') {
      const result = validateFileField(field, input, `a_${index}`, index);
      if (!result.ok) return result;
      if (result.pending) pendingUploads.push(result.pending);
      continue;
    }
    if (field.type === 'matrix') {
      const result = validateMatrixField(field, input, index);
      if (!result.ok) return result;
      answers[field.id] = result.value;
      continue;
    }
    if (field.type === 'repeating_section') {
      const result = validateRepeatingField(field, input, index, byId);
      if (!result.ok) return result;
      answers[field.id] = result.value;
      continue;
    }

    const normalized = normalizeScalarField(field, input, `a_${index}`);
    if (!normalized.ok) return normalized;
    if (normalized.present) answers[field.id] = normalized.value;
  }

  const formulaFields = fields.filter((field) => (
    (!visible || visible.has(field.id))
    && field.type === 'variable'
    && field.config.variableSubType === 'formula'
  ));
  const pending = [...formulaFields];
  while (pending.length > 0) {
    let progressed = false;
    for (let index = 0; index < pending.length;) {
      const field = pending[index];
      const parsed = parseFormula(field.config.formula ?? '');
      if (!parsed.ok) return { ok: false, error: `${field.label}: ${parsed.error}` };
      const dependencies = formulaReferences(parsed.node);
      const unresolvedFormula = dependencies.some((id) => pending.some((candidate) => candidate.id === id));
      if (unresolvedFormula) {
        index += 1;
        continue;
      }
      const evaluated = evaluateFormulaNode(parsed.node, answers);
      if (!evaluated.ok) return { ok: false, error: `${field.label} の計算に失敗しました: ${evaluated.error}` };
      const rounded = roundedFormulaValue(evaluated.value, field.config.decimalPlaces);
      if (rounded === null) return { ok: false, error: `${field.label} の計算結果が正しくありません` };
      answers[field.id] = rounded;
      pending.splice(index, 1);
      progressed = true;
    }
    if (!progressed) return { ok: false, error: '計算式の参照が循環しています' };
  }

  return { ok: true, answers, pendingUploads };
}
