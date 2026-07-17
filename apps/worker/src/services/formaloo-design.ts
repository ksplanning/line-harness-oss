import {
  FORM_DESIGN_COLOR_KEYS,
  FORM_DESIGN_TO_FORMALOO,
  formalooColorToHex,
  hexToFormalooRgba,
  validateImageUpload,
  type FormDesign,
  type FormDesignColorKey,
  type FormDesignImages,
  type FormDesignImageUpload,
} from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client.js';

// =============================================================================
// form-design push helpers (F-2 Batch D / OFF-LANE) — harness FormDesign を Formaloo form へ反映。
// -----------------------------------------------------------------------------
// 🚨 反映条件 (design-hosted-apply-fix spike 2026-07-17・使い捨てフォーム before/after 実測):
//   - hosted 公開ページの実レンダーは form 直下の flat 色フィールド (background_color/button_color/
//     field_color/text_color/submit_text_color) を **JSON-string RGBA** ('{"r":..,"g":..,"b":..,"a":1}')
//     で受けたときのみ描画する。**hex 文字列 (#RRGGBB) はデータ層に round-trip するが hosted app
//     (formaloo.me static bundle) が parse できず既定色 (gray/pink) にフォールバックする** (= 従来の
//     「保存されるが公開ページに反映されない」バグの真因)。theme resource (form.theme) は描画に不使用。
//     証跡: .plans/2026-07-17-design-hosted-apply-fix/evidence/reflection-condition.md。
//   - 画像は `logo` / `background_image` のみ書ける (cover_image は no-op)。カバー(=ヘッダー背景 spec②)
//     は `background_image` に map。replace = multipart File PATCH / remove = JSON {field:null}
//     (空文字 '' は 400) / keep = no-op。upload 成功で `logo`/`background_image` に S3 URL が返る。
// update 意味論: present な色/画像 intent だけ送る。未変更 (key 不在 / intent keep) は PATCH に載せない
//   (Formaloo 側の既存 design を誤って潰さない)。
// =============================================================================

/** UI の 2 画像スロット → Formaloo の書ける form 画像フィールド。 */
const IMAGE_SLOT_TO_FORMALOO = { logo: 'logo', cover: 'background_image' } as const;
type ImageSlot = keyof typeof IMAGE_SLOT_TO_FORMALOO;

/** applyDesignImages が返す、upload 後に確定した Formaloo ホスト URL (persist / response 用)。 */
export interface AppliedDesignImages {
  /**
   * F1: 試行した全 slot が成功したか (keep/no-op も ok:true)。false なら route が out_of_sync を set する
   * (silent success 禁止 = owner が「ロゴ設定済」と誤認する failure_observable を防ぐ)。
   */
  ok: boolean;
  /** 失敗時の要約 (out_of_sync の lastError 用)。 */
  error?: string;
  /** 差し替え後の logo URL (replace 成功時) / null (remove 成功時) / 未変更・失敗は不在。 */
  logoUrl?: string | null;
  /** 差し替え後の背景(カバー) URL (replace 成功時) / null (remove 成功時) / 未変更・失敗は不在。 */
  backgroundImageUrl?: string | null;
}

/**
 * FormDesign の canonical 色役割を Formaloo form 直フィールド (**JSON-string RGBA**) に変換する (present key のみ)。
 * title/description の既存 meta PATCH body にこの object を merge する (新エンドポイント不要)。
 * 値は `'{"r":..,"g":..,"b":..,"a":1}'` の**文字列** = hosted app が parse して描画できる唯一の形式
 *   (spike 2026-07-17 実測。hex は round-trip するが hosted で反映されない)。戻り値は依然 string map なので
 *   meta PATCH body への merge・戻り型は不変。不正 hex は skip (壊れた色を push しない)。
 * 未設定 (key 不在) の色は送らない = Formaloo 側を未変更のまま残す (誤クリア防止 / update 意味論)。
 */
export function designColorFields(design: FormDesign | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!design || typeof design !== 'object') return out;
  for (const key of FORM_DESIGN_COLOR_KEYS) {
    const v = design[key];
    if (typeof v !== 'string' || !v) continue;
    const rgba = hexToFormalooRgba(v); // {r,g,b,a:1} | null (不正 hex は null)
    if (rgba) out[FORM_DESIGN_TO_FORMALOO[key]] = JSON.stringify(rgba);
  }
  if (typeof design.themeName === 'string' && design.themeName) out.theme_name = design.themeName;
  return out;
}

/** confirmDesignReflected の結果 (fail-soft: throw せず ok/error を返す)。 */
export interface DesignReflectionResult {
  /** 期待した全色役割が remote に反映されていれば true。色なし design は確認スキップで true。 */
  ok: boolean;
  /** 不一致 / GET 失敗時の owner 向け要約 (out_of_sync の lastError 用)。 */
  error?: string;
}

/**
 * meta PATCH 後に GET-after-PATCH で「送った色が本当に反映されたか」を確認する (soft-200 対策)。
 * form PATCH は存在しないプロパティ / 受理不能な形式を **soft-200 で無言無視**する地雷があるため、
 * `metaRes.ok` だけを根拠に idle にすると「保存済に見えて hosted に出ない」殻完了を再発させる。
 * remote GET の色 (JSON-string RGBA / object / hex いずれも formalooColorToHex で正規化) を期待 hex と比較し、
 * eventual consistency 用に bounded retry する。全一致で ok / 不一致・GET 失敗は ok:false (route が out_of_sync)。
 * design に色役割が 1 つも無ければ確認対象なしとして GET せず ok:true。
 */
export async function confirmDesignReflected(
  client: FormalooClient,
  formalooSlug: string,
  design: FormDesign | undefined | null,
  opts?: { retries?: number; sleep?: (ms: number) => Promise<void> },
): Promise<DesignReflectionResult> {
  // 期待値 = 送った色役割の正規化 hex (Formaloo field 名 → 期待 hex)。
  const wanted: Array<[string, string]> = [];
  if (design && typeof design === 'object') {
    for (const key of FORM_DESIGN_COLOR_KEYS) {
      const v = design[key as FormDesignColorKey];
      if (typeof v !== 'string' || !v) continue;
      const hex = formalooColorToHex(v);
      if (hex) wanted.push([FORM_DESIGN_TO_FORMALOO[key as FormDesignColorKey], hex]);
    }
  }
  if (wanted.length === 0) return { ok: true }; // 色なし = 確認対象なし (GET しない)

  const retries = opts?.retries ?? 2;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastMiss = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const g = await client.request('GET', `/v3.0/forms/${formalooSlug}/`);
    if (g.ok) {
      const form = extractForm(g.data);
      let allMatch = true;
      for (const [field, hex] of wanted) {
        if (formalooColorToHex(form[field] as never) !== hex) { allMatch = false; lastMiss = field; break; }
      }
      if (allMatch) return { ok: true };
    }
    if (attempt < retries) await sleep(200 * (attempt + 1));
  }
  return { ok: false, error: `配色が公開ページに反映されませんでした（${lastMiss || '確認に失敗しました'}）` };
}

/**
 * confirmBackgroundReflected の slot ごとの期待。
 *  - `{ state: 'set', url }`: replace = GET-after-PATCH の field が **applied URL(PATCH が返した確定 S3 URL)と一致**
 *    することを要求。非空だけでは既存画像の差し替え soft-200 で旧 URL が残っても誤 ok になるため、色版
 *    confirmDesignReflected と同じ「期待値一致」水準にする (FAIL-1 修正)。
 *  - `{ state: 'cleared' }`: remove = field が null/空 になることを要求。
 */
export type BackgroundReflectionCheck =
  | { state: 'set'; url: string }
  | { state: 'cleared' };

/** confirmBackgroundReflected の期待状態 (slot ごとに set(applied URL 一致) / cleared(null・空) を要求)。 */
export interface BackgroundReflectionExpected {
  /** cover(=Formaloo `background_image`) の期待。 */
  backgroundImage?: BackgroundReflectionCheck;
  /** logo(=Formaloo `logo`) の期待。 */
  logo?: BackgroundReflectionCheck;
}

/**
 * 画像 replace/remove の反映を GET-after-PATCH で確認する (soft-200 対策・色版 confirmDesignReflected と同型 fail-soft)。
 * multipart PATCH は 200 でも URL を実際に永続しない soft-200 があり得るため、`applied.ok` だけを idle 根拠にすると
 * 「保存済に見えて背景が出ない」殻完了を再発させ得る (R4 盲点)。独立 GET-after-PATCH で描画 location の反映を確認する。
 *
 * 🚨 描画 location = **top-level `background_image` / `logo`** (bg-fullpage-render-fix spike 2026-07-18 CDP 実測):
 *   hosted SPA は top-level `background_image` を `div.full-height` の background-image に **cover 適用**して描画する。
 *   `theme_config.background_image` は描画する側も・しない側も等しく **空 `{}`** (= 描画に不使用) と実測されたため
 *   **確認対象にしない** (色バグ由来の「入れ子 theme_config 仮説 H1」は spike で REFUTED)。証跡:
 *   .plans/2026-07-18-bg-fullpage-render-fix/evidence/spike-conclusions.md。
 *
 * 'set' は remote field が **applied URL と一致** (非空 かつ PATCH が返した確定 URL に等しい = 差し替え soft-200 で
 * 旧 URL が残るケースを検知)、'cleared' は null/空 を要求。eventual consistency 用に bounded retry。
 * 全一致で ok / 不一致・GET 失敗は ok:false (route が out_of_sync)。期待が 1 つも無ければ GET せず ok:true
 * (replace/remove 無しの経路は素通り = 既存 keep/未指定挙動 byte 不変)。
 */
export async function confirmBackgroundReflected(
  client: FormalooClient,
  formalooSlug: string,
  expected: BackgroundReflectionExpected,
  opts?: { retries?: number; sleep?: (ms: number) => Promise<void> },
): Promise<DesignReflectionResult> {
  // 確認対象 = present な期待のみ (Formaloo field 名 → check)。
  const wanted: Array<[string, BackgroundReflectionCheck]> = [];
  if (expected.backgroundImage) wanted.push([IMAGE_SLOT_TO_FORMALOO.cover, expected.backgroundImage]);
  if (expected.logo) wanted.push([IMAGE_SLOT_TO_FORMALOO.logo, expected.logo]);
  if (wanted.length === 0) return { ok: true }; // 確認対象なし (GET しない)

  const retries = opts?.retries ?? 2;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isSet = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
  let lastMiss = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const g = await client.request('GET', `/v3.0/forms/${formalooSlug}/`);
    if (g.ok) {
      const form = extractForm(g.data);
      let allMatch = true;
      for (const [field, check] of wanted) {
        const v = form[field];
        // 'set' は「非空 かつ applied URL 一致」= 旧 URL 残存 soft-200 を検知 (色版と同じ期待値一致水準)。
        const ok = check.state === 'set' ? (isSet(v) && v === check.url) : !isSet(v);
        if (!ok) { allMatch = false; lastMiss = field; break; }
      }
      if (allMatch) return { ok: true };
    }
    if (attempt < retries) await sleep(200 * (attempt + 1));
  }
  const label = lastMiss === IMAGE_SLOT_TO_FORMALOO.logo ? 'ロゴ' : '背景画像';
  return { ok: false, error: `${label}が公開ページに反映されませんでした（${lastMiss || '確認に失敗しました'}）` };
}

/** data:image/...;base64,xxxx を binary bytes へ (Workers/Node 共通 atob)。不正は null。 */
function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime: m[1] };
  } catch {
    return null;
  }
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};

function extractForm(data: unknown): Record<string, unknown> {
  const r = (data ?? {}) as Record<string, any>;
  return (r?.data?.form ?? r?.data ?? r?.form ?? {}) as Record<string, unknown>;
}

/**
 * FormDesignImages の keep/replace/remove intent を Formaloo form へ反映する。
 *  - replace: 全 replace を **1 回の multipart PATCH** に束ねて送信 (logo / background_image File)。
 *  - remove: 全 remove を **1 回の JSON PATCH** {field:null} で送信。
 *  - keep / 未指定: 何も送らない。
 * fail-soft: PATCH が非 ok の slot は URL を確定させない (呼び側は既存 URL を維持)。
 * @returns 確定した Formaloo ホスト URL (persist + response 用)。
 */
export async function applyDesignImages(
  client: FormalooClient,
  formalooSlug: string,
  images: FormDesignImages | undefined | null,
): Promise<AppliedDesignImages> {
  const result: AppliedDesignImages = { ok: true };
  if (!images || typeof images !== 'object') return result;
  const path = `/v3.0/forms/${formalooSlug}/`;
  const fail = (msg: string) => { result.ok = false; result.error = result.error ?? msg; };

  const slots = Object.keys(IMAGE_SLOT_TO_FORMALOO) as ImageSlot[];

  // 1) replace → 1 回の multipart PATCH に束ねる。不正 payload / PATCH 非 ok は ok:false (silent success 禁止 / F1)。
  const form = new FormData();
  const replaceSlots: ImageSlot[] = [];
  for (const slot of slots) {
    const up = images[slot] as FormDesignImageUpload | undefined;
    if (!up || up.intent !== 'replace') continue;
    const v = validateImageUpload(up);
    if (!v.ok || !up.dataUrl) { fail(v.reason ?? '画像が不正です'); continue; } // 弾いた replace は失敗として surface
    const decoded = dataUrlToBytes(up.dataUrl);
    if (!decoded) { fail('画像を読み込めませんでした'); continue; }
    const field = IMAGE_SLOT_TO_FORMALOO[slot];
    const filename = up.filename && /\.[a-z0-9]+$/i.test(up.filename)
      ? up.filename
      : `${field}.${EXT_BY_MIME[decoded.mime] ?? 'png'}`;
    form.append(field, new File([decoded.bytes], filename, { type: decoded.mime }));
    replaceSlots.push(slot);
  }
  if (replaceSlots.length > 0) {
    const r = await client.requestForm(`PATCH`, path, form);
    if (r.ok) {
      const f = extractForm(r.data);
      for (const slot of replaceSlots) {
        const field = IMAGE_SLOT_TO_FORMALOO[slot];
        const url = (f[field] ?? f[`${field}_url`]) as string | undefined;
        if (slot === 'logo') result.logoUrl = url ?? null;
        else result.backgroundImageUrl = url ?? null;
      }
    } else {
      // 失敗 slot の URL は確定させない (route が D1 の prev URL を維持し out_of_sync へ)。
      fail(`画像のアップロードに失敗しました（HTTP ${r.status}）`);
    }
  }

  // 2) remove → 1 回の JSON PATCH {field:null} (空文字は 400)。非 ok は ok:false。
  const removeBody: Record<string, null> = {};
  for (const slot of slots) {
    const up = images[slot] as FormDesignImageUpload | undefined;
    if (up?.intent === 'remove') removeBody[IMAGE_SLOT_TO_FORMALOO[slot]] = null;
  }
  if (Object.keys(removeBody).length > 0) {
    const r = await client.request('PATCH', path, removeBody);
    if (r.ok) {
      if ('logo' in removeBody) result.logoUrl = null;
      if ('background_image' in removeBody) result.backgroundImageUrl = null;
    } else {
      fail(`画像の削除に失敗しました（HTTP ${r.status}）`);
    }
  }

  return result;
}
