import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(__dirname, '../..');
const INDEX_PATH = join(WORKER_ROOT, 'src/index.ts');
const CONFIG_PATHS = [
  join(WORKER_ROOT, 'wrangler.toml'),
  join(WORKER_ROOT, 'wrangler.ks.toml'),
  join(WORKER_ROOT, 'wrangler.piecemaker.toml'),
];
const EXPECTED_CRONS = ['*/5 * * * *', '0 */6 * * *'];

function cronLists(source: string): string[][] {
  return Array.from(source.matchAll(/^crons\s*=\s*\[([^\]]*)\]/gm), (match) =>
    Array.from(match[1].matchAll(/"([^"]+)"/g), (entry) => entry[1]),
  );
}

describe('friend ledger durable job cron wiring', () => {
  test('keeps every deployed config on the existing five-minute and six-hour triggers only', () => {
    for (const configPath of CONFIG_PATHS) {
      const source = readFileSync(configPath, 'utf8');
      const lists = cronLists(source);
      expect(lists.length, configPath).toBeGreaterThan(0);
      expect(lists.every((items) => JSON.stringify(items) === JSON.stringify(EXPECTED_CRONS)), configPath).toBe(true);
      expect(source, configPath).not.toMatch(/^\s*(?:SHEETS_WEBHOOK_SECRET|GOOGLE_SERVICE_ACCOUNT_JSON)\s*=/m);
    }
  });

  test('enqueues bounded durable jobs and processes an inline batch from the five-minute branch', () => {
    const source = readFileSync(INDEX_PATH, 'utf8');

    expect(source).toMatch(
      /import\s*\{[^}]*enqueueSheetsSyncPollingJobs[^}]*\}\s*from\s*['"]\.\/services\/sheets-sync-jobs\.js['"]/s,
    );
    expect(source).toMatch(
      /import\s*\{[^}]*processSheetsSyncJobBatch[^}]*SHEETS_SYNC_MAX_INLINE_CHUNKS[^}]*\}\s*from\s*['"]\.\/services\/sheets-sync-jobs\.js['"]/s,
    );
    expect(source).toMatch(
      /import\s*\{[^}]*maintainFriendLedgerWebhookEvents[^}]*\}\s*from\s*['"]\.\/services\/friend-ledger-sync\.js['"]/s,
    );
    expect(source).toMatch(
      /event\.cron\s*===\s*['"]\*\/5 \* \* \* \*['"][\s\S]{0,5000}enqueueSheetsSyncPollingJobs\s*\(\s*env\.DB\s*,\s*10\s*\)[\s\S]{0,500}jobs\.runnable\s*>\s*0[\s\S]{0,500}processSheetsSyncJobBatch\s*\(\s*\{[\s\S]{0,500}trigger:\s*['"]cron['"]/,
    );
    expect(source).toMatch(
      /event\.cron\s*===\s*['"]\*\/5 \* \* \* \*['"][\s\S]{0,5000}maintainFriendLedgerWebhookEvents\s*\(\s*env\.DB\s*\)/,
    );
    expect(source).not.toMatch(/runFriendLedgerPolling\s*\(/);
    expect(source).not.toMatch(/dispatchSheetsSyncWork/);
  });

  test('does not log webhook/service-account secrets or friend PII from the cron entrypoint', () => {
    const source = readFileSync(INDEX_PATH, 'utf8');
    const consoleCalls = Array.from(
      source.matchAll(/console\.(?:log|info|warn|error)\s*\(([\s\S]*?)\);/g),
      (match) => match[1],
    ).join('\n');

    expect(consoleCalls).not.toMatch(
      /SHEETS_WEBHOOK_SECRET|GOOGLE_SERVICE_ACCOUNT_JSON|display_name|line_user_id|metadata|beforeValue|afterValue/,
    );
  });
});
