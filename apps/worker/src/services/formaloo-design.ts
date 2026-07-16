import {
  FORM_DESIGN_COLOR_KEYS,
  FORM_DESIGN_TO_FORMALOO,
  validateImageUpload,
  type FormDesign,
  type FormDesignImages,
  type FormDesignImageUpload,
} from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client.js';

// =============================================================================
// form-design push helpers (F-2 Batch D / OFF-LANE) — harness FormDesign を Formaloo form へ反映。
// -----------------------------------------------------------------------------
// live-probe 実測 (2026-07-16 使い捨てフォーム):
//   - 色は hex 文字列で `PATCH /v3.0/forms/{slug}/` 直フィールドに round-trip (公開ページも hex 描画)。
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
  /** 差し替え後の logo URL (replace 時) / null (remove 時) / 未変更は不在。 */
  logoUrl?: string | null;
  /** 差し替え後の背景(カバー) URL (replace 時) / null (remove 時) / 未変更は不在。 */
  backgroundImageUrl?: string | null;
}

/**
 * FormDesign の canonical 色役割を Formaloo form 直フィールド (hex) に変換する (present key のみ)。
 * title/description の既存 meta PATCH body にこの object を merge する (新エンドポイント不要)。
 * 未設定 (key 不在) の色は送らない = Formaloo 側を未変更のまま残す (誤クリア防止 / update 意味論)。
 */
export function designColorFields(design: FormDesign | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!design || typeof design !== 'object') return out;
  for (const key of FORM_DESIGN_COLOR_KEYS) {
    const v = design[key];
    if (typeof v === 'string' && v) out[FORM_DESIGN_TO_FORMALOO[key]] = v;
  }
  if (typeof design.themeName === 'string' && design.themeName) out.theme_name = design.themeName;
  return out;
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
  const result: AppliedDesignImages = {};
  if (!images || typeof images !== 'object') return result;
  const path = `/v3.0/forms/${formalooSlug}/`;

  const slots = Object.keys(IMAGE_SLOT_TO_FORMALOO) as ImageSlot[];

  // 1) replace → 1 回の multipart PATCH に束ねる。
  const form = new FormData();
  const replaceSlots: ImageSlot[] = [];
  for (const slot of slots) {
    const up = images[slot] as FormDesignImageUpload | undefined;
    if (!up || up.intent !== 'replace') continue;
    if (!validateImageUpload(up).ok || !up.dataUrl) continue; // 不正 payload は送らない
    const decoded = dataUrlToBytes(up.dataUrl);
    if (!decoded) continue;
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
    }
  }

  // 2) remove → 1 回の JSON PATCH {field:null} (空文字は 400)。
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
    }
  }

  return result;
}
