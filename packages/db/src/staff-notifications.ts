import { jstNow } from './utils.js';

// Channel names are validated by the worker's adapter registry. D1 deliberately
// stores an opaque string so adding an adapter never requires a destructive
// schema/type migration.
export type StaffNotificationChannelType = string;
export type StaffNotificationEvent = 'inquiry_received' | 'form_submitted';
export type StaffNotificationConfig = Record<string, unknown>;

export interface StaffNotificationDestination {
  id: string;
  lineAccountId: string;
  label: string;
  channelType: StaffNotificationChannelType;
  config: StaffNotificationConfig;
  notifyInquiry: boolean;
  notifyFormSubmission: boolean;
  notifyAutoReply: boolean;
  enabled: boolean;
  lineUserId: string | null;
  lineLinkCodeDigest: string | null;
  lineLinkCodeExpiresAt: string | null;
  lineLinkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StaffNotificationDestinationRow {
  id: string;
  line_account_id: string;
  label: string;
  channel_type: StaffNotificationChannelType;
  config_json: string;
  notify_inquiry: number;
  notify_form_submission: number;
  notify_auto_reply: number;
  enabled: number;
  line_user_id: string | null;
  line_link_code_digest: string | null;
  line_link_code_expires_at: string | null;
  line_linked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveStaffNotificationDestinationInput {
  id: string;
  lineAccountId: string;
  label: string;
  channelType: StaffNotificationChannelType;
  config: StaffNotificationConfig;
  notifyInquiry: boolean;
  notifyFormSubmission: boolean;
  notifyAutoReply: boolean;
  enabled: boolean;
}

function serializeDestination(
  row: StaffNotificationDestinationRow,
): StaffNotificationDestination {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    label: row.label,
    channelType: row.channel_type,
    config: JSON.parse(row.config_json) as StaffNotificationConfig,
    notifyInquiry: row.notify_inquiry === 1,
    notifyFormSubmission: row.notify_form_submission === 1,
    notifyAutoReply: row.notify_auto_reply === 1,
    enabled: row.enabled === 1,
    lineUserId: row.line_user_id,
    lineLinkCodeDigest: row.line_link_code_digest,
    lineLinkCodeExpiresAt: row.line_link_code_expires_at,
    lineLinkedAt: row.line_linked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createStaffNotificationDestination(
  db: D1Database,
  input: SaveStaffNotificationDestinationInput,
): Promise<StaffNotificationDestination> {
  const now = jstNow();
  const row = await db
    .prepare(
      `INSERT INTO staff_notification_destinations
         (id, line_account_id, label, channel_type, config_json,
          notify_inquiry, notify_form_submission, notify_auto_reply, enabled,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      input.id,
      input.lineAccountId,
      input.label,
      input.channelType,
      JSON.stringify(input.config),
      input.notifyInquiry ? 1 : 0,
      input.notifyFormSubmission ? 1 : 0,
      input.notifyAutoReply ? 1 : 0,
      input.enabled ? 1 : 0,
      now,
      now,
    )
    .first<StaffNotificationDestinationRow>();
  if (!row) throw new Error('Staff notification destination was not created');
  return serializeDestination(row);
}

export async function getStaffNotificationDestination(
  db: D1Database,
  lineAccountId: string,
  id: string,
): Promise<StaffNotificationDestination | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM staff_notification_destinations
        WHERE line_account_id = ? AND id = ?`,
    )
    .bind(lineAccountId, id)
    .first<StaffNotificationDestinationRow>();
  return row ? serializeDestination(row) : null;
}

export async function listStaffNotificationDestinations(
  db: D1Database,
  lineAccountId: string,
): Promise<StaffNotificationDestination[]> {
  const rows = await db
    .prepare(
      `SELECT *
         FROM staff_notification_destinations
        WHERE line_account_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(lineAccountId)
    .all<StaffNotificationDestinationRow>();
  return (rows.results ?? []).map(serializeDestination);
}

export async function updateStaffNotificationDestination(
  db: D1Database,
  input: SaveStaffNotificationDestinationInput,
): Promise<StaffNotificationDestination | null> {
  const row = await db
    .prepare(
      `UPDATE staff_notification_destinations
          SET label = ?,
              config_json = ?,
              notify_inquiry = ?,
              notify_form_submission = ?,
              notify_auto_reply = ?,
              enabled = ?,
              updated_at = ?
        WHERE line_account_id = ?
          AND id = ?
          AND channel_type = ?
       RETURNING *`,
    )
    .bind(
      input.label,
      JSON.stringify(input.config),
      input.notifyInquiry ? 1 : 0,
      input.notifyFormSubmission ? 1 : 0,
      input.notifyAutoReply ? 1 : 0,
      input.enabled ? 1 : 0,
      jstNow(),
      input.lineAccountId,
      input.id,
      input.channelType,
    )
    .first<StaffNotificationDestinationRow>();
  return row ? serializeDestination(row) : null;
}

export async function deleteStaffNotificationDestination(
  db: D1Database,
  lineAccountId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM staff_notification_destinations
        WHERE line_account_id = ? AND id = ?`,
    )
    .bind(lineAccountId, id)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function listSubscribedStaffNotificationDestinations(
  db: D1Database,
  lineAccountId: string,
  event: StaffNotificationEvent,
): Promise<StaffNotificationDestination[]> {
  const subscriptionColumn = event === 'inquiry_received'
    ? 'notify_inquiry'
    : 'notify_form_submission';
  const rows = await db
    .prepare(
      `SELECT *
         FROM staff_notification_destinations
        WHERE line_account_id = ?
          AND enabled = 1
          AND ${subscriptionColumn} = 1
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(lineAccountId)
    .all<StaffNotificationDestinationRow>();
  return (rows.results ?? []).map(serializeDestination);
}

export async function issueStaffNotificationLineLinkCode(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    codeDigest: string;
    expiresAt: string;
  },
): Promise<StaffNotificationDestination | null> {
  const row = await db
    .prepare(
      `UPDATE staff_notification_destinations
          SET line_link_code_digest = ?,
              line_link_code_expires_at = ?,
              updated_at = ?
        WHERE line_account_id = ?
          AND id = ?
          AND channel_type = 'line'
       RETURNING *`,
    )
    .bind(
      input.codeDigest,
      input.expiresAt,
      jstNow(),
      input.lineAccountId,
      input.id,
    )
    .first<StaffNotificationDestinationRow>();
  return row ? serializeDestination(row) : null;
}

export async function linkStaffNotificationLineByCode(
  db: D1Database,
  input: {
    lineAccountId: string;
    codeDigest: string;
    lineUserId: string;
    now?: string;
  },
): Promise<StaffNotificationDestination | null> {
  const now = input.now ?? jstNow();
  const row = await db
    .prepare(
      `UPDATE staff_notification_destinations
          SET line_user_id = ?,
              line_link_code_digest = NULL,
              line_link_code_expires_at = NULL,
              line_linked_at = ?,
              updated_at = ?
        WHERE line_account_id = ?
          AND channel_type = 'line'
          AND line_link_code_digest = ?
          AND line_link_code_expires_at > ?
       RETURNING *`,
    )
    .bind(
      input.lineUserId,
      now,
      now,
      input.lineAccountId,
      input.codeDigest,
      now,
    )
    .first<StaffNotificationDestinationRow>();
  return row ? serializeDestination(row) : null;
}

export async function unlinkStaffNotificationLine(
  db: D1Database,
  lineAccountId: string,
  id: string,
): Promise<StaffNotificationDestination | null> {
  const row = await db
    .prepare(
      `UPDATE staff_notification_destinations
          SET line_user_id = NULL,
              line_link_code_digest = NULL,
              line_link_code_expires_at = NULL,
              line_linked_at = NULL,
              updated_at = ?
        WHERE line_account_id = ?
          AND id = ?
          AND channel_type = 'line'
       RETURNING *`,
    )
    .bind(jstNow(), lineAccountId, id)
    .first<StaffNotificationDestinationRow>();
  return row ? serializeDestination(row) : null;
}

export async function findStaffNotificationLineDestinationByUserId(
  db: D1Database,
  lineAccountId: string,
  lineUserId: string,
): Promise<StaffNotificationDestination | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM staff_notification_destinations
        WHERE line_account_id = ?
          AND channel_type = 'line'
          AND line_user_id = ?
        LIMIT 1`,
    )
    .bind(lineAccountId, lineUserId)
    .first<StaffNotificationDestinationRow>();
  return row ? serializeDestination(row) : null;
}

export async function recordStaffNotificationDelivery(
  db: D1Database,
  input: {
    id: string;
    destinationId: string;
    eventType: string;
    status: 'success' | 'failed';
    errorCode?: string | null;
  },
): Promise<void> {
  const result = await db
    .prepare(
      `INSERT INTO staff_notification_delivery_logs
         (id, destination_id, line_account_id, event_type, status, error_code)
       SELECT ?, id, line_account_id, ?, ?, ?
         FROM staff_notification_destinations
        WHERE id = ?`,
    )
    .bind(
      input.id,
      input.eventType,
      input.status,
      input.errorCode ?? null,
      input.destinationId,
    )
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new Error('Staff notification delivery was not recorded');
  }
}
