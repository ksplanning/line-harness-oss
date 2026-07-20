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
  const printable = Array.isArray(value)
    ? value
      .filter((item) => item != null && item !== '')
      .map((item) => String(item))
      .join(', ')
    : String(value);
  return printable === '' ? fallback ?? '' : printable;
}

interface OriginalTokenReplacement {
  end: number;
  value: string;
}

function matchOriginalToken(
  content: string,
  start: number,
  liffId: string | null,
  variables: MessageRenderVariables | undefined,
  fieldNames: readonly string[],
): OriginalTokenReplacement | null {
  if (liffId && content.startsWith('{{liff_id}}', start)) {
    return { end: start + '{{liff_id}}'.length, value: liffId };
  }

  const displayPrefix = '{{display_name';
  if (
    variables?.displayName !== undefined
    && content.startsWith(displayPrefix, start)
  ) {
    const suffixStart = start + displayPrefix.length;
    if (content.startsWith('}}', suffixStart)) {
      return {
        end: suffixStart + 2,
        value: printableValue(variables.displayName, undefined),
      };
    }
    if (content[suffixStart] === '|') {
      const tokenEnd = content.indexOf('}}', suffixStart + 1);
      if (tokenEnd !== -1) {
        return {
          end: tokenEnd + 2,
          value: printableValue(
            variables.displayName,
            content.slice(suffixStart + 1, tokenEnd),
          ),
        };
      }
    }
  }

  const fieldPrefix = '{{field:';
  if (variables?.customFields && content.startsWith(fieldPrefix, start)) {
    const nameStart = start + fieldPrefix.length;
    for (const fieldName of fieldNames) {
      if (!content.startsWith(fieldName, nameStart)) continue;
      const suffixStart = nameStart + fieldName.length;
      const value = variables.customFields[fieldName];
      if (content.startsWith('}}', suffixStart)) {
        return {
          end: suffixStart + 2,
          value: printableValue(value, undefined),
        };
      }
      // Custom field names may legally contain `|`. Match only the complete
      // active definition name; missing values use the definition default (or
      // empty string), so a deleted/inactive longer name is never reinterpreted
      // as a shorter field plus inline fallback.
    }
  }

  return null;
}

export function renderMessageContent(
  content: string,
  liffId: string | null,
  variables?: MessageRenderVariables,
): string {
  if (!content.includes('{{') || (!liffId && !variables)) return content;

  // Only tokens present in the original template are scanned. Replacement values
  // are appended literally and never interpreted as a second template pass.
  const fieldNames = variables?.customFields
    ? Object.keys(variables.customFields).sort((left, right) => right.length - left.length)
    : [];
  let cursor = 0;
  let result = '';
  while (cursor < content.length) {
    const tokenStart = content.indexOf('{{', cursor);
    if (tokenStart === -1) {
      result += content.slice(cursor);
      break;
    }
    result += content.slice(cursor, tokenStart);
    const replacement = matchOriginalToken(content, tokenStart, liffId, variables, fieldNames);
    if (replacement) {
      result += replacement.value;
      cursor = replacement.end;
    } else {
      // Unknown tokens are opaque. Skipping their original closing delimiter
      // prevents a known token nested inside malformed/unknown syntax from
      // being interpreted and keeps the unknown source bytes unchanged.
      const unknownEnd = content.indexOf('}}', tokenStart + 2);
      if (unknownEnd === -1) {
        const unknownSource = content.slice(tokenStart);
        result += liffId ? unknownSource.replaceAll('{{liff_id}}', liffId) : unknownSource;
        break;
      }
      const unknownSource = content.slice(tokenStart, unknownEnd + 2);
      result += liffId ? unknownSource.replaceAll('{{liff_id}}', liffId) : unknownSource;
      cursor = unknownEnd + 2;
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
  const hasDisplayNameToken = content.includes('{{display_name');
  const hasCustomFieldToken = content.includes('{{field:');
  if (!hasDisplayNameToken && !hasCustomFieldToken) {
    return renderMessageContent(content, liffId);
  }
  if (!hasCustomFieldToken) {
    return renderMessageContent(content, liffId, { displayName: friend.display_name });
  }

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
