import { jstNow } from './utils.js';

export interface EmailSenderDnsRecord {
  record: string | null;
  type: string;
  name: string;
  value: string;
  ttl: string | null;
  status: string | null;
  priority: number | null;
}

export interface EmailSenderSettings {
  lineAccountId: string;
  senderEmail: string;
  senderName: string | null;
  senderDomain: string;
  resendDomainId: string | null;
  resendDomainStatus: string;
  dnsRecords: EmailSenderDnsRecord[];
  domainCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EmailSenderSettingsRow {
  line_account_id: string;
  sender_email: string;
  sender_name: string | null;
  sender_domain: string;
  resend_domain_id: string | null;
  resend_domain_status: string;
  dns_records_json: string;
  domain_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveEmailSenderSettingsInput {
  lineAccountId: string;
  senderEmail: string;
  senderName: string | null;
  senderDomain: string;
}

export interface SetEmailSenderDomainStateInput {
  lineAccountId: string;
  expectedSenderDomain: string;
  expectedResendDomainId: string | null;
  resendDomainId: string | null;
  resendDomainStatus: string;
  dnsRecords: EmailSenderDnsRecord[];
}

function serializeSettings(
  row: EmailSenderSettingsRow,
): EmailSenderSettings {
  return {
    lineAccountId: row.line_account_id,
    senderEmail: row.sender_email,
    senderName: row.sender_name,
    senderDomain: row.sender_domain,
    resendDomainId: row.resend_domain_id,
    resendDomainStatus: row.resend_domain_status,
    dnsRecords: JSON.parse(row.dns_records_json) as EmailSenderDnsRecord[],
    domainCheckedAt: row.domain_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getEmailSenderSettings(
  db: D1Database,
  lineAccountId: string,
): Promise<EmailSenderSettings | null> {
  const row = await db
    .prepare(
      `SELECT *
         FROM email_sender_settings
        WHERE line_account_id = ?`,
    )
    .bind(lineAccountId)
    .first<EmailSenderSettingsRow>();
  return row ? serializeSettings(row) : null;
}

export async function saveEmailSenderSettings(
  db: D1Database,
  input: SaveEmailSenderSettingsInput,
): Promise<EmailSenderSettings> {
  const now = jstNow();
  const row = await db
    .prepare(
      `INSERT INTO email_sender_settings
         (line_account_id, sender_email, sender_name, sender_domain,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(line_account_id) DO UPDATE SET
         sender_email = excluded.sender_email,
         sender_name = excluded.sender_name,
         sender_domain = excluded.sender_domain,
         resend_domain_id = CASE
           WHEN email_sender_settings.sender_domain = excluded.sender_domain
             THEN email_sender_settings.resend_domain_id
           ELSE NULL
         END,
         resend_domain_status = CASE
           WHEN email_sender_settings.sender_domain = excluded.sender_domain
             THEN email_sender_settings.resend_domain_status
           ELSE 'not_started'
         END,
         dns_records_json = CASE
           WHEN email_sender_settings.sender_domain = excluded.sender_domain
             THEN email_sender_settings.dns_records_json
           ELSE '[]'
         END,
         domain_checked_at = CASE
           WHEN email_sender_settings.sender_domain = excluded.sender_domain
             THEN email_sender_settings.domain_checked_at
           ELSE NULL
         END,
         updated_at = excluded.updated_at
       RETURNING *`,
    )
    .bind(
      input.lineAccountId,
      input.senderEmail,
      input.senderName,
      input.senderDomain,
      now,
      now,
    )
    .first<EmailSenderSettingsRow>();
  if (!row) throw new Error('Email sender settings were not saved');
  return serializeSettings(row);
}

export async function setEmailSenderDomainState(
  db: D1Database,
  input: SetEmailSenderDomainStateInput,
): Promise<EmailSenderSettings | null> {
  const now = jstNow();
  const row = await db
    .prepare(
      `UPDATE email_sender_settings
          SET resend_domain_id = ?,
              resend_domain_status = ?,
              dns_records_json = ?,
              domain_checked_at = ?,
              updated_at = ?
        WHERE line_account_id = ?
          AND sender_domain = ?
          AND (
            (? IS NULL AND resend_domain_id IS NULL)
            OR resend_domain_id = ?
          )
       RETURNING *`,
    )
    .bind(
      input.resendDomainId,
      input.resendDomainStatus,
      JSON.stringify(input.dnsRecords),
      now,
      now,
      input.lineAccountId,
      input.expectedSenderDomain,
      input.expectedResendDomainId,
      input.expectedResendDomainId,
    )
    .first<EmailSenderSettingsRow>();
  return row ? serializeSettings(row) : null;
}

export async function deleteEmailSenderSettings(
  db: D1Database,
  lineAccountId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM email_sender_settings WHERE line_account_id = ?`)
    .bind(lineAccountId)
    .run();
}
