// Formaloo hosted の UI chrome 日本語化。
//
// `localized_content` は form ごとの上書きだけを持ち、`combined_localized_content` は英語既定値を
// 合成した別物である。必ず前者を GET して、ここで管理する top-level key だけを merge/remove する。
// 文字数 validation 文言は Formaloo bundle 内に hard-code され localizable key が無いため含めない。

export const MANAGED_LOCALIZATION_KEYS = [
  'back_btn',
  'next_btn',
  'skip_btn',
  'start_btn',
  'previous_btn',
  'continue_btn',
  'answer',
  'day',
  'month',
  'year',
  'hours',
  'minutes',
  'long_text_hint',
] as const;

export type ManagedLocalizationKey = (typeof MANAGED_LOCALIZATION_KEYS)[number];

export const JP_LOCALIZED_CONTENT: Readonly<Record<ManagedLocalizationKey, string>> = Object.freeze({
  back_btn: '戻る',
  next_btn: '次へ',
  skip_btn: 'スキップ',
  start_btn: '開始',
  previous_btn: '前へ',
  continue_btn: '続ける',
  answer: 'あなたの回答',
  day: '日',
  month: '月',
  year: '年',
  hours: '時',
  minutes: '分',
  long_text_hint: '改行するには Shift + Enter を押してください',
});

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * 現行 `localized_content` へ管理 key だけを ON=merge / OFF=remove する。
 * nested object を含む foreign key は参照も値も保持し、既に目的状態なら入力 object 自体を返す。
 * これにより caller は identity 比較で Formaloo PATCH を byte 同等に短絡できる。
 */
export function buildLocalizedContentMerge(existing: unknown, enabled: boolean): Record<string, unknown> {
  const source = asRecord(existing);
  if (enabled) {
    const changed = MANAGED_LOCALIZATION_KEYS.some((key) => source[key] !== JP_LOCALIZED_CONTENT[key]);
    return changed ? { ...source, ...JP_LOCALIZED_CONTENT } : source;
  }

  if (!MANAGED_LOCALIZATION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(source, key))) {
    return source;
  }
  const merged = { ...source };
  for (const key of MANAGED_LOCALIZATION_KEYS) delete merged[key];
  return merged;
}
