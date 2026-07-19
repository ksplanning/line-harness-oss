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

import type { FormCopy } from './form-copy';
import type { FormRedirect } from './form-redirect';
import type { FormOperationsSettings } from './form-operations';
import type { SuccessPageSpec } from './form-success-page';
import { buildImageDescriptionHtml, parseImageDescription, isImageWidth, isSafeImageUrl, type ImageWidth } from './form-image';
import { validateImageUpload, type FormDesignImageUpload } from './form-design';

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
  // treasure-b1-palette: 入力型 additive (rating=星/良悪/NPS/点数・signature=手書きサイン)。逆引き自動生成。
  'rating',
  'signature',
  // treasure-b3-calc-dynamic: 計算変数 + 公開 endpoint から取得する動的選択肢。
  'variable',
  'choice_fetch',
] as const;

// treasure-b1-palette: video は装飾 (回答なし・required 常時 false) だが Formaloo type は oembed (下 HARNESS_TO_FORMALOO_TYPE)。
// form-image-decoration: image は装飾 (差し込み画像)。Formaloo type=meta/section で description に canonical <img>
//   (spike S-1 実証: files/=401・field 直添付黙殺ゆえ section description の <img> だけが hosted 描画)。
export const DECORATION_FIELD_TYPES = ['section', 'page_break', 'video', 'image'] as const;

/**
 * rating (Formaloo type=rating) の sub_type 実値 (spike 実測: OPTIONS /v3.0/fields/rating/ choices)。
 * "embeded" は Formaloo の綴りママ。既定 star は「未設定」扱い (push/pull/fingerprint で drop = maxSizeKb=2048 と同型)。
 * UI 露出は star/like_dislike/nps/score の 4 種 (embeded は pull 安全のため受理のみ) = field-types.ts RATING_SUB_TYPE_OPTIONS。
 */
export const RATING_SUB_TYPES = ['star', 'like_dislike', 'nps', 'score', 'embeded'] as const;
export type RatingSubType = (typeof RATING_SUB_TYPES)[number];
export const VARIABLE_SUB_TYPES = ['int', 'string', 'decimal', 'formula'] as const;
export type VariableSubType = (typeof VARIABLE_SUB_TYPES)[number];
export interface ChoiceFetchItem {
  label: string;
  value: string;
}
export type HarnessDecorationType = (typeof DECORATION_FIELD_TYPES)[number];

/**
 * b1-field-polish: video(oembed) の既定表示高さ (単一正本)。spike 実測: oembed 既定 config.height=100px の
 * 薄帯 (441×100) は再生不能。250px で 441×250 = 再生可能 (OD-3)。push は videoHeight 未設定時この値を補完し
 * url と常時同送する (既存 video も次回保存で拡大 / OD-4)。pull はこの既定値を drop して false-drift を防ぐ。
 */
export const DEFAULT_VIDEO_HEIGHT = '250px';

/** videoHeight の受理形式 (CSS 注入防止で自由文字列を通さない / 2〜4 桁 px|vw のみ)。 */
const VIDEO_HEIGHT_PATTERN = /^\d{2,4}(px|vw)$/;

export type HarnessFieldType = (typeof FORMALOO_FIELD_TYPES)[number] | HarnessDecorationType;

// =============================================================================
// fr-id-capture-fix (R3 / T-C1): LINE friend 識別のための system hidden field 単一正本。
// -----------------------------------------------------------------------------
// /fo は friend 解決時、転送先 Formaloo URL へ `?fr_id=<署名>` `?fr_name=<表示名>` を付与する。
// Formaloo hosted prefill は **field の alias** でのみ URL param を捕捉する (planner LIVE spike F1/F2 実測:
// field slug 名 param は無効・alias 一致のみ)。ゆえに対象 form に alias='fr_id'/'fr_name' の hidden field が
// 実在しないと fr_id が row に載らず friend_id 復元 0 = 再入場 prefill 白紙になる。
// 本 const は publish 経路 (ensureSystemHiddenFields) が冪等 auto-push する予約 field の単一正本。
//   - type='hidden': spike F3=真の非表示 + alias 捕捉可 (invisible:true は F4=非表示化しないため使わない)。
//   - fr_id は identity 復元に必須 (ownerGated:false)。
//   - fr_name は氏名=PII (Google Sheets 帰属可読化 / codex#8) ゆえ owner-gate (ownerGated:true / env で切れる)。
// pull/drift は isFriendSystemAlias で除外し harness 定義への逆流・false-drift を防ぐ (R4)。
// =============================================================================

/** 予約 system hidden field の 1 定義 (単一正本 = worker push / pull 除外 / drift 除外 が参照)。 */
export interface FriendSystemFieldSpec {
  /** Formaloo field alias (hosted URL prefill の突合キー / 予約語)。 */
  readonly alias: string;
  /** Formaloo field title (respondent には非表示だが管理上の識別名)。 */
  readonly title: string;
  /** 真の非表示。spike F3/F9: type='hidden' が有効値・invisible:true は使わない。 */
  readonly type: 'hidden';
  /** 回答必須にしない (system 付与値ゆえ)。 */
  readonly required: false;
  /** 自動送信 logic より先に捕捉するため、常に form の先頭へ置く。 */
  readonly position: 0;
  /** owner-gate 対象か (fr_name=PII は true・env で auto-push を切れる / codex#8)。 */
  readonly ownerGated: boolean;
}

/** 予約 friend system field の単一正本 (fr_id=identity 必須 / fr_name=PII owner-gate)。 */
export const FRIEND_SYSTEM_FIELDS: readonly FriendSystemFieldSpec[] = [
  { alias: 'fr_id', title: 'LINE friend id (system)', type: 'hidden', required: false, position: 0, ownerGated: false },
  { alias: 'fr_name', title: 'LINE friend name (system)', type: 'hidden', required: false, position: 0, ownerGated: true },
] as const;

/**
 * UTM 流入元を hosted URL prefill から回答 row へ受け渡す予約 hidden field。
 * friend prefix の後ろへ additive に ensure し、公開導線ではこの exact 3 aliases 以外を転送しない。
 */
export const UTM_SYSTEM_FIELDS: readonly FriendSystemFieldSpec[] = [
  { alias: 'utm_source', title: 'UTM source (system)', type: 'hidden', required: false, position: 0, ownerGated: false },
  { alias: 'utm_medium', title: 'UTM medium (system)', type: 'hidden', required: false, position: 0, ownerGated: false },
  { alias: 'utm_campaign', title: 'UTM campaign (system)', type: 'hidden', required: false, position: 0, ownerGated: false },
] as const;

/** 予約 alias 集合 (生 'fr_id'/'fr_name' のハードコピーを push/pull/drift 経路に散らさない単一正本)。 */
export const FRIEND_SYSTEM_ALIASES: readonly string[] = FRIEND_SYSTEM_FIELDS.map((f) => f.alias);

/** UTM prefill 用の予約 alias。公開 route の転送 allowlist と同じ exact 3 keys。 */
export const UTM_SYSTEM_ALIASES: readonly string[] = UTM_SYSTEM_FIELDS.map((f) => f.alias);

/** alias が friend system field の予約 alias か (pull 除外 / drift 除外 / admin 露出除外 の共通判定)。 */
export function isFriendSystemAlias(alias: unknown): boolean {
  return typeof alias === 'string' && FRIEND_SYSTEM_ALIASES.includes(alias);
}

/** alias が UTM system field の予約 alias か。 */
export function isUtmSystemAlias(alias: unknown): boolean {
  return typeof alias === 'string' && UTM_SYSTEM_ALIASES.includes(alias);
}

/**
 * harness 定義/pull/fingerprint から除外する managed field か。
 * friend aliases は既存契約どおり alias-only、UTM は既存の可視回答 field を壊さないよう hidden 型だけを予約する。
 */
export function isSystemHiddenField(field: unknown): boolean {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
  const value = field as { alias?: unknown; type?: unknown };
  return isFriendSystemAlias(value.alias) || (value.type === 'hidden' && isUtmSystemAlias(value.alias));
}

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
  // treasure-b1-palette: rating/signature は同名。video は装飾だが Formaloo type=oembed (meta ではない = explicit)。
  rating: 'rating',
  signature: 'signature',
  variable: 'variable',
  choice_fetch: 'choice_fetch',
  section: 'meta',
  page_break: 'meta',
  video: 'oembed',
  // form-image-decoration: 差し込み画像は section と同じ meta。逆引きは fromFormalooField で
  //   description(canonical <img>)の有無により meta→image / meta→section を explicit 分岐する。
  image: 'meta',
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
  /**
   * file: 最大アップロードサイズ (Formaloo `max_size` / KB 単位・form-media-limits ①)。
   * 既定 2048(=2MB) は「未設定」扱い: pull/push/fingerprint で 2048 を落とし既存フォームの byte 不変を保つ
   * (後方互換の要 / RK-1)。validate で [256,102400]KB にクランプ (spike 実測 API 受理上限 102400KB=100MB)。
   */
  maxSizeKb?: number;
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
  /**
   * rating (Formaloo sub_type) の評価スタイル (treasure-b1-palette)。既定 star は「未設定」扱いで
   * push/pull/fingerprint から drop (既存フォーム byte 不変ガード = maxSizeKb=2048 と同型)。UI は star を undefined に写像。
   */
  ratingSubType?: RatingSubType;
  /**
   * video (Formaloo oembed) の埋め込み URL (YouTube/Vimeo 等 / treasure-b1-palette)。
   * 空/未設定は保存 hold (validate reject) — 空 url の oembed PATCH は 500 になるため常に非空を push (spike 実測)。
   */
  videoUrl?: string;
  /**
   * b1-field-polish: video(oembed) の表示高さ (CSS 長さ・例 "350px")。既定 (DEFAULT_VIDEO_HEIGHT) と一致 or
   * 未設定は「未設定」扱いで pull/fingerprint から drop (既存 video の byte 不変ガード = maxSizeKb=2048 と同型)。
   * push は videoHeight ?? DEFAULT を config.height として url と常時同送する (薄帯拡大)。validate は px|vw whitelist。
   */
  videoHeight?: string;
  /**
   * form-image-decoration: 差し込み画像の hosted URL (harness R2 / http(s) のみ)。push で canonical <img> の
   * src になる。空/未設定は imageUpload 解決待ち (worker が R2 upload → imageUrl 確定 → push)。
   */
  imageUrl?: string;
  /** 差し込み画像の代替テキスト (alt)。canonical <img> の alt に escape して載る。 */
  imageAlt?: string;
  /**
   * 差し込み画像の表示幅プリセット (small=40%/medium=70%/full=100% / owner ②)。canonical <img> の
   * max-width % に射影 = 表示領域制御そのもの。render に効くため fingerprint 射影に含める (video height と逆扱い)。
   */
  imageWidth?: ImageWidth;
  /**
   * 差し込み画像の upload intent (file→dataURL・10MB / form-design の FormDesignImageUpload を再利用)。
   * harness 側 intent = Formaloo payload には載せない。worker が R2 へ upload し imageUrl を確定してから push。
   */
  imageUpload?: FormDesignImageUpload;
  /** variable の必須 sub_type (Formaloo 実測 enum)。 */
  variableSubType?: VariableSubType;
  /** variable/formula の式。harness 内では `{fieldId}`、push 時だけ `{FormalooSlug}` へ解決する。 */
  formula?: string;
  /** variable/formula の小数桁数 (Formaloo decimal_places)。 */
  decimalPlaces?: number;
  /** choice_fetch の公開 GET URL (Formaloo choices_source)。 */
  choicesSource?: string;
  /** harness 管理リストの id。Formaloo payload には送らない。 */
  choiceListId?: string;
  /** builder preview 用の最新リスト値 snapshot。Formaloo payload/fingerprint には送らない。 */
  choiceFetchItems?: ChoiceFetchItem[];
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
 * 'submit' = ルートをここで閉じて送信する早期送信 (route-terminal-submit / S-1)。target 空=既定完了ページ /
 *            target=success-page field=ルート専用完了ページ (jump_to_success_page + submit ペア)。
 */
export type LogicAction = 'show' | 'hide' | 'jump' | 'skip' | 'submit';
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
  // ── route-terminal-submit (S-1) additive optional (submit rule のみ populate) ──
  /**
   * submit rule の発火条件 canonical 表現 (route-terminal-submit / S-1)。単一値 `'on_answered'` のみ。
   * `'on_reach'`(=always) は封印 (サイレントデータ損失毒 / spike §3) = 型に載せない。
   * submit rule の operator/value/targetFieldId(空時) は canonical placeholder 固定で logicFingerprint 安定。
   * 非 submit rule には付かない = 後方互換 byte 不変 (S-3)。
   */
  terminalTrigger?: 'on_answered';
  /**
   * submit host field の元 required 値 (submit 追加で自動 required 化する前の値 / S-1 案A)。
   * submit rule 削除時の required 復元に使う (元 false→false / 元 true→true)。builder のみ populate。
   */
  terminalHostWasRequired?: boolean;
}

export interface HarnessFormDefinition {
  fields: HarnessField[];
  logic: HarnessLogicRule[];
  /** フォーム単位の運用制御。既定値のみの時は省略して既存 definition byte を保つ。 */
  operationsSettings?: FormOperationsSettings;
  /**
   * フォーム表示形式 (form-route-branching R2 / additive optional)。design と同じく値があるときだけ persist。
   * 未設定フォームは definition_json に載らない = 後方互換 (byte 不変)。
   */
  formType?: FormDisplayType;
  /**
   * 公開ページ system 文言 (form-jp-localization / additive optional)。design/formType と同列。
   * 送信ボタン/完了/送信エラーの 3 文言のうち非空指定分だけ持つ。未設定フォームは definition_json に
   * 載らない = 後方互換 (byte 不変)。fingerprint 非関与 (cron drift 誤検知に入らない)。
   */
  formCopy?: FormCopy;
  /**
   * 送信後リダイレクト設定 (route-terminal-phase2 Track 1 / additive optional)。design/formCopy と同列。
   * url(https のみ)+ openExternalBrowser(LINE 外部起動)を非空指定時だけ持つ。未設定フォームは
   * definition_json に載らない = 後方互換 (byte 不変)。fingerprint 非関与 (form 直下 meta ゆえ cron drift
   * 誤検知に入らない = formCopy と同型)。
   */
  formRedirect?: FormRedirect;
  /**
   * ルート別完了ページ (route-terminal-phase2 Track 2 / Phase 2・OD-2 / additive optional)。
   * submit rule の targetFieldId が SuccessPageSpec.id を参照し、reconcile で採番された slug を永続する。
   * 未設定フォームは definition_json に載らない = 後方互換 (byte 不変)。SP 参照は logic bare array 内 =
   * fingerprint 関与 (slug 安定が前提・CI-3)。
   */
  successPages?: SuccessPageSpec[];
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

/** formula 内の `{fieldId}` 参照を出現順・重複なしで取り出す。 */
export function formulaReferenceIds(formula: string): string[] {
  const refs: string[] = [];
  for (const match of formula.matchAll(/\{([^{}]+)\}/g)) {
    const id = match[1]?.trim();
    if (id && !refs.includes(id)) refs.push(id);
  }
  return refs;
}

/** formula 参照だけを resolver で写像する。未解決参照は caller が検出できるよう原文保持する。 */
function mapFormulaReferences(formula: string, resolve?: (id: string) => string | undefined): string {
  if (!resolve) return formula;
  return formula.replace(/\{([^{}]+)\}/g, (whole, rawId: string) => {
    const id = rawId.trim();
    const mapped = id ? resolve(id) : undefined;
    return mapped ? `{${mapped}}` : whole;
  });
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
  if (rawCfg.maxSizeKb !== undefined) {
    // form-media-limits ①: 非 number/非有限は reject (M-21 未知プロパティ素通し禁止)。範囲外は clamp (owner 誤入力で
    // 保存を壊さない / reject でなく丸め)。下限 256KB・上限 102400KB (spike 実測 API 受理上限 100MB)。
    if (typeof rawCfg.maxSizeKb !== 'number' || !Number.isFinite(rawCfg.maxSizeKb)) return { ok: false, error: 'config.maxSizeKb must be a number' };
    config.maxSizeKb = Math.min(102400, Math.max(256, Math.round(rawCfg.maxSizeKb)));
  }
  if (rawCfg.text !== undefined) {
    if (typeof rawCfg.text !== 'string') return { ok: false, error: 'config.text must be string' };
    config.text = rawCfg.text;
  }
  if (rawCfg.description !== undefined) {
    if (typeof rawCfg.description !== 'string') return { ok: false, error: 'config.description must be string' };
    config.description = rawCfg.description;
  }
  // treasure-b1-palette: rating の sub_type は 5 enum whitelist で正規化 (M-21 未知素通し禁止)。
  //   未定義は既定 star 扱いで config に載せない (既存 form byte 不変 = maxSizeKb と同型)。
  if (rawCfg.ratingSubType !== undefined) {
    if (typeof rawCfg.ratingSubType !== 'string' || !(RATING_SUB_TYPES as readonly string[]).includes(rawCfg.ratingSubType)) {
      return { ok: false, error: `config.ratingSubType must be one of ${RATING_SUB_TYPES.join('/')}` };
    }
    config.ratingSubType = rawCfg.ratingSubType as RatingSubType;
  }
  // treasure-b1-palette: video の埋め込み URL は string 必須 (非 string reject)。値は下の video-url ガードで非空を強制。
  if (rawCfg.videoUrl !== undefined) {
    if (typeof rawCfg.videoUrl !== 'string') return { ok: false, error: 'config.videoUrl must be string' };
    config.videoUrl = rawCfg.videoUrl;
  }
  // b1-field-polish: video の表示高さは px|vw whitelist で正規化 (CSS 注入防止・自由文字列 reject / M-21)。
  //   未定義は許容 (push が既定高さを補完)。既存 videoUrl ガードは不変。
  if (rawCfg.videoHeight !== undefined) {
    if (typeof rawCfg.videoHeight !== 'string' || !VIDEO_HEIGHT_PATTERN.test(rawCfg.videoHeight)) {
      return { ok: false, error: 'config.videoHeight must match /^\\d{2,4}(px|vw)$/' };
    }
    config.videoHeight = rawCfg.videoHeight;
  }
  // form-image-decoration: 差し込み画像 config を whitelist 検証 (M-21 未知素通し禁止)。
  //   imageUrl は http(s) のみ (javascript:/data: 拒否 = R-4 XSS)。空は許容 (imageUpload 解決待ち)。
  if (rawCfg.imageUrl !== undefined) {
    if (typeof rawCfg.imageUrl !== 'string') return { ok: false, error: 'config.imageUrl must be string' };
    if (rawCfg.imageUrl && !isSafeImageUrl(rawCfg.imageUrl)) return { ok: false, error: '画像URLは http(s) のみ受理します' };
    config.imageUrl = rawCfg.imageUrl;
  }
  if (rawCfg.imageAlt !== undefined) {
    if (typeof rawCfg.imageAlt !== 'string') return { ok: false, error: 'config.imageAlt must be string' };
    config.imageAlt = rawCfg.imageAlt;
  }
  // imageWidth は small/medium/full enum whitelist (不正は reject / render に効く値ゆえ既定丸めでなく明示)。
  if (rawCfg.imageWidth !== undefined) {
    if (!isImageWidth(rawCfg.imageWidth)) return { ok: false, error: 'config.imageWidth must be small/medium/full' };
    config.imageWidth = rawCfg.imageWidth;
  }
  // imageUpload は form-design の validateImageUpload を再利用 (intent/10MB/MIME allowlist)。whitelist copy で載せる。
  if (rawCfg.imageUpload !== undefined) {
    const v = validateImageUpload(rawCfg.imageUpload);
    if (!v.ok) return { ok: false, error: v.reason ?? '画像が不正です' };
    const up = rawCfg.imageUpload as Record<string, unknown>;
    const copy: FormDesignImageUpload = { intent: up.intent as FormDesignImageUpload['intent'] };
    if (typeof up.dataUrl === 'string') copy.dataUrl = up.dataUrl;
    if (typeof up.mimeType === 'string') copy.mimeType = up.mimeType;
    if (typeof up.filename === 'string') copy.filename = up.filename;
    config.imageUpload = copy;
  }
  if (rawCfg.variableSubType !== undefined) {
    if (typeof rawCfg.variableSubType !== 'string' || !(VARIABLE_SUB_TYPES as readonly string[]).includes(rawCfg.variableSubType)) {
      return { ok: false, error: `config.variableSubType must be one of ${VARIABLE_SUB_TYPES.join('/')}` };
    }
    config.variableSubType = rawCfg.variableSubType as VariableSubType;
  }
  if (rawCfg.formula !== undefined) {
    if (typeof rawCfg.formula !== 'string') return { ok: false, error: 'config.formula must be string' };
    config.formula = rawCfg.formula;
  }
  if (rawCfg.decimalPlaces !== undefined) {
    if (typeof rawCfg.decimalPlaces !== 'number' || !Number.isInteger(rawCfg.decimalPlaces) || rawCfg.decimalPlaces < 0) {
      return { ok: false, error: 'config.decimalPlaces must be a non-negative integer' };
    }
    config.decimalPlaces = rawCfg.decimalPlaces;
  }
  if (rawCfg.choicesSource !== undefined) {
    if (typeof rawCfg.choicesSource !== 'string') return { ok: false, error: 'config.choicesSource must be string' };
    config.choicesSource = rawCfg.choicesSource.trim();
  }
  if (rawCfg.choiceListId !== undefined) {
    if (typeof rawCfg.choiceListId !== 'string') return { ok: false, error: 'config.choiceListId must be string' };
    config.choiceListId = rawCfg.choiceListId;
  }
  if (rawCfg.choiceFetchItems !== undefined) {
    const items = rawCfg.choiceFetchItems;
    if (!Array.isArray(items) || !items.every((item) => (
      item !== null
      && typeof item === 'object'
      && typeof (item as Record<string, unknown>).label === 'string'
      && typeof (item as Record<string, unknown>).value === 'string'
    ))) {
      return { ok: false, error: 'config.choiceFetchItems must be {label,value}[]' };
    }
    config.choiceFetchItems = (items as ChoiceFetchItem[]).map((item) => ({ label: item.label, value: item.value }));
  }
  // treasure-b1-palette: video (oembed) は url 必須 = 空/未設定は保存 hold (reject)。
  //   空 url の oembed PATCH は 500 になるため、空 url を push 経路へ通さない (spike 実測 / honest surface)。
  if (o.type === 'video' && !config.videoUrl) {
    return { ok: false, error: '動画の埋め込みURLを入力してください（YouTube/Vimeo 等）' };
  }
  if (o.type === 'variable') {
    if (!config.variableSubType) return { ok: false, error: '計算の種類を選んでください' };
    if (config.variableSubType === 'formula' && !config.formula?.trim()) {
      return { ok: false, error: '計算式を入力してください' };
    }
  }
  if (o.type === 'choice_fetch' && (!config.choicesSource || !isSafeImageUrl(config.choicesSource))) {
    return { ok: false, error: '動的選択肢の公開URLを選んでください' };
  }

  return {
    ok: true,
    field: {
      id: o.id,
      type: o.type,
      label: o.label,
      required: isDecorationType(o.type) || o.type === 'variable' ? false : o.required === true,
      position: typeof o.position === 'number' ? o.position : 0,
      config,
    },
  };
}

/** harness field → Formaloo field POST payload (未知プロパティを持たない明示形 / M-8)。 */
export function toFormalooFieldPayload(
  field: HarnessField,
  resolveSlug?: (harnessFieldId: string) => string | undefined,
): Record<string, unknown> {
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
  // treasure-b1-palette: video は装飾だが Formaloo type=oembed (meta ではない = explicit 分岐)。
  //   url は常に emit する (無いと oembed PATCH=500・spike 実測)。validate が空 url を保存 hold で弾く。
  //   b1-field-polish: config.height を url と常時同送 (videoHeight 未設定は既定を補完 = 薄帯拡大 / OD-3・OD-4)。
  //   config 単独 PATCH は 500 ゆえ url と同じ payload に載せる (spike 実測)。
  if (field.type === 'video') {
    return {
      type: 'oembed',
      title: field.label,
      url: field.config.videoUrl ?? '',
      position: field.position,
      config: { height: field.config.videoHeight ?? DEFAULT_VIDEO_HEIGHT },
    };
  }
  // form-image-decoration: 差し込み画像は meta/section で description=canonical <img> (spike S-1/T-C3 実証)。
  //   imageUpload (harness 側 intent) は payload に載せない。imageUrl 空は build が '' を返す (worker が R2 解決後 push)。
  if (field.type === 'image') {
    return {
      type: 'meta',
      sub_type: 'section',
      title: field.label,
      description: buildImageDescriptionHtml(field.config.imageUrl ?? '', field.config.imageAlt ?? '', field.config.imageWidth ?? 'medium'),
      position: field.position,
    };
  }
  if (field.type === 'variable') {
    const subType = field.config.variableSubType!;
    const payload: Record<string, unknown> = {
      type: 'variable',
      title: field.label,
      position: field.position,
      sub_type: subType,
      config: subType === 'formula'
        ? { formula: mapFormulaReferences(field.config.formula ?? '', resolveSlug) }
        : {},
    };
    if (field.config.decimalPlaces !== undefined) payload.decimal_places = field.config.decimalPlaces;
    return payload;
  }
  if (field.type === 'choice_fetch') {
    const payload: Record<string, unknown> = {
      type: 'choice_fetch',
      title: field.label,
      required: field.required,
      position: field.position,
      choices_source: field.config.choicesSource ?? '',
    };
    if (field.config.description !== undefined) payload.description = field.config.description;
    return payload;
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
  // form-media-limits ①: max_size は設定時のみ送る (未設定は既存 push byte 不変 / idempotent-push 整合 = RK-2)。
  if (c.maxSizeKb !== undefined) p.max_size = c.maxSizeKb;
  // treasure-b1-palette: rating の sub_type は設定時のみ送る (未設定=既定 star ゆえ送らない = 後方互換ガード)。signature は追加なし。
  if (c.ratingSubType !== undefined) p.sub_type = c.ratingSubType;
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
      const desc = typeof o.description === 'string' ? o.description : '';
      // form-image-decoration: description が canonical <img> なら差し込み画像 field へ (parse 済み値射影)。
      //   散文 section は従来どおり section (image に誤分類しない = 後方互換)。
      const parsedImg = parseImageDescription(desc);
      if (parsedImg) {
        return {
          id,
          type: 'image',
          label: typeof o.title === 'string' ? o.title : '',
          required: false,
          position: typeof o.position === 'number' ? o.position : 0,
          config: { imageUrl: parsedImg.url, imageAlt: parsedImg.alt, imageWidth: parsedImg.width },
        };
      }
      return {
        id,
        type: 'section',
        label: typeof o.title === 'string' ? o.title : '',
        required: false,
        position: typeof o.position === 'number' ? o.position : 0,
        config: { text: desc },
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

  // treasure-b1-palette: oembed(video) は装飾ゆえ FORMALOO_TO_HARNESS_TYPE 逆引きに載らない → meta と同様 explicit 分岐。
  if (formalooType === 'oembed') {
    const videoConfig: HarnessFieldConfig = { videoUrl: typeof o.url === 'string' ? o.url : '' };
    // b1-field-polish: config.height を pull。既定値 (DEFAULT_VIDEO_HEIGHT) と未載は set しない
    //   (既存 video の byte 不変ガード = maxSizeKb=2048 と同型・非既定のみ videoHeight に載せる)。
    const rawHeight = (o.config && typeof o.config === 'object' ? (o.config as Record<string, unknown>).height : undefined);
    if (typeof rawHeight === 'string' && rawHeight && rawHeight !== DEFAULT_VIDEO_HEIGHT) videoConfig.videoHeight = rawHeight;
    return {
      id,
      type: 'video',
      label: typeof o.title === 'string' ? o.title : '',
      required: false,
      position: typeof o.position === 'number' ? o.position : 0,
      config: videoConfig,
    };
  }

  if (formalooType === 'variable') {
    const subType = typeof o.sub_type === 'string' && (VARIABLE_SUB_TYPES as readonly string[]).includes(o.sub_type)
      ? o.sub_type as VariableSubType
      : null;
    if (!subType) return null;
    const variableConfig: HarnessFieldConfig = { variableSubType: subType };
    const rawConfig = o.config && typeof o.config === 'object' && !Array.isArray(o.config)
      ? o.config as Record<string, unknown>
      : {};
    if (subType === 'formula' && typeof rawConfig.formula === 'string') {
      variableConfig.formula = mapFormulaReferences(rawConfig.formula, resolveId);
    }
    if (typeof o.decimal_places === 'number' && Number.isInteger(o.decimal_places) && o.decimal_places >= 0) {
      variableConfig.decimalPlaces = o.decimal_places;
    }
    return {
      id,
      type: 'variable',
      label: typeof o.title === 'string' ? o.title : '',
      required: false,
      position: typeof o.position === 'number' ? o.position : 0,
      config: variableConfig,
    };
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
  // form-media-limits ①: max_size を pull。既定 2048(=2MB) と未載は set しない (既存フォーム pull 不変 = 後方互換ガード / RK-1)。
  if (typeof o.max_size === 'number' && Number.isFinite(o.max_size) && o.max_size !== 2048) config.maxSizeKb = o.max_size;
  // treasure-b1-palette: rating の sub_type を pull。既定 star は drop (既存 form 不変ガード = maxSizeKb=2048 と同型)。
  if (type === 'rating' && typeof o.sub_type === 'string' && o.sub_type !== 'star') config.ratingSubType = o.sub_type as RatingSubType;
  if (type === 'choice_fetch') {
    if (typeof o.choices_source !== 'string' || !o.choices_source) return null;
    config.choicesSource = o.choices_source;
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
 * submit rule の発火条件 raw `when` を決定的に生成 (route-terminal-submit / S-1 実測正形)。
 * host item identifier = when の field value = **同一末尾 field slug** (自己参照)。
 * spike §1: `{"operation":"is_answered","args":[{"type":"field","value":"<host slug>"}]}` のみ hosted 発火。
 */
export function generateSubmitWhen(hostSlug: string): { operation: 'is_answered'; args: { type: 'field'; value: string }[] } {
  return { operation: 'is_answered', args: [{ type: 'field', value: hostSlug }] };
}

/**
 * harness logic rules → Formaloo R0 bare-array logic (edited-push の是正生成形)。
 * field は harness id → Formaloo slug に解決。resolveSlug が undefined を返す rule は捨てる (孤立参照防止)。
 * fieldById (任意) を渡すと source field の型を見て choice/constant のオペランド型を判定する (choice_slug 発火)。
 * action: show/hide/jump はそのまま・レガシー 'skip' → Formaloo 'jump' に動詞変換。
 * route-terminal-submit (S-1): action='submit' は host 自己参照 is_answered when + args:[] (target 空でも drop しない)。
 *   success-page target 有りは `jump_to_success_page`(identifier=SP slug)+`submit` のペアを同一 when で生成。
 *   同一 source に jump と submit が混在したら total order = **通常 jump → jump_to_success_page → submit** (spike §2c 逆順禁止)。
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
  // jump 系 (通常 jump / skip→jump) と submit 系を分離集積し、item 出力時に total order で連結する
  // (S-1 §2c: hosted は actions 順序どおり実行 = jump_to_success_page → submit の正順のみ SP 着地)。
  const jumpActionsBySrc = new Map<string, unknown[]>();
  const submitActionsBySrc = new Map<string, unknown[]>();
  const ensureOrder = (srcSlug: string) => {
    if (!jumpActionsBySrc.has(srcSlug)) {
      jumpActionsBySrc.set(srcSlug, []);
      submitActionsBySrc.set(srcSlug, []);
      order.push(srcSlug);
    }
  };
  for (const r of rules) {
    const srcSlug = resolveSlug(r.sourceFieldId);
    if (!srcSlug) continue; // source 未解決 (未 push field 等) は送らない
    if (r.action === 'submit') {
      // submit rule: host 自己参照 is_answered when。target 空でも drop しない (args:[] 単独)。
      const when = generateSubmitWhen(srcSlug);
      const spSlug = r.targetFieldId ? resolveSlug(r.targetFieldId) : undefined;
      ensureOrder(srcSlug);
      const bucket = submitActionsBySrc.get(srcSlug)!;
      // success-page 併用時のみ jump_to_success_page を submit の前に積む (R-c: page 着地 → submit)。
      if (spSlug) bucket.push({ action: 'jump_to_success_page', args: [{ type: 'field', identifier: spSlug }], when });
      bucket.push({ action: 'submit', args: [], when });
      continue;
    }
    const tgtSlug = resolveSlug(r.targetFieldId);
    if (!tgtSlug) continue; // 非 submit は target 必須 (孤立参照は送らない)
    const verb: FormalooActionVerb = r.action === 'skip' ? 'jump' : r.action; // レガシー skip→jump 動詞変換
    const operation: FormalooConditionOperator = r.operator === 'not_equals' ? 'is_not' : 'is';
    const valueOperand = resolveWhenValueOperand(r, fieldById?.(r.sourceFieldId));
    const action = {
      action: verb,
      args: [{ type: 'field', identifier: tgtSlug }],
      when: { operation, args: [{ type: 'field', value: srcSlug }, valueOperand] },
    };
    ensureOrder(srcSlug);
    jumpActionsBySrc.get(srcSlug)!.push(action);
  }
  return order.map((srcSlug) => ({
    type: 'field',
    identifier: srcSlug,
    // total order: 通常 jump → (jump_to_success_page → submit)。pure-jump は submit 空 = 従来と byte 一致。
    actions: [...jumpActionsBySrc.get(srcSlug)!, ...submitActionsBySrc.get(srcSlug)!],
  }));
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
  // route-terminal-submit (T-A4): terminal-expandable (submit / 隣接ペア) も弱化除外 (第一級展開で欠けゼロ)。
  //   standalone jump_to_success_page / always(on_reach) submit は isExpandableTerminalItem=false = 従来どおり計数。
  if (Array.isArray(obj)) return obj.filter((it) => isCompoundRawLogicItem(it) && !isExpandableMultiJumpItem(it) && !isExpandableTerminalItem(it)).length;
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
 * route-terminal-submit (S-1): submit を含む terminal item を flat rule 群へ逐語展開できるか。
 * `isExpandableMultiJumpItem` は無改変 (pure-jump byte-identity 回帰死守)。本述語は submit-bearing item 専用:
 *  - submit または jump_to_success_page を **含む** (pure-jump は multi-jump 経路へ委譲 = ここでは false)
 *  - 全 action が route/terminal verb (jump / jump_to_success_page / submit) で単一 leaf when
 *  - jump / jump_to_success_page: operator is/is_not / submit: operator is_answered (**always=on_reach は封印 = false**)
 *  - 各 jump_to_success_page は直後に同一 when の submit と隣接ペア (単独 jsp = no-op = 非展開 = false / S-1 §2c/d)
 * 非該当 (standalone jsp / always submit / 未モデル verb) は従来の弱化射影 + raw 保持へ落とす (データ損失毒の封印)。
 */
export function isExpandableTerminalItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const it = item as Record<string, unknown>;
  const rawActions = Array.isArray(it.actions) ? it.actions : [];
  if (rawActions.length === 0) return false;
  const hostSlug = typeof it.identifier === 'string' ? it.identifier : '';
  if (!hostSlug) return false; // host identifier 必須 (自己参照 when の照合基準)
  const verbs = rawActions.map((a) => (a && typeof a === 'object' ? (a as Record<string, unknown>).action : undefined));
  // terminal item = submit または jump_to_success_page を含む (pure-jump は isExpandableMultiJumpItem へ委譲)
  if (!verbs.some((v) => v === 'submit' || v === 'jump_to_success_page')) return false;

  // F-HIGH-2 厳密検証: submit は host 自己参照 is_answered ∧ args 空 / jsp は自己参照 is_answered ∧ target identifier 必須。
  //   terminal(jsp/submit) の後に jump は不可 (total order 通常jump→jsp→submit)。各 jsp は直後 submit と隣接ペア(when 一致)。
  const isSelfRefIsAnswered = (when: unknown): boolean => {
    if (!when || typeof when !== 'object') return false;
    const w = when as Record<string, unknown>;
    if (w.operation !== 'is_answered') return false;
    const args = Array.isArray(w.args) ? w.args : [];
    if (args.length !== 1) return false; // is_answered は field operand 1 個のみ
    const o = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
    return o.type === 'field' && o.value === hostSlug; // 自己参照 (host)
  };
  const targetIdentifier = (a: Record<string, unknown>): string => {
    const args = Array.isArray(a.args) ? a.args : [];
    const tgt = args.map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})).find((x) => typeof x.identifier === 'string');
    return typeof tgt?.identifier === 'string' ? (tgt.identifier as string) : '';
  };

  let terminalSeen = false;
  for (let i = 0; i < rawActions.length; i++) {
    const ao = (rawActions[i] && typeof rawActions[i] === 'object' ? rawActions[i] : {}) as Record<string, unknown>;
    const verb = ao.action;
    if (verb === 'jump') {
      if (terminalSeen) return false; // jump は terminal より前 (total order 違反)
      const flat = flattenRawWhen(ao.when, (s) => s);
      if (flat.join || flat.conditions.length !== 1) return false;
      const op = flat.conditions[0].operator;
      if (op !== 'is' && op !== 'is_not') return false;
    } else if (verb === 'jump_to_success_page') {
      terminalSeen = true;
      if (!isSelfRefIsAnswered(ao.when)) return false; // 自己参照 is_answered
      if (Array.isArray(ao.args) === false || !targetIdentifier(ao)) return false; // target identifier 必須
      // 隣接ペア: 直後は submit (同一 when)。
      const next = (rawActions[i + 1] && typeof rawActions[i + 1] === 'object' ? rawActions[i + 1] : {}) as Record<string, unknown>;
      if (next.action !== 'submit') return false; // 単独 jsp = no-op
      if (!semanticLogicEqual(ao.when, next.when)) return false;
      const nextArgs = Array.isArray(next.args) ? next.args : null;
      if (!nextArgs || nextArgs.length !== 0) return false; // submit args 空
      i += 1; // ペアの submit を消費
    } else if (verb === 'submit') {
      terminalSeen = true;
      if (!isSelfRefIsAnswered(ao.when)) return false; // 自己参照 is_answered (always/on_reach 封印)
      const args = Array.isArray(ao.args) ? ao.args : null;
      if (!args || args.length !== 0) return false; // submit args 空
    } else {
      return false; // 未モデル verb
    }
  }
  return true;
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

    // route-terminal-submit (S-1): submit を含む terminal item を第一級 submit rule / jump rule 群へ展開。
    //   jump → jump rule / jump_to_success_page+submit 隣接ペア → submit rule(target=SP) / 単独 submit → submit rule(target='')。
    //   isExpandableTerminalItem が pairing・封印 (always/standalone jsp) を保証済 = ここは逐語展開のみ。
    if (isExpandableTerminalItem(item)) {
      for (let ai = 0; ai < rawActions.length; ai++) {
        const ao = (rawActions[ai] && typeof rawActions[ai] === 'object' ? rawActions[ai] : {}) as Record<string, unknown>;
        const verb = ao.action;
        const flat = flattenRawWhen(ao.when, resolveFieldId);
        const c0 = flat.conditions[0];
        if (verb === 'jump') {
          const aArgs = Array.isArray(ao.args) ? ao.args : [];
          const tgt = aArgs.map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})).find((x) => typeof x.identifier === 'string');
          const tgtSlug = typeof tgt?.identifier === 'string' ? (tgt.identifier as string) : '';
          const targetFieldId = tgtSlug ? resolveFieldId(tgtSlug) ?? tgtSlug : '';
          if (!c0 || !c0.sourceFieldId || !targetFieldId) continue;
          n += 1;
          out.push({
            id: `r${n}`,
            sourceFieldId: c0.sourceFieldId,
            operator: c0.operator === 'is_not' || c0.operator === 'not_equals' ? 'not_equals' : 'equals',
            value: c0.value,
            action: 'jump',
            targetFieldId,
          });
        } else if (verb === 'jump_to_success_page') {
          // 隣接ペア: 次 action の submit と合わせて 1 submit rule(target=SP) にコラプス (isExpandableTerminalItem 保証済)。
          const aArgs = Array.isArray(ao.args) ? ao.args : [];
          const tgt = aArgs.map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})).find((x) => typeof x.identifier === 'string');
          const spSlug = typeof tgt?.identifier === 'string' ? (tgt.identifier as string) : '';
          const targetFieldId = spSlug ? resolveFieldId(spSlug) ?? spSlug : '';
          if (!c0 || !c0.sourceFieldId) { ai += 1; continue; } // ペアの submit を消費して skip
          n += 1;
          out.push({
            id: `r${n}`,
            sourceFieldId: c0.sourceFieldId,
            operator: 'equals',
            value: '',
            action: 'submit',
            targetFieldId,
            terminalTrigger: 'on_answered',
          });
          ai += 1; // ペアの submit を消費
        } else if (verb === 'submit') {
          // 単独 submit (ペア済み submit は上で ai++ 消費済) → target 空 rule (drop しない)。
          if (!c0 || !c0.sourceFieldId) continue;
          n += 1;
          out.push({
            id: `r${n}`,
            sourceFieldId: c0.sourceFieldId,
            operator: 'equals',
            value: '',
            action: 'submit',
            targetFieldId: '',
            terminalTrigger: 'on_answered',
          });
        }
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
    let cond0 = flat.conditions[0];
    const act0 = actionRefs[0];
    // route-terminal-submit: 弱化経路に落ちた submit (always/on_reach 封印 = target 空・when に field operand 無し)
    //   は drop せず raw 保持で surface。sourceFieldId は item identifier (host) から補完 (自己参照)。
    const submitWeakened = act0?.action === 'submit';
    if (submitWeakened && (!cond0 || !cond0.sourceFieldId)) {
      const itemHost = typeof it.identifier === 'string' ? it.identifier : '';
      const hostId = itemHost ? resolveFieldId(itemHost) ?? itemHost : '';
      cond0 = { sourceFieldId: hostId, operator: (cond0?.operator ?? 'is_answered') as HarnessLogicCondition['operator'], value: cond0?.value ?? '' };
    }
    if (!cond0 || !act0 || !cond0.sourceFieldId || (!act0.targetFieldId && !submitWeakened)) continue; // 弱化不能 / 孤立参照 → drop

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
          : act0.action === 'submit'
            ? 'submit'
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

// =============================================================================
// route-terminal-submit (S-1) — builder lint (誤解ゼロ原則)。builder と worker save が共用する純関数。
// ページ区間グラフ (page_break で分割) を組み、submit/jump/required の配置から 3 種の警告を算定する:
//   (a) なだれ込み〔UX〕: jump ルート末尾が閉じていない (submit も終端 jump も無い) → 次区間へ線形続行。
//       (S-1 §3: 未閉鎖ルート自体は全値保存で送信可能 = データ損失に格上げしない・UX 警告のまま)
//   (b) 送信不能: 恒常スキップされ得る区間の required → 飛ばした回答者が最後の Submit で「必須未入力」ブロック。
//   (d) データ損失: submit host がそのページ区間の最終 field でない → host より後の同ルート回答が silent 欠落 (S-1 §3)。
// 純 show/hide 運用フォーム (jump/submit なし) には 1 件も出さない (誤警告 0 = RK-4)。
// =============================================================================

/** ページ区間 = page_break で分割した入力 field の連なり (先頭 page_break は区間の開始マーカ)。 */
interface RouteSegment {
  /** この区間の開始 page_break field (先頭区間は null)。 */
  pageBreak: HarnessField | null;
  /** 区間内の入力 (非 decoration) field (position 昇順)。 */
  inputs: HarnessField[];
}

function buildRouteSegments(orderedFields: HarnessField[]): RouteSegment[] {
  const segments: RouteSegment[] = [{ pageBreak: null, inputs: [] }];
  for (const f of orderedFields) {
    if (f.type === 'page_break') {
      segments.push({ pageBreak: f, inputs: [] });
    } else if (!isDecorationType(f.type)) {
      segments[segments.length - 1].inputs.push(f);
    }
    // section (decoration・非 page_break) は区間を分割しない (入力でもない)。
  }
  return segments;
}

export function computeRouteTerminalWarnings(
  fields: HarnessField[],
  logic: HarnessLogicRule[],
  _formType?: FormDisplayType,
): string[] {
  const jumpRules = logic.filter((r) => r.action === 'jump');
  const submitRules = logic.filter((r) => r.action === 'submit');
  // 純 show/hide (jump も submit も無い) → 誤警告 0。
  if (jumpRules.length === 0 && submitRules.length === 0) return [];

  const ordered = [...fields].sort((a, b) => a.position - b.position);
  const byId = new Map(ordered.map((f) => [f.id, f]));
  const segments = buildRouteSegments(ordered);
  const lastSegmentIdx = segments.length - 1;
  const submitHostIds = new Set(submitRules.map((r) => r.sourceFieldId));
  const jumpTargetIds = new Set(jumpRules.map((r) => r.targetFieldId));
  const segmentOf = (fieldId: string): { seg: RouteSegment; idx: number } | undefined => {
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].inputs.some((f) => f.id === fieldId)) return { seg: segments[i], idx: i };
    }
    return undefined;
  };

  const warnings: string[] = [];
  const push = (msg: string) => { if (!warnings.includes(msg)) warnings.push(msg); };

  // (a) なだれ込み: jump 先の区間 (route) が最終区間でなく submit で閉じていない → 次区間へ流れ込む。
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.inputs.length === 0) continue;
    const isJumpTarget = seg.pageBreak != null && jumpTargetIds.has(seg.pageBreak.id);
    if (!isJumpTarget) continue;
    if (i >= lastSegmentIdx) continue; // 最終区間は通常 Submit で閉じる = なだれ込まない
    const lastInput = seg.inputs[seg.inputs.length - 1];
    if (submitHostIds.has(lastInput.id)) continue; // submit で閉じている
    push(`「${seg.pageBreak?.label || 'ページ'}」のルートが「ここで送信」で閉じられていません。公開フォームでは次の質問へ流れ込みます（なだれ込み）。ルート末尾に「ここで送信」を追加してください。`);
  }

  // (b) 送信不能: jump が飛び越える区間 (source と target の間) の required → **通常 Submit** がブロックされ得る。
  //   F-MED-3: 早期 submit (logic submit) は他ページ required を素通しする (R-f)。よって飛越先ルートが submit で
  //   閉じる (通常 Submit へ到達しない) 場合は required がブロックしない = 誤警告になる → 抑制する。
  //   飛越先 (jump target 区間) から末尾まで submit-close が無い = 通常 Submit へ到達する時のみ warn。
  const routeReachesNormalSubmit = (startSegIdx: number): boolean => {
    for (let i = startSegIdx; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.inputs.length === 0) continue;
      const last = seg.inputs[seg.inputs.length - 1];
      if (submitHostIds.has(last.id)) return false; // この区間で早期 submit → 通常 Submit へ到達しない
    }
    return true; // 末尾まで submit-close 無し = 通常 Submit へ到達
  };
  for (const jr of jumpRules) {
    const src = byId.get(jr.sourceFieldId);
    const tgt = byId.get(jr.targetFieldId);
    if (!src || !tgt) continue;
    // jump target 区間の index を特定 (target = page_break id)。
    const targetSegIdx = segments.findIndex((s) => s.pageBreak != null && s.pageBreak.id === jr.targetFieldId);
    if (targetSegIdx < 0) continue;
    if (!routeReachesNormalSubmit(targetSegIdx)) continue; // 飛越先が submit で閉じる = required ブロックなし (誤警告抑制)
    for (const f of ordered) {
      if (isDecorationType(f.type)) continue;
      if (f.position > src.position && f.position < tgt.position && f.required) {
        push(`「${f.label}」は必須ですが、条件分岐で飛ばされる可能性があります。飛ばした回答者は最後の送信で「必須未入力」になり送信できなくなります。`);
      }
    }
  }

  // (d) データ損失: submit host がそのページ区間の最終入力 field でない → host より後の同ルート回答が落ちる (S-1 §3)。
  for (const sr of submitRules) {
    const host = byId.get(sr.sourceFieldId);
    if (!host) continue;
    const found = segmentOf(host.id);
    if (!found || found.seg.inputs.length === 0) continue;
    const lastInput = found.seg.inputs[found.seg.inputs.length - 1];
    if (lastInput.id !== host.id) {
      push(`「${host.label}」で送信すると、同じページのこれより後ろの回答が保存されません（データ損失）。「ここで送信」は各ルートの最後の項目に置いてください。`);
    }
  }

  return warnings;
}
