import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  deleteEmailSenderSettings,
  getEmailSenderSettings,
  saveEmailSenderSettings,
  setEmailSenderResendApiKey,
  setEmailSenderDomainState,
  type EmailSenderDnsRecord,
} from './email-sender-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(PKG_ROOT, 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(PKG_ROOT, 'migrations', file), 'utf8');
    for (const statement of sql
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      try {
        db.exec(statement);
      } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) {
          throw error;
        }
      }
    }
  }
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          params = args;
          return api;
        },
        async first<T>() {
          return (statement.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

const DNS_RECORDS: EmailSenderDnsRecord[] = [
  {
    record: 'SPF',
    type: 'MX',
    name: 'send',
    value: 'feedback-smtp.example.com',
    ttl: 'Auto',
    status: 'pending',
    priority: 10,
  },
  {
    record: 'DKIM',
    type: 'TXT',
    name: 'resend._domainkey',
    value: 'public-dkim-value',
    ttl: 'Auto',
    status: 'pending',
    priority: null,
  },
];

let raw: Database.Database;
let DB: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  replayAll(raw);
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret)
     VALUES
       ('account-1', 'channel-1', 'Account 1', 'token', 'secret'),
       ('account-2', 'channel-2', 'Account 2', 'token', 'secret')`,
  ).run();
  DB = d1(raw);
});

afterEach(() => {
  raw.close();
});

describe('email sender settings persistence', () => {
  test('returns null until settings are saved, then round-trips sender identity', async () => {
    expect(await getEmailSenderSettings(DB, 'account-1')).toBeNull();

    const saved = await saveEmailSenderSettings(DB, {
      lineAccountId: 'account-1',
      senderEmail: 'notice@example.com',
      senderName: 'お知らせ係',
      senderDomain: 'example.com',
    });

    expect(saved).toMatchObject({
      lineAccountId: 'account-1',
      senderEmail: 'notice@example.com',
      senderName: 'お知らせ係',
      senderDomain: 'example.com',
      resendDomainId: null,
      resendDomainStatus: 'not_started',
      dnsRecords: [],
      domainCheckedAt: null,
    });
    expect(saved.createdAt).toBeTruthy();
    expect(saved.updatedAt).toBeTruthy();
    expect(await getEmailSenderSettings(DB, 'account-1')).toEqual(saved);
    expect(await getEmailSenderSettings(DB, 'account-2')).toBeNull();
  });

  test('stores public DNS state and preserves it when the sender domain is unchanged', async () => {
    await saveEmailSenderSettings(DB, {
      lineAccountId: 'account-1',
      senderEmail: 'notice@example.com',
      senderName: null,
      senderDomain: 'example.com',
    });

    const checked = await setEmailSenderDomainState(DB, {
      lineAccountId: 'account-1',
      expectedSenderDomain: 'example.com',
      expectedResendDomainId: null,
      resendDomainId: 'domain_123',
      resendDomainStatus: 'pending',
      dnsRecords: DNS_RECORDS,
    });
    expect(checked).toMatchObject({
      resendDomainId: 'domain_123',
      resendDomainStatus: 'pending',
      dnsRecords: DNS_RECORDS,
    });
    expect(checked?.domainCheckedAt).toBeTruthy();

    const renamed = await saveEmailSenderSettings(DB, {
      lineAccountId: 'account-1',
      senderEmail: 'support@example.com',
      senderName: 'サポート',
      senderDomain: 'example.com',
    });
    expect(renamed).toMatchObject({
      senderEmail: 'support@example.com',
      senderName: 'サポート',
      resendDomainId: 'domain_123',
      resendDomainStatus: 'pending',
      dnsRecords: DNS_RECORDS,
      domainCheckedAt: checked?.domainCheckedAt,
    });
  });

  test('resets stale domain state when the sender domain changes', async () => {
    await saveEmailSenderSettings(DB, {
      lineAccountId: 'account-1',
      senderEmail: 'notice@example.com',
      senderName: null,
      senderDomain: 'example.com',
    });
    await setEmailSenderDomainState(DB, {
      lineAccountId: 'account-1',
      expectedSenderDomain: 'example.com',
      expectedResendDomainId: null,
      resendDomainId: 'domain_123',
      resendDomainStatus: 'verified',
      dnsRecords: DNS_RECORDS,
    });

    const changed = await saveEmailSenderSettings(DB, {
      lineAccountId: 'account-1',
      senderEmail: 'notice@example.net',
      senderName: null,
      senderDomain: 'example.net',
    });
    expect(changed).toMatchObject({
      senderDomain: 'example.net',
      resendDomainId: null,
      resendDomainStatus: 'not_started',
      dnsRecords: [],
      domainCheckedAt: null,
    });
  });

  test('returns null when setting domain state for an unconfigured account', async () => {
    expect(await setEmailSenderDomainState(DB, {
      lineAccountId: 'account-1',
      expectedSenderDomain: 'example.com',
      expectedResendDomainId: null,
      resendDomainId: 'domain_123',
      resendDomainStatus: 'pending',
      dnsRecords: DNS_RECORDS,
    })).toBeNull();
  });

  test('does not attach stale provider verification after the sender domain changes', async () => {
    await saveEmailSenderSettings(DB, {
      lineAccountId: 'account-1',
      senderEmail: 'notice@example.com',
      senderName: null,
      senderDomain: 'example.com',
    });

    await saveEmailSenderSettings(DB, {
      lineAccountId: 'account-1',
      senderEmail: 'notice@example.net',
      senderName: null,
      senderDomain: 'example.net',
    });

    expect(await setEmailSenderDomainState(DB, {
      lineAccountId: 'account-1',
      expectedSenderDomain: 'example.com',
      expectedResendDomainId: null,
      resendDomainId: 'domain_stale',
      resendDomainStatus: 'verified',
      dnsRecords: DNS_RECORDS,
    })).toBeNull();
    expect(await getEmailSenderSettings(DB, 'account-1')).toMatchObject({
      senderDomain: 'example.net',
      resendDomainId: null,
      resendDomainStatus: 'not_started',
      dnsRecords: [],
    });
  });

  test('deletes settings so callers can fall back to the environment sender', async () => {
    await saveEmailSenderSettings(DB, {
      lineAccountId: 'account-1',
      senderEmail: 'notice@example.com',
      senderName: null,
      senderDomain: 'example.com',
    });

    await deleteEmailSenderSettings(DB, 'account-1');
    expect(await getEmailSenderSettings(DB, 'account-1')).toBeNull();
  });

  test('round-trips and deletes Resend API keys without crossing LINE account boundaries', async () => {
    for (const accountId of ['account-1', 'account-2']) {
      await saveEmailSenderSettings(DB, {
        lineAccountId: accountId,
        senderEmail: `notice@${accountId}.example`,
        senderName: null,
        senderDomain: `${accountId}.example`,
      });
    }
    await setEmailSenderDomainState(DB, {
      lineAccountId: 'account-1',
      expectedSenderDomain: 'account-1.example',
      expectedResendDomainId: null,
      resendDomainId: 'domain_from_old_resend_account',
      resendDomainStatus: 'verified',
      dnsRecords: DNS_RECORDS,
    });

    await setEmailSenderResendApiKey(DB, 'account-1', 're_account_one');
    await setEmailSenderResendApiKey(DB, 'account-2', 're_account_two');

    expect(await getEmailSenderSettings(DB, 'account-1')).toMatchObject({
      lineAccountId: 'account-1',
      resendApiKey: 're_account_one',
      resendDomainId: null,
      resendDomainStatus: 'not_started',
      dnsRecords: [],
    });
    expect(await getEmailSenderSettings(DB, 'account-2')).toMatchObject({
      lineAccountId: 'account-2',
      resendApiKey: 're_account_two',
    });

    await setEmailSenderResendApiKey(DB, 'account-1', null);
    expect(await getEmailSenderSettings(DB, 'account-1')).toMatchObject({
      resendApiKey: null,
    });
    expect(await getEmailSenderSettings(DB, 'account-2')).toMatchObject({
      resendApiKey: 're_account_two',
    });
  });
});
