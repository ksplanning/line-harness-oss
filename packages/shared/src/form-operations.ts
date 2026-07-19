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

/** Formaloo GET response (`data.form.*`) から管理対象の非既定値だけを逆算する。 */
export function extractFormOperationsSettings(root: unknown): FormOperationsSettings {
  const r = (root ?? {}) as Record<string, any>;
  const candidates = [r?.data?.form, r?.data, r?.form, r];
  const form = candidates.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate) && (
    'has_recaptcha' in candidate ||
    'accept_draft_answers' in candidate ||
    'max_submit_count' in candidate ||
    'submit_start_time' in candidate ||
    'submit_end_time' in candidate
  )) ?? {};
  const f = form as Record<string, unknown>;
  const settings: FormOperationsSettings = {};
  if (f.has_recaptcha === true) settings.hasRecaptcha = true;
  if (f.accept_draft_answers === true) settings.acceptDraftAnswers = true;
  if (typeof f.max_submit_count === 'number' && Number.isInteger(f.max_submit_count)) {
    settings.maxSubmitCount = f.max_submit_count;
  }
  if (typeof f.submit_start_time === 'string' && f.submit_start_time) settings.submitStartTime = f.submit_start_time;
  if (typeof f.submit_end_time === 'string' && f.submit_end_time) settings.submitEndTime = f.submit_end_time;
  return settings;
}
