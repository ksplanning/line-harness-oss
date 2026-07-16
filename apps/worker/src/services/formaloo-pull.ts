import {
  fromFormalooField,
  fromFormalooLogic,
  fromFormalooRawLogic,
  isExpandableMultiJumpItem,
  isExpandableTerminalItem,
  countWeakenedFormalooRules,
  logicFingerprint,
  formalooColorToHex,
  normalizeFormDesign,
  FORM_DESIGN_COLOR_KEYS,
  FORM_DESIGN_TO_FORMALOO,
  type HarnessField,
  type HarnessLogicRule,
  type FormalooLogicObject,
  type FormDesign,
  type FormDisplayType,
} from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client';

// =============================================================================
// Formaloo pull (N-8 / formaloo-pull-wiring) — Formaloo → harness 定義 再取り込み。
// -----------------------------------------------------------------------------
// SoT (§4): Formaloo = 定義の権威。運用者が Formaloo 管理画面で直接編集したフォームを
//   harness builder に読み戻す (push の逆方向)。shared の fromFormalooField / fromFormalooLogic
//   (round-trip 変換・実装済/無改変) を builder pull 経路に結線する薄い層。
// 非破壊: D1 は書き換えない (setFormalooSyncState / saveFormalooDefinition は呼ばない)。
//   再取り込みは builder エディタ state への反映のみ。永続化は運用者が既存 PUT で「保存」。
// fail-soft (N-6): read endpoint / JSON パスは live 未確定 → 候補キーを許容的に拾い、
//   どの段の失敗も {ok:false} で返す (throw しない)。誤 JSON パスの silent 空定義は W1 で {ok:false}。
// =============================================================================

/**
 * pull 結果 (discriminated union)。`ok` は「builder editor に適用してよいか」の判別子。
 * frontend は ok===true の時だけ state を置換し、ok:false は note のみ表示する (B2 = editor を空へ潰さない)。
 */
export type PullResult =
  | {
      ok: true;
      fields: HarnessField[];
      logic: HarnessLogicRule[];
      warnings?: string[];
      /**
       * R0 実測: Formaloo GET `.data.form.logic` の bare array 逐語 (preserve-raw の格納素材)。
       * 未編集保存時にこの配列を PATCH で verbatim 再送し複合/calc/variable/jump を欠けなく保持する。
       * bare array でない (null 等) 時は未載 (preserve 不成立 = 従来経路)。
       */
      rawLogic?: unknown;
      /** 射影 logic の canonical fingerprint (save 時に受領 logic と突合して「未編集」判定 / R7)。 */
      logicFingerprint?: string;
      /**
       * form-design (Batch D): Formaloo 側の色/画像 (テーマ) を harness canonical へ復元したもの。
       * pull route が builder の initialDesign へ、drift auto-apply が definition_json へ carry する。
       * 色は formalooColorToHex で多相吸収 (JSON-string RGBA / hex 両対応)。design が無いフォームは空 {}。
       */
      design?: FormDesign;
      /**
       * form-route-branching (R2): Formaloo `form_type` を harness canonical へ復元 (spike T-A0: simple|multi_step)。
       * design と同じく builder の initialFormType へ、drift auto-apply が definition_json へ carry。
       * 未知/欠落は undefined = 従来と byte 一致 (後方互換)。
       */
      formType?: FormDisplayType;
      /**
       * 各 harness field id → 元の Formaloo field slug (drift auto-apply の field_map slug carry 用 / T-B3)。
       * auto-apply が saveFormalooDefinition へ渡す field_map の formaloo_field_slug を `existingMap[id] ?? fieldSlugById[id]`
       * で埋めることで slug wipe → 次回手動保存 push の重複作成 (idempotency B3 回帰) を防ぐ。route は無視 (後方互換)。
       */
      fieldSlugById?: Record<string, string>;
    }
  | { ok: false; error: string };

/**
 * form-detail JSON body から fields 配列を許容的に抽出 (Rk1 / read endpoint の JSON パス live 未確定)。
 * 候補パスを順に試し、最初に見つかった配列を返す。どの候補も配列でなければ null (= read-shape 不一致 / W1)。
 * 明示的な空配列 [] は「正当な空フォーム」として返す (誤パスの silent 空定義と区別)。
 */
export function extractFieldsList(root: unknown): unknown[] | null {
  const r = (root ?? {}) as Record<string, any>;
  const candidates: unknown[] = [
    r?.data?.form?.fields_list,
    r?.data?.fields_list,
    r?.form?.fields_list,
    r?.fields_list,
    r?.data?.form?.fields,
    r?.data?.fields,
    r?.form?.fields,
    r?.fields,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as unknown[];
  }
  return null;
}

/**
 * form-detail JSON body から logic object ({ rules:[...] } 形) を許容的に抽出。
 * rules 配列を持つ object のみ採用し、無ければ空 { rules:[] } (fromFormalooLogic が安全に空を返す)。
 */
export function extractLogic(root: unknown): FormalooLogicObject {
  const r = (root ?? {}) as Record<string, any>;
  const candidates: unknown[] = [r?.data?.form?.logic, r?.data?.logic, r?.form?.logic, r?.logic];
  for (const c of candidates) {
    if (c && typeof c === 'object' && Array.isArray((c as { rules?: unknown }).rules)) {
      return c as FormalooLogicObject;
    }
  }
  return { rules: [] };
}

/**
 * R0 実測: 実 Formaloo logic は `.data.form.logic` の **bare array** (`{rules}` object ではない)。
 * preserve-raw 用に生配列を逐語抽出する (extractLogic は legacy synthetic `{rules}` 用で無改変)。
 * 候補パスを順に試し、最初に見つかった **配列** を返す。配列でなければ null (= preserve 対象外 / null logic)。
 */
export function extractRawLogic(root: unknown): unknown[] | null {
  const r = (root ?? {}) as Record<string, any>;
  const candidates: unknown[] = [r?.data?.form?.logic, r?.data?.logic, r?.form?.logic, r?.logic];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as unknown[];
  }
  return null;
}

/**
 * form-detail JSON body から Formaloo form object を許容的に取り出す (read endpoint の shape 揺れ吸収)。
 * design 系 key (theme_color / logo / background_image) か fields_list を持つ候補を優先する。
 */
function extractFormObject(root: unknown): Record<string, unknown> {
  const r = (root ?? {}) as Record<string, any>;
  const candidates = [r?.data?.form, r?.data, r?.form, r];
  for (const c of candidates) {
    if (c && typeof c === 'object' && !Array.isArray(c) &&
      ('theme_color' in c || 'logo' in c || 'background_image' in c || 'fields_list' in c)) {
      return c as Record<string, unknown>;
    }
  }
  const first = candidates.find((c) => c && typeof c === 'object' && !Array.isArray(c));
  return (first ?? {}) as Record<string, unknown>;
}

/** 最初に見つかった http(s) 文字列を返す (S3 URL 等)。無ければ undefined。 */
function firstHttpUrl(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  return undefined;
}

/**
 * Formaloo GET body から form-design (色/画像テーマ) を harness canonical FormDesign へ復元する (T-B/OFF-LANE)。
 *  - 色: `theme_color` 等 7 フィールドを formalooColorToHex で多相吸収 (fresh=JSON-string RGBA / hex 両対応)。
 *  - logo: `logo`(S3 URL) 優先・`logo_url` fallback。カバー(ヘッダー背景) = `background_image`‖`background_image_url`。
 *  - normalizeFormDesign で whitelist / http(s) URL 検証 / 不正値 drop (design 無しフォームは空 {})。
 */
export function extractDesign(root: unknown): FormDesign {
  const f = extractFormObject(root);
  const raw: Record<string, unknown> = {};
  for (const key of FORM_DESIGN_COLOR_KEYS) {
    const hex = formalooColorToHex(f[FORM_DESIGN_TO_FORMALOO[key]] as never);
    if (hex !== null) raw[key] = hex;
  }
  if (typeof f.theme_name === 'string' && f.theme_name) raw.themeName = f.theme_name;
  const logoUrl = firstHttpUrl(f.logo, f.logo_url);
  if (logoUrl) raw.logoUrl = logoUrl;
  const bgUrl = firstHttpUrl(f.background_image, f.background_image_url);
  if (bgUrl) raw.backgroundImageUrl = bgUrl;
  const coverUrl = firstHttpUrl(f.cover_image_url);
  if (coverUrl) raw.coverImageUrl = coverUrl;
  return normalizeFormDesign(raw);
}

/**
 * Formaloo GET body から `form_type` を harness FormDisplayType へ復元 (form-route-branching R2)。
 * spike T-A0 実測: top-level `form_type` は 'simple'|'multi_step' の 2 値のみ。未知/欠落は undefined
 * (= 従来と byte 一致 / 後方互換 = drift 誤検知しない)。
 */
export function extractFormType(root: unknown): FormDisplayType | undefined {
  const f = extractFormObject(root);
  const v = f.form_type;
  return v === 'simple' || v === 'multi_step' ? v : undefined;
}

/**
 * 既に GET 済みの form-detail body (res.data) を harness 定義へ変換 (GET を含まない純粋変換)。
 * pull route (下記 pullDefinitionFromFormaloo) と drift-check の auto-apply が同一 body から再利用する
 * (drift-check は fingerprint 用に 1 回だけ GET し、その body を本関数へ渡す = 二重 GET 回避)。
 *  - fields: fromFormalooField (非 subset は null で drop / M-21) → 空/欠落 id を drop (W3)
 *            → Formaloo position 昇順に安定ソート (W2)。fieldSlugById (id→Formaloo slug) を併走構築 (T-B3)。
 *  - logic: fromFormalooLogic → 変換済 field-id 集合に無い rule を除去 (孤立防止 / B5)。
 *  - read-shape 不一致は {ok:false} (W1)。
 */
export function buildPullResult(
  body: unknown,
  resolveId: (formalooFieldSlug: string) => string | undefined,
): PullResult {
  const fieldsArr = extractFieldsList(body);
  if (fieldsArr === null) return { ok: false, error: 'read shape mismatch: fields_list not found' };

  // raw 要素と harness field を対にして持ち、fields (順序付き) と fieldSlugById を同時に組む (T-B3)。
  const paired = fieldsArr
    .map((el) => {
      const field = fromFormalooField(el, resolveId);
      const slug = el && typeof el === 'object' && typeof (el as { slug?: unknown }).slug === 'string'
        ? ((el as { slug: string }).slug)
        : '';
      return { field, slug };
    })
    .filter((x): x is { field: HarnessField; slug: string } => x.field !== null)
    .filter((x) => typeof x.field.id === 'string' && x.field.id !== '') // W3: 空/欠落 id は drop
    .sort((a, b) => a.field.position - b.field.position); // W2: Formaloo position 昇順に安定ソート

  const fields = paired.map((x) => x.field);
  const fieldSlugById: Record<string, string> = {};
  for (const x of paired) if (x.slug) fieldSlugById[x.field.id] = x.slug;

  const logicObj = extractLogic(body);
  // R0 実測: 実 logic は bare array。preserve-raw 用に逐語抽出 (legacy synthetic `{rules}` 形は null)。
  const rawLogic = extractRawLogic(body);
  const idSet = new Set(fields.map((f) => f.id));
  // B5 action-aware filter (孤立参照を editor に入れない)。route-terminal-submit (T-C4): submit rule は
  //   target 空 (既定完了ページ) を drop しない。F-MED-2: Phase1 は SP 未対応ゆえ submit target を '' へ正規化
  //   (下段 map) してから B5 = submit は常に target='' で通過。
  const b5Keep = (r: HarnessLogicRule): boolean => {
    if (!idSet.has(r.sourceFieldId)) return false;
    if (r.action === 'submit') return true; // target は '' 正規化済 = 既定完了ページ (Phase1)
    return idSet.has(r.targetFieldId);
  };
  // F-MED-2: Phase1 は submit の success-page target 非対応 → 表示 submit rule の target を '' へ正規化。
  const normalizePhase1 = (r: HarnessLogicRule): HarnessLogicRule =>
    r.action === 'submit' && r.targetFieldId !== '' ? { ...r, targetFieldId: '' } : r;
  // 表示用射影。実 bare array は route-branching (multi-jump) / route-terminal (submit) の **展開可能 item** のみを
  //   第一級 rule へ射影する (compound/simple-single は非表示 = preserve-raw で保持・弱化 count で surface / Batch 1 不変)。
  //   legacy synthetic `{rules}` 形は従来経路。
  const logic = (Array.isArray(rawLogic)
    ? fromFormalooRawLogic(
        rawLogic.filter((it) => isExpandableMultiJumpItem(it) || isExpandableTerminalItem(it)),
        resolveId,
      )
    : fromFormalooLogic(logicObj, resolveId)
  )
    .map(normalizePhase1)
    .filter(b5Keep);

  // pull-fidelity 弱化検知 (additive): 実 bare array は射影しきれない item 数を、legacy `{rules}` は
  // 複条件/複アクション rule 数を数える。是正: preserve 導入後は「表示簡略化・データ保持」の意味 (D-6/D-10)。
  const weakened = rawLogic != null ? countWeakenedFormalooRules(rawLogic) : countWeakenedFormalooRules(logicObj);
  const warnings =
    weakened > 0
      ? [`複合ロジックルール ${weakened} 件は表示上 1 条件に簡略化されますが、そのまま保存すればデータは保持されます（Formaloo の複合条件は builder 非対応・編集保存時のみ簡略化）`]
      : [];

  return {
    ok: true,
    fields,
    logic,
    ...(warnings.length ? { warnings } : {}),
    ...(rawLogic != null ? { rawLogic } : {}),
    logicFingerprint: logicFingerprint(logic),
    fieldSlugById,
    // form-design (Batch D): 色/画像テーマを復元 (design 無しは空 {})。
    design: extractDesign(body),
    // form-route-branching (R2): 表示形式 form_type を復元 (未設定は undefined = 従来不変)。
    ...(extractFormType(body) !== undefined ? { formType: extractFormType(body) } : {}),
  };
}

/**
 * Formaloo form-detail を GET し、fields_list / logic を harness 定義へ変換して返す。
 *  - fields: fromFormalooField (非 subset は null で drop / M-21) → 空/欠落 id を drop (W3)
 *            → Formaloo position 昇順に安定ソート (W2)。
 *  - logic: fromFormalooLogic → 変換済 field-id 集合に無い rule を除去 (孤立防止 / B5)。
 *  - fail-soft: formalooSlug 無 / GET 非 ok / read-shape 不一致 / 例外 は {ok:false} (throw しない / N-6)。
 */
export async function pullDefinitionFromFormaloo(
  client: FormalooClient,
  params: {
    formalooSlug: string | null;
    resolveId: (formalooFieldSlug: string) => string | undefined;
  },
): Promise<PullResult> {
  try {
    if (!params.formalooSlug) return { ok: false, error: 'form 未 push（Formaloo slug 無し）' };

    const res = await client.get(`/v3.0/forms/${params.formalooSlug}/`);
    if (!res.ok) return { ok: false, error: `pull failed: HTTP ${res.status}` };

    return buildPullResult(res.data, params.resolveId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
