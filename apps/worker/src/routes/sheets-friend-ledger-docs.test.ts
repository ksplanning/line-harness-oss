import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../../..');
const SCRIPT_PATH = join(ROOT, 'docs/google-sheets-friend-ledger-onedit.gs');
const GUIDE_PATH = join(ROOT, 'docs/google-sheets-friend-ledger-sync-setup.md');

describe('Google Sheets friend ledger owner handoff documents', () => {
  test('the copy-once Apps Script installs an edit trigger and signs only a range notification', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8');

    for (const required of [
      'friendLedgerOnEdit',
      'ScriptApp.newTrigger',
      '.onEdit()',
      'PropertiesService.getScriptProperties',
      'UrlFetchApp.fetch',
      'Utilities.computeHmacSha256Signature',
      'X-Sheets-Signature',
      'X-Sheets-Timestamp',
      'SHEETS_WEBHOOK_SECRET',
      'Utilities.sleep',
    ]) {
      expect(script).toContain(required);
    }
    expect(script).toMatch(/JSON\.stringify\s*\(/);
    expect(script).not.toMatch(/\b(?:console|Logger)\.(?:log|info|warn|error)\s*\(/);
    expect(script).not.toContain('-----BEGIN PRIVATE KEY-----');
    expect(script).not.toContain('1bJCZHSqVSZstcFcI3c1xlEZKByNdbCMqGC4Sc9NtnGU');
    expect(script).not.toContain('U5217ceb4debd9849959446ce8f902a27');
  });

  test('the plain-language guide covers one paste, secret-safe setup, trigger install, test, and rollback', () => {
    const guide = readFileSync(GUIDE_PATH, 'utf8');

    for (const required of [
      '拡張機能',
      'Apps Script',
      '編集時',
      'SHEETS_WEBHOOK_SECRET',
      'wrangler secret put',
      '--config wrangler.ks.toml',
      '手動同期',
      '監査ログ',
      'トリガーを削除',
    ]) {
      expect(guide).toContain(required);
    }
    expect(guide).toMatch(/コピペ\s*1\s*回/);
    expect(guide).toMatch(/インストール(?:型|可能)/);
    expect(guide).toMatch(/スクリプト\s*プロパティ/);
    expect(guide).toContain('サービス アカウント');
    expect(guide).toContain('JSON');
    expect(guide).not.toMatch(/-----BEGIN PRIVATE KEY-----/);
    expect(guide).not.toContain('1bJCZHSqVSZstcFcI3c1xlEZKByNdbCMqGC4Sc9NtnGU');
    expect(guide).not.toContain('U5217ceb4debd9849959446ce8f902a27');
  });
});
