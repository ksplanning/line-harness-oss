/** Form 単位の運用制御。false/null/未載は Formaloo 既定 = canonical では key を持たない。 */
export interface FormOperationsSettings {
  hasRecaptcha?: true;
  acceptDraftAnswers?: true;
  maxSubmitCount?: number;
  submitStartTime?: string;
  submitEndTime?: string;
  /** Harness 公開導線だけの intent。Formaloo FormUpdateRequest には送らない。 */
  utmTracking?: true;
}

/** Builder/API の部分更新。false/null は Formaloo 既定へ戻す明示 intent。 */
export interface FormOperationsSettingsPatch {
  hasRecaptcha?: boolean;
  acceptDraftAnswers?: boolean;
  maxSubmitCount?: number | null;
  submitStartTime?: string | null;
  submitEndTime?: string | null;
  /** Harness 公開導線だけの intent。Formaloo FormUpdateRequest には送らない。 */
  utmTracking?: boolean;
}

/**
 * Formaloo で実測した FormUpdateRequest の該当 shape。
 * 今回 UI 管理しない 2 key も型として pin し、誤った別名へ置換されないようにする。
 */
export interface FormalooFormUpdateRequest {
  has_recaptcha?: boolean;
  accept_draft_answers?: boolean;
  max_submit_count?: number | null;
  max_submit_per_ip_per_day?: number | null;
  submit_start_time?: string | null;
  submit_end_time?: string | null;
  time_limit?: string | null;
}

const PATCH_KEYS = [
  'hasRecaptcha',
  'acceptDraftAnswers',
  'maxSubmitCount',
  'submitStartTime',
  'submitEndTime',
  'utmTracking',
] as const satisfies readonly (keyof FormOperationsSettingsPatch)[];

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function validDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Formaloo FormUpdateRequest の datetime は timezone 付き ISO8601 に限定する。
  // Date.parse 単独だと `July 20, 2026` 等の実装依存形式まで通すため、shape と暦範囲を先に固定する。
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  if (zone !== 'Z') {
    const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

/** 保存済み camelCase 値を「非既定値だけ」の canonical へ正規化する。 */
export function normalizeFormOperationsSettings(raw: unknown): FormOperationsSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const settings: FormOperationsSettings = {};
  if (value.hasRecaptcha === true) settings.hasRecaptcha = true;
  if (value.acceptDraftAnswers === true) settings.acceptDraftAnswers = true;
  if (typeof value.maxSubmitCount === 'number' && Number.isInteger(value.maxSubmitCount) && value.maxSubmitCount > 0) {
    settings.maxSubmitCount = value.maxSubmitCount;
  }
  if (validDateTime(value.submitStartTime)) settings.submitStartTime = value.submitStartTime;
  if (validDateTime(value.submitEndTime)) settings.submitEndTime = value.submitEndTime;
  if (value.utmTracking === true) settings.utmTracking = true;
  return settings;
}

export type FormOperationsPatchValidation =
  | { ok: true; patch: FormOperationsSettingsPatch }
  | { ok: false; error: string };

/** 管理 key だけを受理する。未知 key は送信も保存もせず drop する。 */
export function validateFormOperationsSettingsPatch(raw: unknown): FormOperationsPatchValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '運用制御の設定形式が不正です' };
  }
  const value = raw as Record<string, unknown>;
  const patch: FormOperationsSettingsPatch = {};
  for (const key of PATCH_KEYS) {
    if (!hasOwn(value, key)) continue;
    const incoming = value[key];
    switch (key) {
      case 'hasRecaptcha':
      case 'acceptDraftAnswers':
      case 'utmTracking':
        if (typeof incoming !== 'boolean') return { ok: false, error: `${key} は true/false で指定してください` };
        patch[key] = incoming;
        break;
      case 'maxSubmitCount':
        if (incoming !== null && !(typeof incoming === 'number' && Number.isInteger(incoming) && incoming > 0)) {
          return { ok: false, error: '送信上限は1以上の整数または未設定で指定してください' };
        }
        patch.maxSubmitCount = incoming as number | null;
        break;
      case 'submitStartTime':
      case 'submitEndTime':
        if (incoming !== null && !validDateTime(incoming)) {
          return { ok: false, error: `${key === 'submitStartTime' ? '受付開始' : '受付終了'}は日時または未設定で指定してください` };
        }
        patch[key] = incoming as string | null;
        break;
    }
  }
  return { ok: true, patch };
}

/** 保存済み canonical へ部分更新を適用し、clear/default key は削除する。 */
export function mergeFormOperationsSettings(
  previous: unknown,
  patch: FormOperationsSettingsPatch,
): FormOperationsSettings {
  const merged: Record<string, unknown> = { ...normalizeFormOperationsSettings(previous) };
  for (const key of PATCH_KEYS) {
    if (!hasOwn(patch, key)) continue;
    const value = patch[key];
    if (value === false || value === null) delete merged[key];
    else merged[key] = value;
  }
  return normalizeFormOperationsSettings(merged);
}

/** 管理 5 key だけを実測済み snake_case FormUpdateRequest へ射影する。 */
export function toFormalooFormUpdateRequest(
  patch: FormOperationsSettingsPatch,
): FormalooFormUpdateRequest {
  const body: FormalooFormUpdateRequest = {};
  if (hasOwn(patch, 'hasRecaptcha')) body.has_recaptcha = patch.hasRecaptcha;
  if (hasOwn(patch, 'acceptDraftAnswers')) body.accept_draft_answers = patch.acceptDraftAnswers;
  if (hasOwn(patch, 'maxSubmitCount')) body.max_submit_count = patch.maxSubmitCount;
  if (hasOwn(patch, 'submitStartTime')) body.submit_start_time = patch.submitStartTime;
  if (hasOwn(patch, 'submitEndTime')) body.submit_end_time = patch.submitEndTime;
  return body;
}

function extractFormalooForm(root: unknown): Record<string, unknown> {
  const r = (root ?? {}) as Record<string, any>;
  const candidates = [r?.data?.form, r?.data, r?.form, r];
  const form = candidates.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate) && (
    'has_recaptcha' in candidate ||
    'accept_draft_answers' in candidate ||
    'max_submit_count' in candidate ||
    'submit_start_time' in candidate ||
    'submit_end_time' in candidate
  )) ?? {};
  return form as Record<string, unknown>;
}

/** GET response に実測済み運用 key が present か。全 default と shape 欠落を区別する。 */
export function hasFormalooOperationsFields(root: unknown): boolean {
  const form = extractFormalooForm(root);
  return [
    'has_recaptcha',
    'accept_draft_answers',
    'max_submit_count',
    'submit_start_time',
    'submit_end_time',
  ].some((key) => hasOwn(form, key));
}

/** Formaloo GET response (`data.form.*`) から管理対象の非既定値だけを逆算する。 */
export function extractFormOperationsSettings(root: unknown): FormOperationsSettings {
  const f = extractFormalooForm(root);
  return normalizeFormOperationsSettings({
    hasRecaptcha: f.has_recaptcha,
    acceptDraftAnswers: f.accept_draft_answers,
    maxSubmitCount: f.max_submit_count,
    submitStartTime: f.submit_start_time,
    submitEndTime: f.submit_end_time,
  });
}
