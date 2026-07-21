// =============================================================================
// form-image-upload — フォーム装飾画像の R2 host + 保存前解決 (T-C1/T-C2)
// -----------------------------------------------------------------------------
// spike S-1 実測: 差し込み画像は Formaloo storage (/v3.0/files/=401) を使わず harness R2 に host し、
//   section description の canonical <img src> に R2 URL を埋める。no-auth GET は images.ts の
//   `/images/:key{.+}` route が serve する (本 module は upload + URL 生成のみ・GET route は既存流用)。
// 保存 flow: forms-advanced save で validateHarnessField 済 fields の image field を走査し、
//   imageUpload(dataUrl) を R2 upload → imageUrl 確定 → imageUpload drop してから D1 保存 + push。
//   push は toFormalooFieldPayload(image) が imageUrl から canonical <img> description を生成する (shared)。
// =============================================================================

import {
  validateImageUpload,
  type FormDesign,
  type FormDesignImageUpload,
  type FormDesignImages,
  type HarnessField,
} from '@line-crm/shared';

const DATAURL_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
/** decoded byte 上限 (shared MAX_IMAGE_UPLOAD_BYTES と同水準・Worker メモリ保護 / R-4)。 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const EXT_BY_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export interface R2UploadEnv {
  IMAGES: R2Bucket;
  WORKER_URL?: string;
}

export type ImageUploadResult = { ok: true; url: string } | { ok: false; error: string };

const DESIGN_IMAGE_URL_KEYS = {
  logo: 'logoUrl',
  cover: 'backgroundImageUrl',
} as const satisfies Record<keyof FormDesignImages, keyof FormDesign>;

type DecorationImageResolveOptions = {
  design?: FormDesign;
  designImages?: unknown;
};

/**
 * data:image/...;base64,... を R2 (IMAGES) へ upload し、no-auth GET URL を返す。
 * key prefix = media/form-image/{formId}/ (media/ scope ゆえ既存メディアライブラリ list と整合)。
 * dataUrl は validateHarnessField(image) で検証済だが decode を防御的に扱う (不正/過大は fail-soft)。
 */
export async function uploadImageDataUrlToR2(
  env: R2UploadEnv,
  dataUrl: string,
  formId: string,
  fallbackOrigin: string,
): Promise<ImageUploadResult> {
  const m = DATAURL_RE.exec(dataUrl);
  if (!m) return { ok: false, error: '画像を読み込めませんでした' };
  const mime = m[1];
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
  } catch {
    return { ok: false, error: '画像を読み込めませんでした' };
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, error: '画像が大きすぎます（10MB まで）' };
  const ext = EXT_BY_MIME[mime] ?? 'png';
  const key = `media/form-image/${formId}/${crypto.randomUUID()}.${ext}`;
  try {
    await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: mime } });
  } catch {
    return { ok: false, error: '画像の保存に失敗しました' };
  }
  const workerUrl = env.WORKER_URL || fallbackOrigin;
  return { ok: true, url: `${workerUrl}/images/${key}` };
}

/**
 * validateHarnessField 済の fields と、任意の design image intent を保存前に解決する。
 *  - replace + dataUrl: uploader で R2 upload → config.imageUrl 確定 → imageUpload drop。
 *  - remove: imageUrl / imageUpload を消す (画像なし = 保存で description='' に落ちる)。
 *  - keep / dataUrl 無し replace: intent を落とし既存 imageUrl 温存。
 *  - design.logo / design.cover: 同じ uploader で R2 化し、logoUrl / backgroundImageUrl へ確定。
 * uploader 失敗は全体を止める (silent skip しない = owner に「置いたのに出ない」を出さない honest surface)。
 * non-image field は不変。imageUpload は D1/push いずれにも残さない (巨大 base64 を persist しない)。
 */
export async function resolveInBodyImageUploads(
  fields: HarnessField[],
  uploader: (dataUrl: string) => Promise<ImageUploadResult>,
  options?: DecorationImageResolveOptions,
): Promise<{ ok: true; design?: FormDesign } | { ok: false; error: string }> {
  for (const f of fields) {
    if (f.type !== 'image') continue;
    const up = f.config.imageUpload;
    if (!up) continue;
    if (up.intent === 'remove') {
      delete f.config.imageUrl;
      delete f.config.imageUpload;
      continue;
    }
    if (up.intent === 'replace' && up.dataUrl) {
      const r = await uploader(up.dataUrl);
      if (!r.ok) return { ok: false, error: r.error };
      f.config.imageUrl = r.url;
      delete f.config.imageUpload;
      continue;
    }
    delete f.config.imageUpload;
  }

  if (!options) return { ok: true };
  const design = { ...(options.design ?? {}) };
  if (options.designImages === undefined) return { ok: true, design };
  if (
    typeof options.designImages !== 'object'
    || options.designImages === null
    || Array.isArray(options.designImages)
  ) {
    return { ok: false, error: '画像の指定が正しくありません' };
  }

  const designImages = options.designImages as Record<string, unknown>;
  for (const slot of Object.keys(DESIGN_IMAGE_URL_KEYS) as Array<keyof typeof DESIGN_IMAGE_URL_KEYS>) {
    const candidate = designImages[slot];
    if (candidate === undefined) continue;
    const validation = validateImageUpload(candidate);
    if (!validation.ok) return { ok: false, error: validation.reason ?? '画像の指定が正しくありません' };

    const upload = candidate as FormDesignImageUpload;
    const urlKey = DESIGN_IMAGE_URL_KEYS[slot];
    if (upload.intent === 'remove') {
      delete design[urlKey];
      continue;
    }
    if (upload.intent === 'replace' && upload.dataUrl) {
      const result = await uploader(upload.dataUrl);
      if (!result.ok) return result;
      design[urlKey] = result.url;
    }
  }
  return { ok: true, design };
}
