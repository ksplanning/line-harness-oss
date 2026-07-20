export interface FaqPersonalContextFriend {
  friendId: string;
  lineAccountId: string;
  displayName: string | null;
  metadataJson: string;
}

export interface FaqPersonalContextFieldDefinition {
  id: string;
  name: string;
  defaultValue: string;
}

export interface FaqPersonalContextSubmission {
  submissionId: string;
  formId: string;
  friendId: string;
  formTitle: string;
  answersJson: string;
  submittedAt: string;
}

export interface FaqPersonalContextFieldMapping {
  formId: string;
  fieldId: string;
  fieldSlug: string | null;
  label: string;
}

export interface FaqPersonalContextData {
  friend: FaqPersonalContextFriend;
  fieldDefinitions: FaqPersonalContextFieldDefinition[];
  formalooSubmissions: FaqPersonalContextSubmission[];
  internalSubmissions: FaqPersonalContextSubmission[];
  fieldMappings: FaqPersonalContextFieldMapping[];
}

interface FriendRow {
  id: string;
  line_account_id: string | null;
  display_name: string | null;
  metadata: string;
}

interface FieldDefinitionRow {
  id: string;
  name: string;
  default_value: string;
}

interface SubmissionRow {
  id: string;
  form_id: string;
  friend_id: string | null;
  form_title: string;
  answers_json: string;
  submitted_at: string;
}

interface FieldMappingRow {
  form_id: string;
  id: string;
  formaloo_field_slug: string | null;
  label: string;
}

function boundedSubmissionLimit(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(10, Math.trunc(value)));
}

function mapSubmission(row: SubmissionRow): FaqPersonalContextSubmission {
  return {
    submissionId: row.id,
    formId: row.form_id,
    friendId: row.friend_id ?? '',
    formTitle: row.form_title || 'フォーム',
    answersJson: row.answers_json,
    submittedAt: row.submitted_at,
  };
}

/**
 * Read only rows structurally scoped to the exact questioner and LINE account.
 * The worker assemble layer repeats the friend-id assertions before exposing any
 * value to a prompt; this query boundary is the first, not the only, guard.
 */
export async function readFaqPersonalContextData(
  db: D1Database,
  input: { friendId: string; lineAccountId: string; submissionLimit: number },
): Promise<FaqPersonalContextData | null> {
  if (!input.friendId || !input.lineAccountId) return null;

  const friend = await db.prepare(
    `SELECT id, line_account_id, display_name, metadata
       FROM friends
      WHERE id = ? AND line_account_id = ?`,
  ).bind(input.friendId, input.lineAccountId).first<FriendRow>();
  if (!friend || friend.id !== input.friendId || friend.line_account_id !== input.lineAccountId) {
    return null;
  }

  const limit = boundedSubmissionLimit(input.submissionLimit);
  const [definitionResult, formalooResult, internalResult] = await Promise.all([
    db.prepare(
      `SELECT id, name, default_value
         FROM friend_field_definitions
        WHERE is_active = 1
        ORDER BY display_order ASC, id ASC`,
    ).all<FieldDefinitionRow>(),
    db.prepare(
      `SELECT submission.id, submission.form_id, submission.friend_id,
              form.title AS form_title, submission.answers_json, submission.submitted_at
         FROM formaloo_submissions submission
         JOIN formaloo_forms form ON form.id = submission.form_id
        WHERE submission.friend_id = ?
          AND submission.verified = 1
          AND (form.line_account_id = ? OR form.line_account_id IS NULL)
        ORDER BY julianday(submission.submitted_at) DESC, submission.id DESC
        LIMIT ?`,
    ).bind(input.friendId, input.lineAccountId, limit).all<SubmissionRow>(),
    db.prepare(
      `SELECT submission.id, submission.form_id, submission.friend_id,
              form.title AS form_title, submission.answers_json, submission.submitted_at
         FROM internal_form_submissions submission
         JOIN formaloo_forms form ON form.id = submission.form_id
        WHERE submission.friend_id = ?
          AND (form.line_account_id = ? OR form.line_account_id IS NULL)
        ORDER BY julianday(submission.submitted_at) DESC, submission.id DESC
        LIMIT ?`,
    ).bind(input.friendId, input.lineAccountId, limit).all<SubmissionRow>(),
  ]);

  const formalooSubmissions = formalooResult.results.map(mapSubmission);
  const internalSubmissions = internalResult.results.map(mapSubmission);
  const formIds = [...new Set([
    ...formalooSubmissions.map((row) => row.formId),
    ...internalSubmissions.map((row) => row.formId),
  ])];

  let fieldMappings: FaqPersonalContextFieldMapping[] = [];
  if (formIds.length > 0) {
    const placeholders = formIds.map(() => '?').join(',');
    const mappingResult = await db.prepare(
      `SELECT form_id, id, formaloo_field_slug, label
         FROM formaloo_field_map
        WHERE form_id IN (${placeholders})
        ORDER BY form_id ASC, position ASC, id ASC`,
    ).bind(...formIds).all<FieldMappingRow>();
    fieldMappings = mappingResult.results.map((row) => ({
      formId: row.form_id,
      fieldId: row.id,
      fieldSlug: row.formaloo_field_slug,
      label: row.label,
    }));
  }

  return {
    friend: {
      friendId: friend.id,
      lineAccountId: friend.line_account_id,
      displayName: friend.display_name,
      metadataJson: friend.metadata,
    },
    fieldDefinitions: definitionResult.results.map((row) => ({
      id: row.id,
      name: row.name,
      defaultValue: row.default_value,
    })),
    formalooSubmissions,
    internalSubmissions,
    fieldMappings,
  };
}

export interface RecordFaqPersonalContextAuditInput {
  lineAccountId: string;
  friendId: string;
  displayNameIncluded: boolean;
  customFieldIds: string[];
  formalooSubmissionCount: number;
  internalSubmissionCount: number;
  promptTokenEstimate: number;
  wasTruncated: boolean;
}

/** Store audit metadata only. This API deliberately has no personal-value fields. */
export async function recordFaqPersonalContextAudit(
  db: D1Database,
  input: RecordFaqPersonalContextAuditInput,
): Promise<string> {
  const id = crypto.randomUUID();
  const customFieldIds = [...new Set(input.customFieldIds.filter(Boolean))];
  await db.prepare(
    `INSERT INTO faq_personal_context_audit_log
       (id, line_account_id, friend_id, display_name_included,
        custom_field_ids_json, formaloo_submission_count,
        internal_submission_count, prompt_token_estimate, was_truncated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    input.lineAccountId,
    input.friendId,
    input.displayNameIncluded ? 1 : 0,
    JSON.stringify(customFieldIds),
    Math.max(0, Math.trunc(input.formalooSubmissionCount)),
    Math.max(0, Math.trunc(input.internalSubmissionCount)),
    Math.max(0, Math.trunc(input.promptTokenEstimate)),
    input.wasTruncated ? 1 : 0,
  ).run();
  return id;
}
