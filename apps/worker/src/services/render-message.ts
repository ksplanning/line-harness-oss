// message_content 内の共通テンプレ変数を置換する純関数。
// broadcast は配信先 LINE アカウントの liff_id、個別送信は友だち情報を
// 必要な context だけ渡す。context が無い変数は誤消去せずそのまま残す。
export interface MessageRenderVariables {
  displayName?: string | null;
  customFields?: Readonly<Record<string, unknown>>;
}

function printableValue(value: unknown, fallback: string | undefined): string {
  if (value == null || value === '') return fallback ?? '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function renderMessageContent(
  content: string,
  liffId: string | null,
  variables?: MessageRenderVariables,
): string {
  let result = liffId ? content.replaceAll('{{liff_id}}', liffId) : content;
  if (!variables) return result;

  result = result.replace(
    /\{\{display_name(?:\|([^}]*))?\}\}/g,
    (_match, fallback: string | undefined) => printableValue(variables.displayName, fallback),
  );

  if (variables.customFields) {
    const fieldsByLongestName = Object.entries(variables.customFields)
      .sort(([left], [right]) => right.length - left.length);
    for (const [fieldName, value] of fieldsByLongestName) {
      const tokenStart = `{{field:${fieldName}`;
      const fallbackPattern = new RegExp(`${escapeRegExp(tokenStart)}\\|([^}]*)\\}\\}`, 'g');
      result = result.replace(
        fallbackPattern,
        (_match, fallback: string) => printableValue(value, fallback),
      );
      result = result.replaceAll(`${tokenStart}}}`, printableValue(value, undefined));
    }
  }

  return result;
}
