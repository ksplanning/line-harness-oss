/**
 * T-C6 db model — sender_presets write/read が account-scoped であることの実 SQLite 検証。
 *  - create → getById が自 account でのみ引ける (別 account は null)
 *  - list は account-scoped / update・delete も account-scoped (別 account では no-op)
 *  - 作成した preset id が broadcasts.sender_preset_id から参照できる
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  createSenderPreset,
  getSenderPresetById,
  listSenderPresets,
  updateSenderPreset,
  deleteSenderPreset,
  resolveSenderForBroadcast,
} from './sender-presets.js';
import { createBroadcast } from './broadcasts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(PKG_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...a: unknown[]) { params = a; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
  for (const a of ['acc-1', 'acc-2']) {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?,?,?,?,?)`).run(a, `ch-${a}`, a, 'tok', 'sec');
  }
});

describe('sender_presets db model (account-scoped)', () => {
  test('create → getById is account-scoped (foreign account gets null)', async () => {
    const p = await createSenderPreset(db, { accountId: 'acc-1', name: '担当A', iconUrl: 'https://x/i.png' });
    expect(p.id).toBeTruthy();
    expect((await getSenderPresetById(db, p.id, 'acc-1'))?.name).toBe('担当A');
    expect(await getSenderPresetById(db, p.id, 'acc-2')).toBeNull();
  });

  test('list is account-scoped', async () => {
    await createSenderPreset(db, { accountId: 'acc-1', name: 'A' });
    await createSenderPreset(db, { accountId: 'acc-2', name: 'B' });
    expect((await listSenderPresets(db, 'acc-1')).map((p) => p.name)).toEqual(['A']);
    expect((await listSenderPresets(db, 'acc-2')).map((p) => p.name)).toEqual(['B']);
  });

  test('update/delete are account-scoped (foreign account = no-op)', async () => {
    const p = await createSenderPreset(db, { accountId: 'acc-1', name: 'A' });
    // 別 account からの update は効かない。
    await updateSenderPreset(db, p.id, 'acc-2', { name: 'HACKED' });
    expect((await getSenderPresetById(db, p.id, 'acc-1'))?.name).toBe('A');
    // 別 account からの delete も効かない。
    await deleteSenderPreset(db, p.id, 'acc-2');
    expect(await getSenderPresetById(db, p.id, 'acc-1')).not.toBeNull();
    // 自 account の update/delete は効く。
    await updateSenderPreset(db, p.id, 'acc-1', { name: 'A2', iconUrl: 'https://x/i2.png' });
    expect((await getSenderPresetById(db, p.id, 'acc-1'))?.name).toBe('A2');
    await deleteSenderPreset(db, p.id, 'acc-1');
    expect(await getSenderPresetById(db, p.id, 'acc-1')).toBeNull();
  });

  test('created preset id is referenceable from broadcasts.sender_preset_id + resolves to sender', async () => {
    const p = await createSenderPreset(db, { accountId: 'acc-1', name: '春担当', iconUrl: 'https://x/i.png' });
    const b = await createBroadcast(db, { title: 'T', messageType: 'text', messageContent: 'hi', targetType: 'all', senderPresetId: p.id });
    expect(b.sender_preset_id).toBe(p.id);
    const sender = await resolveSenderForBroadcast(db, b.sender_preset_id, 'acc-1');
    expect(sender).toEqual({ name: '春担当', iconUrl: 'https://x/i.png' });
    // 別 account では解決されない (なりすまし不可)。
    expect(await resolveSenderForBroadcast(db, b.sender_preset_id, 'acc-2')).toBeUndefined();
  });
});
