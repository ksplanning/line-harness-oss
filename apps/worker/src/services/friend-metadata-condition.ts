export interface SqlFragment {
  sql: string;
  bindings: unknown[];
}

export type FriendMetadataPredicateOperator =
  | 'equals'
  | 'not_equals'
  | 'empty'
  | 'not_empty';

/**
 * Return the effective value used by friend metadata predicates.
 *
 * Cost bound for N friends, R metadata rules, and at most M keys in one
 * metadata object:
 *   - definition existence/default reads use the unique name index;
 *   - json_each is present exactly once per rule and scans only that friend's
 *     object, so the additional work is O(N * R * M), never O(N²) or
 *     O(N * number-of-definitions).
 *
 * The first CASE arm deliberately retains json_extract when no active
 * definition exists. The second retains it for SQL NULL and valid non-object
 * JSON. Invalid JSON still raises the same SQLite error through json_extract
 * or json_type. Only an active definition + valid object reaches json_each.
 * X'00' distinguishes an explicitly stored JSON null from a missing key so
 * COALESCE never replaces explicit null with the default.
 */
export function buildEffectiveFriendMetadataExpression(
  key: string,
  friendAlias = 'f',
): SqlFragment {
  const legacyPath = `$.${key}`;
  return {
    sql:
      `CASE ` +
      `WHEN NOT EXISTS (` +
      `SELECT 1 FROM friend_field_definitions d ` +
      `WHERE d.name = ? AND d.is_active = 1` +
      `) THEN json_extract(${friendAlias}.metadata, ?) ` +
      `WHEN COALESCE(json_type(${friendAlias}.metadata) != 'object', 1) ` +
      `THEN json_extract(${friendAlias}.metadata, ?) ` +
      `ELSE COALESCE(` +
      `(` +
      `SELECT CASE WHEN j.type = 'null' THEN X'00' ELSE j.value END ` +
      `FROM json_each(${friendAlias}.metadata) j ` +
      `WHERE j.key = ? LIMIT 1` +
      `), ` +
      `(` +
      `SELECT d.default_value FROM friend_field_definitions d ` +
      `WHERE d.name = ? AND d.is_active = 1 LIMIT 1` +
      `)` +
      `) END`,
    bindings: [key, legacyPath, legacyPath, key, key],
  };
}

/**
 * Build a custom-field predicate while evaluating the effective value once.
 *
 * Empty means a missing key, SQL/JSON null, or an empty string. An active
 * field definition's default is part of the effective value, so a non-empty
 * default makes a genuinely missing key "not empty". X'00' is the internal
 * sentinel returned for an explicitly stored JSON null.
 */
export function buildFriendMetadataPredicate(
  key: string,
  value: string | null,
  operator: FriendMetadataPredicateOperator,
  friendAlias = 'f',
): SqlFragment {
  const expression = buildEffectiveFriendMetadataExpression(key, friendAlias);
  if (operator === 'empty' || operator === 'not_empty') {
    const emptyExpression = `COALESCE((${expression.sql}), X'00')`;
    return {
      sql:
        operator === 'empty'
          ? `${emptyExpression} IN ('', X'00')`
          : `${emptyExpression} NOT IN ('', X'00')`,
      bindings: expression.bindings,
    };
  }
  return {
    sql:
      operator === 'equals'
        ? `(${expression.sql}) = ?`
        : `(${expression.sql}) IS NOT ?`,
    bindings: [...expression.bindings, value],
  };
}

/**
 * Runtime counterpart used by scenario-step conditions. Defaults apply only
 * to a valid JSON object with a genuinely absent key. All explicitly stored
 * values (including empty string and null) win.
 */
export async function getEffectiveFriendMetadataValue(
  db: D1Database,
  friendId: string,
  key: string,
): Promise<unknown> {
  const friend = await db
    .prepare('SELECT metadata FROM friends WHERE id = ?')
    .bind(friendId)
    .first<{ metadata: string | null }>();

  if (!friend || typeof friend.metadata !== 'string') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(friend.metadata);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const metadata = parsed as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(metadata, key)) return metadata[key];

  const definition = await db
    .prepare(
      `SELECT default_value FROM friend_field_definitions
       WHERE name = ? AND is_active = 1
       LIMIT 1`,
    )
    .bind(key)
    .first<{ default_value: string }>();
  return definition?.default_value;
}
