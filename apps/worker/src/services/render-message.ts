import { getMergedMetadataByUserId, listFriendFieldDefinitions } from '@line-crm/db';

// message_content 内の共通テンプレ変数を置換する純関数。
// broadcast は配信先 LINE アカウントの liff_id、個別送信は友だち情報を
// 必要な context だけ渡す。context が無い変数は誤消去せずそのまま残す。
export interface MessageRenderVariables {
  displayName?: string | null;
  customFields?: Readonly<Record<string, unknown>>;
}

export interface FriendMessageRecipient {
  display_name: string | null;
  user_id?: string | null;
  metadata?: string | Record<string, unknown> | null;
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

function parseMetadata(metadata: FriendMessageRecipient['metadata']): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata !== 'string') return metadata;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function renderFriendMessageContent(
  content: string,
  liffId: string | null,
  db: D1Database,
  friend: FriendMessageRecipient,
  resolvedMetadata?: Readonly<Record<string, unknown>>,
): Promise<string> {
  const metadata = resolvedMetadata ?? (
    friend.user_id
      ? await getMergedMetadataByUserId(db, friend.user_id)
      : parseMetadata(friend.metadata)
  );
  const definitions = await listFriendFieldDefinitions(db, { activeOnly: true });
  const customFields = Object.fromEntries(definitions.map((definition) => [
    definition.name,
    Object.prototype.hasOwnProperty.call(metadata, definition.name)
      ? metadata[definition.name]
      : definition.defaultValue,
  ]));

  return renderMessageContent(content, liffId, {
    displayName: friend.display_name,
    customFields,
  });
}
