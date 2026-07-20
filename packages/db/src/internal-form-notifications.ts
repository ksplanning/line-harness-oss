import { jstNow } from './utils.js';

export interface InternalFormNotificationSettings {
  formId: string;
  enabled: boolean;
  recipientEmailFieldId: string | null;
  messageTemplate: string | null;
  editLinkEpoch: number;
  createdAt: string;
  updatedAt: string;
}

interface InternalFormNotificationSettingsRow {
  form_id: string;
  enabled: number;
  recipient_email_field_id: string | null;
  message_template: string | null;
  edit_link_epoch: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertInternalFormNotificationSettingsInput {
  formId: string;
  enabled: boolean;
  recipientEmailFieldId: string | null;
  messageTemplate: string | null;
}

function serializeSettings(
  row: InternalFormNotificationSettingsRow,
): InternalFormNotificationSettings {
  return {
    formId: row.form_id,
    enabled: row.enabled === 1,
    recipientEmailFieldId: row.recipient_email_field_id,
    messageTemplate: row.message_template,
    editLinkEpoch: row.edit_link_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getInternalFormNotificationSettings(
  db: D1Database,
  formId: string,
): Promise<InternalFormNotificationSettings | null> {
  const row = await db
    .prepare('SELECT * FROM internal_form_notification_settings WHERE form_id = ?')
    .bind(formId)
    .first<InternalFormNotificationSettingsRow>();
  return row ? serializeSettings(row) : null;
}

export async function upsertInternalFormNotificationSettings(
  db: D1Database,
  input: UpsertInternalFormNotificationSettingsInput,
): Promise<InternalFormNotificationSettings> {
  const now = jstNow();
  const row = await db
    .prepare(
      `INSERT INTO internal_form_notification_settings
         (form_id, enabled, recipient_email_field_id, message_template, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(form_id) DO UPDATE SET
         enabled = excluded.enabled,
         recipient_email_field_id = excluded.recipient_email_field_id,
         message_template = excluded.message_template,
         updated_at = excluded.updated_at
       RETURNING *`,
    )
    .bind(
      input.formId,
      input.enabled ? 1 : 0,
      input.recipientEmailFieldId,
      input.messageTemplate,
      now,
      now,
    )
    .first<InternalFormNotificationSettingsRow>();
  if (!row) throw new Error('Internal form notification settings were not saved');
  return serializeSettings(row);
}

export async function bumpInternalFormEditLinkEpoch(
  db: D1Database,
  formId: string,
): Promise<number> {
  const now = jstNow();
  const row = await db
    .prepare(
      `INSERT INTO internal_form_notification_settings
         (form_id, edit_link_epoch, created_at, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(form_id) DO UPDATE SET
         edit_link_epoch = internal_form_notification_settings.edit_link_epoch + 1,
         updated_at = excluded.updated_at
       RETURNING edit_link_epoch`,
    )
    .bind(formId, now, now)
    .first<{ edit_link_epoch: number }>();
  if (!row) throw new Error('Internal form edit-link epoch was not bumped');
  return row.edit_link_epoch;
}
