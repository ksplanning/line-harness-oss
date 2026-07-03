export interface SegmentRule {
  type: 'tag_exists' | 'tag_not_exists' | 'metadata_equals' | 'metadata_not_equals' | 'ref_code' | 'is_following'
  value: string | boolean | { key: string; value: string }
}

export interface SegmentCondition {
  operator: 'AND' | 'OR'
  rules: SegmentRule[]
}

/**
 * Build the WHERE fragment (clause + bindings) for a segment condition, aliased
 * to `f` (matches `FROM friends f` in every caller). Extracted so /api/friends,
 * /api/segments/count, and segment-send can AND it structurally against an
 * account scope without string surgery.
 *
 * HIGH-2: when there is more than one rule the joined clause is wrapped in
 * parentheses. Without this, `f.line_account_id = ? AND tagA OR tagB` parses as
 * `(account AND tagA) OR tagB` and leaks friends from other accounts. Callers
 * that AND this fragment with an account condition rely on the grouping.
 */
export function buildSegmentWhere(condition: SegmentCondition): { clause: string; bindings: unknown[] } {
  const bindings: unknown[] = []
  const clauses: string[] = []

  for (const rule of condition.rules) {
    switch (rule.type) {
      case 'tag_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('tag_exists rule requires a string tag ID value')
        }
        clauses.push(
          `EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`,
        )
        bindings.push(rule.value)
        break
      }

      case 'tag_not_exists': {
        if (typeof rule.value !== 'string') {
          throw new Error('tag_not_exists rule requires a string tag ID value')
        }
        clauses.push(
          `NOT EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`,
        )
        bindings.push(rule.value)
        break
      }

      case 'metadata_equals': {
        if (
          typeof rule.value !== 'object' ||
          rule.value === null ||
          typeof (rule.value as { key: string; value: string }).key !== 'string' ||
          typeof (rule.value as { key: string; value: string }).value !== 'string'
        ) {
          throw new Error('metadata_equals rule requires { key: string; value: string }')
        }
        const mv = rule.value as { key: string; value: string }
        clauses.push(`json_extract(f.metadata, ?) = ?`)
        bindings.push(`$.${mv.key}`, mv.value)
        break
      }

      case 'metadata_not_equals': {
        if (
          typeof rule.value !== 'object' ||
          rule.value === null ||
          typeof (rule.value as { key: string; value: string }).key !== 'string' ||
          typeof (rule.value as { key: string; value: string }).value !== 'string'
        ) {
          throw new Error('metadata_not_equals rule requires { key: string; value: string }')
        }
        const mv = rule.value as { key: string; value: string }
        clauses.push(`(json_extract(f.metadata, ?) IS NULL OR json_extract(f.metadata, ?) != ?)`)
        bindings.push(`$.${mv.key}`, `$.${mv.key}`, mv.value)
        break
      }

      case 'ref_code': {
        if (typeof rule.value !== 'string') {
          throw new Error('ref_code rule requires a string value')
        }
        clauses.push(`f.ref_code = ?`)
        bindings.push(rule.value)
        break
      }

      case 'is_following': {
        if (typeof rule.value !== 'boolean') {
          throw new Error('is_following rule requires a boolean value')
        }
        clauses.push(`f.is_following = ?`)
        bindings.push(rule.value ? 1 : 0)
        break
      }

      default: {
        const exhaustive: never = rule.type
        throw new Error(`Unknown segment rule type: ${exhaustive}`)
      }
    }
  }

  if (clauses.length === 0) {
    return { clause: '1=1', bindings }
  }
  const separator = condition.operator === 'AND' ? ' AND ' : ' OR '
  const joined = clauses.join(separator)
  const clause = clauses.length > 1 ? `(${joined})` : joined
  return { clause, bindings }
}

/**
 * Full SELECT for a segment condition. Kept as the equivalence anchor for
 * buildSegmentWhere; internally delegates so the WHERE fragment is identical.
 */
export function buildSegmentQuery(condition: SegmentCondition): { sql: string; bindings: unknown[] } {
  const { clause, bindings } = buildSegmentWhere(condition)
  const sql = `SELECT f.id, f.line_user_id FROM friends f WHERE ${clause}`
  return { sql, bindings }
}
