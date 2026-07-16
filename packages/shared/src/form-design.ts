// =============================================================================
// harness フォームデザイン ↔ Formaloo theme field 契約 (LANE / worker + web 共有)
// -----------------------------------------------------------------------------
// 🚨 live-probe landmine (2026-07-16): fresh form の color GET 値は RGBA object ではなく、
//    RGBA object を JSON.stringify した「文字列」。hex PATCH 後の GET 値は plain hex 文字列になる。
//    よって pull は object / JSON-string / hex の全 shape を受け、push の既定は hex のままにする。
//    hexToFormalooRgba は API shape が再変更された場合の保険であり、既定の push 形式ではない。
// M-21: normalize では raw object を spread せず、明示 whitelist 以外を通さない。
// =============================================================================

/** Formaloo color read-shape。harness canonical は 6 桁 UPPERCASE hex または null。 */
export type FormalooColorValue = {
  r: number;
  g: number;
  b: number;
  a?: number;
} | string | null | undefined;

/** harness が共有する 7 つの canonical color key。 */
export const FORM_DESIGN_COLOR_KEYS = [
  'themeColor',
  'backgroundColor',
  'buttonColor',
  'textColor',
  'fieldColor',
  'borderColor',
  'submitTextColor',
] as const;

export type FormDesignColorKey = (typeof FORM_DESIGN_COLOR_KEYS)[number];

/** harness canonical key → Formaloo form field name (OFF-LANE worker が利用)。 */
export const FORM_DESIGN_TO_FORMALOO: Record<FormDesignColorKey, string> = {
  themeColor: 'theme_color',
  backgroundColor: 'background_color',
  buttonColor: 'button_color',
  textColor: 'text_color',
  fieldColor: 'field_color',
  borderColor: 'border_color',
  submitTextColor: 'submit_text_color',
};

export interface FormDesign {
  /** key absent = unchanged。explicit null = user cleared。 */
  themeColor?: string | null;
  backgroundColor?: string | null;
  buttonColor?: string | null;
  textColor?: string | null;
  fieldColor?: string | null;
  borderColor?: string | null;
  submitTextColor?: string | null;
  themeName?: string | null;
  /** Formaloo-hosted URL (http(s) only)。 */
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  backgroundImageUrl?: string | null;
  presetId?: string | null;
}

/** UI が収集し、worker が multipart PATCH に変換する画像 upload intent。 */
export interface FormDesignImageUpload {
  intent: 'keep' | 'replace' | 'remove';
  /** intent === 'replace' のときだけ必須 (data:image/...;base64,...)。 */
  dataUrl?: string;
  /** image/png | image/jpeg | image/gif | image/webp。 */
  mimeType?: string;
  filename?: string;
}

export interface FormDesignImages {
  logo?: FormDesignImageUpload;
  cover?: FormDesignImageUpload;
}

/** `#RGB` または `#RRGGBB` のみを受理する。 */
export function isValidHexColor(s: unknown): s is string {
  return typeof s === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(s);
}

function normalizeHexColor(hex: string): string | null {
  if (!isValidHexColor(hex)) return null;
  const digits = hex.slice(1);
  const expanded = digits.length === 3
    ? digits.split('').map((digit) => `${digit}${digit}`).join('')
    : digits;
  return `#${expanded.toUpperCase()}`;
}

function channelToHex(channel: unknown): string | null {
  if (typeof channel !== 'number' || !Number.isFinite(channel)) return null;
  const normalized = Math.min(255, Math.max(0, Math.round(channel)));
  return normalized.toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Formaloo の polymorphic color read-shape を harness canonical hex に変換する。
 * alpha は theme color の canonical 値に含めないため意図的に無視する。
 */
export function formalooColorToHex(v: FormalooColorValue): string | null {
  if (typeof v === 'string') {
    const trimmed = v.trim();

    // 🚨 fresh Formaloo GET は RGBA object そのものではなく JSON-stringified object を返す。
    if (trimmed.startsWith('{')) {
      try {
        return formalooColorToHex(JSON.parse(trimmed) as FormalooColorValue);
      } catch {
        return null;
      }
    }

    return normalizeHexColor(trimmed);
  }

  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;

  const color = v as Record<string, unknown>;
  const red = channelToHex(color.r);
  const green = channelToHex(color.g);
  const blue = channelToHex(color.b);
  if (red === null || green === null || blue === null) return null;
  return `#${red}${green}${blue}`;
}

/** hex を Formaloo RGBA object に変換する保険 helper（既定 push は hex string）。 */
export function hexToFormalooRgba(
  hex: string,
): { r: number; g: number; b: number; a: number } | null {
  const normalized = normalizeHexColor(hex);
  if (normalized === null) return null;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
    a: 1,
  };
}

const FORM_DESIGN_URL_KEYS = [
  'logoUrl',
  'coverImageUrl',
  'backgroundImageUrl',
] as const;

function hasOwn(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // http(s) スキームのみ許可 (javascript:/data: 等を弾く)。`URL` global は shared の pure-lib
  // tsconfig に無い (build fail) ため正規表現で判定する。空白/制御文字を含む注入も弾く。
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * 不明キーを剥がし、更新に安全な FormDesign に正規化する (M-21)。
 * color / URL の不正値は null に変えず key ごと落とす。誤った remote clear を防ぐため、
 * undefined / null / 空 object から既定 color key を生成してはならない。
 */
export function normalizeFormDesign(raw: unknown): FormDesign {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const design: FormDesign = {};

  for (const key of FORM_DESIGN_COLOR_KEYS) {
    if (!hasOwn(input, key)) continue;
    const color = formalooColorToHex(input[key] as FormalooColorValue);
    if (color !== null) design[key] = color;
  }

  for (const key of FORM_DESIGN_URL_KEYS) {
    if (!hasOwn(input, key)) continue;
    const url = normalizeHttpUrl(input[key]);
    if (url !== null) design[key] = url;
  }

  if (hasOwn(input, 'themeName') && typeof input.themeName === 'string') {
    design.themeName = input.themeName.trim().slice(0, 120);
  }
  if (hasOwn(input, 'presetId') && typeof input.presetId === 'string') {
    design.presetId = input.presetId;
  }

  return design;
}

const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/**
 * 画像 upload の decoded byte 上限 (plan R-4 / images.ts と同水準)。
 * 大 base64 → atob → Uint8Array → File が Worker メモリ(128MB)を圧迫するのを防ぐ。
 */
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

/** base64 payload の decoded byte 長を padding 考慮で概算する。 */
export function base64DecodedByteLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

function isAllowedImageMime(value: unknown): value is (typeof ALLOWED_IMAGE_MIME_TYPES)[number] {
  return typeof value === 'string'
    && (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** image upload intent と replace payload の組み合わせを検証する。 */
export function validateImageUpload(u: unknown): { ok: boolean; reason?: string } {
  if (typeof u !== 'object' || u === null || Array.isArray(u)) {
    return { ok: false, reason: 'upload must be an object' };
  }
  const upload = u as Record<string, unknown>;
  if (upload.intent !== 'keep' && upload.intent !== 'replace' && upload.intent !== 'remove') {
    return { ok: false, reason: 'intent must be keep, replace, or remove' };
  }
  if (upload.mimeType !== undefined && !isAllowedImageMime(upload.mimeType)) {
    return { ok: false, reason: 'mimeType is not an allowed image type' };
  }
  if (upload.intent !== 'replace') return { ok: true };
  if (typeof upload.dataUrl !== 'string') {
    return { ok: false, reason: 'dataUrl is required when intent is replace' };
  }

  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(upload.dataUrl);
  if (match === null) {
    return { ok: false, reason: 'dataUrl must contain a supported base64 image' };
  }
  if (upload.mimeType !== undefined && upload.mimeType !== match[1]) {
    return { ok: false, reason: 'mimeType must match the dataUrl image type' };
  }
  // F4 (plan R-4): decoded byte 上限。大画像で Worker メモリを圧迫させない。
  if (base64DecodedByteLength(match[2]) > MAX_IMAGE_UPLOAD_BYTES) {
    return { ok: false, reason: '画像が大きすぎます（10MB まで）' };
  }
  return { ok: true };
}

export interface DesignPreset {
  id: string;
  label: string;
  colors: Record<FormDesignColorKey, string>;
}

/** LINE green と調和しつつ、用途ごとに温度感を変えた anti-generic palette。 */
export const LINE_PRESET_PALETTES: DesignPreset[] = [
  {
    id: 'line-green',
    label: 'LINE フレッシュ',
    colors: {
      themeColor: '#06C755',
      backgroundColor: '#F4FBF7',
      buttonColor: '#06C755',
      textColor: '#17352A',
      fieldColor: '#FFFFFF',
      borderColor: '#B7DCC8',
      submitTextColor: '#FFFFFF',
    },
  },
  {
    id: 'warm-terracotta',
    label: 'ウォームテラコッタ',
    colors: {
      themeColor: '#B86F52',
      backgroundColor: '#FBF6F0',
      buttonColor: '#9E5D45',
      textColor: '#402D27',
      fieldColor: '#FFFDFC',
      borderColor: '#D8C2B6',
      submitTextColor: '#FFFFFF',
    },
  },
  {
    id: 'deep-tide',
    label: 'ディープタイド',
    colors: {
      themeColor: '#285C66',
      backgroundColor: '#EEF5F4',
      buttonColor: '#327682',
      textColor: '#183A40',
      fieldColor: '#FFFFFF',
      borderColor: '#AFCAC8',
      submitTextColor: '#FFFFFF',
    },
  },
  {
    id: 'soft-plum',
    label: 'ソフトプラム',
    colors: {
      themeColor: '#7D4E72',
      backgroundColor: '#F8F2F6',
      buttonColor: '#A05C7B',
      textColor: '#3E2937',
      fieldColor: '#FFFFFF',
      borderColor: '#D8BCCC',
      submitTextColor: '#FFFFFF',
    },
  },
];
