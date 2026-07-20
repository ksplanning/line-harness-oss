import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../../..');

describe('Google Sheets owner handoff documents', () => {
  test('10-minute guide covers Cloud setup, sharing, secret registration, UI test, and screenshot positions', () => {
    const guide = readFileSync(join(ROOT, 'docs/google-sheets-service-account-setup.md'), 'utf8');
    for (const required of [
      '10分',
      'Google Cloud',
      'Google Sheets API',
      'サービス アカウント',
      'JSON',
      '共有',
      '編集者',
      'GOOGLE_SERVICE_ACCOUNT_JSON',
      'wrangler secret put',
      '--config wrangler.ks.toml',
      '/settings/sheets',
      'スプレッドシート ID',
      'シート名',
      '接続テスト',
      'スクリーンショット',
    ]) {
      expect(guide).toContain(required);
    }
    expect(guide).toContain('同期エンジン')
    expect(guide).toContain('まだ実行しません')
    expect(guide).not.toMatch(/-----BEGIN PRIVATE KEY-----/)
  });

  test('host checklist requires one real read without recording secrets or cell values', () => {
    const checklist = readFileSync(join(ROOT, '.sola/live-checklist.md'), 'utf8');
    expect(checklist).toContain('# selfform-w4-sheets-foundation — host live checklist');
    expect(checklist).toContain('実サービスアカウント');
    expect(checklist).toContain('read 疎通を 1 回');
    expect(checklist).toContain('秘密値');
    expect(checklist).toContain('セル値');
  });

  test('owner summary explains the delivered foundation and deferred sync in plain language', () => {
    const summary = readFileSync(join(ROOT, '.sola/change-summary.md'), 'utf8');
    expect(summary).toContain('# selfform-w4-sheets-foundation — 変更概要');
    expect(summary).toContain('Google スプレッドシート');
    expect(summary).toContain('双方向');
    expect(summary).toContain('接続テスト');
    expect(summary).toContain('まだ自動同期は始まりません');
  });
});
