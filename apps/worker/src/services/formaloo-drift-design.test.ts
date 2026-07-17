/**
 * form-design × drift 回帰 (gap-check #2 BLOCKER): 6h drift auto-apply が definition_json を
 * 再構成する際に **保存済み form-design を消さない**。
 *  - remote body に design が無い fields/logic drift → local design を carry (消失しない)。
 *  - remote body に design がある → remote design を反映 (Formaloo が権威)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { formalooDefinitionFingerprint } from '@line-crm/shared';
import { saveFormalooDefinition, setFormalooSyncState, getFormalooForm } from '@line-crm/db';
import { runFormalooDriftCheck } from './formaloo-drift.js';
import { extractFieldsList, extractRawLogic, extractLogic } from './formaloo-pull.js';
import type { FormalooClient } from './formaloo-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}
function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}
function body(slug: string, fieldsList: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { data: { form: { slug, fields_list: fieldsList, logic: [], ...extra } } };
}
function rawField(slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { slug, type: 'short_text', title: '氏名', required: false, position: 0, ...over };
}
async function fpOf(b: unknown): Promise<string> {
  const fields = extractFieldsList(b);
  const rawLogic = extractRawLogic(b);
  return formalooDefinitionFingerprint(fields, rawLogic != null ? rawLogic : extractLogic(b));
}
function spyClient(bodyFor: () => unknown): FormalooClient {
  return {
    get: async () => ({ ok: true, status: 200, data: bodyFor() }),
    post: async () => ({ ok: true, status: 200, data: {} }),
    put: async () => ({ ok: true, status: 200, data: {} }),
    request: async () => ({ ok: true, status: 200, data: {} }),
    delete: async () => ({ ok: true, status: 200, data: {} }),
  } as unknown as FormalooClient;
}

let raw: Database.Database;
let DB: D1Database;

async function seedForm(id: string, slug: string, def: string) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, formaloo_slug, workspace_id, deleted) VALUES (?, ?, ?, ?, NULL, 0)`,
  ).run(id, id, def, slug);
  await saveFormalooDefinition(DB, id, {
    definitionJson: def,
    fields: [{ id: `${id}_q1`, formalooFieldSlug: 's_q1', fieldType: 'text', label: '氏名', position: 0, configJson: '{}' }],
  });
}

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });

describe('drift auto-apply は form-design を消さない (gap-check #2)', () => {
  it('remote に design が無い fields drift でも local design を carry する', async () => {
    const def = JSON.stringify({ fields: [], logic: [], design: { themeColor: '#06C755', logoUrl: 'https://s3/logo.png' } });
    await seedForm('f1', 's_form1', def);
    const v1 = body('s_form1', [rawField('s_q1', { title: '氏名' })]);
    const v2 = body('s_form1', [rawField('s_q1', { title: 'お名前' })]); // fields drift・design 無し
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', remoteDefinitionHash: await fpOf(v1), driftStatus: 'none' });

    const sum = await runFormalooDriftCheck({ db: DB, resolveClient: async () => spyClient(() => v2), autoApplyEnabled: true });
    expect(sum.autoApplied).toBe(1);

    const def2 = JSON.parse((await getFormalooForm(DB, 'f1'))!.definition_json);
    expect(def2.fields[0].label).toBe('お名前'); // drift 反映
    expect(def2.design.themeColor).toBe('#06C755'); // design 消えていない
    expect(def2.design.logoUrl).toBe('https://s3/logo.png');
  });

  it('remote に design がある場合は remote design を反映する (Formaloo 権威)', async () => {
    const def = JSON.stringify({ fields: [], logic: [], design: { themeColor: '#06C755' } });
    await seedForm('f2', 's_form2', def);
    const v1 = body('s_form2', [rawField('s_q1', { title: '氏名' })]);
    const v2 = body('s_form2', [rawField('s_q1', { title: 'お名前' })], { theme_color: '#285C66', logo: 'https://s3/remote-logo.png' });
    await setFormalooSyncState(DB, 'f2', { syncStatus: 'idle', remoteDefinitionHash: await fpOf(v1), driftStatus: 'none' });

    await runFormalooDriftCheck({ db: DB, resolveClient: async () => spyClient(() => v2), autoApplyEnabled: true });

    const def2 = JSON.parse((await getFormalooForm(DB, 'f2'))!.definition_json);
    expect(def2.design.themeColor).toBe('#285C66'); // remote 反映
    expect(def2.design.logoUrl).toBe('https://s3/remote-logo.png');
  });
});

describe('D-2 反映キー (theme/色) は fingerprint に入らない (cron false-drift ゼロ)', () => {
  const JR = (hex: string) => { const h = hex.replace('#', ''); return JSON.stringify({ r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }); };

  it('同一 fields/logic で top-level theme + 7 色 (JSON-string RGBA) だけ異なる 2 body → fingerprint 不変', async () => {
    const fields = [rawField('s_q1', { title: '氏名' }), rawField('s_q2', { title: 'メール', type: 'email', position: 1 })];
    // v1: 反映キーなし。v2: 本案件が push する theme string + 7 色 JSON-string RGBA + system_theme。fields/logic は同一。
    const v1 = body('s_form', fields);
    const v2 = body('s_form', fields, {
      theme: '9Qprc7Tn', system_theme: true,
      theme_color: JR('#06C755'), background_color: JR('#F4FBF7'), button_color: JR('#06C755'),
      text_color: JR('#17352A'), field_color: JR('#FFFFFF'), border_color: JR('#B7DCC8'), submit_text_color: JR('#FFFFFF'),
    });
    expect(await fpOf(v2)).toBe(await fpOf(v1)); // 反映キー追加は drift を起こさない
  });

  it('hex → JSON-string RGBA の色形式変更だけでも fingerprint 不変 (format 移行で誤 drift しない)', async () => {
    const fields = [rawField('s_q1', { title: '氏名' })];
    const vHex = body('s_form', fields, { button_color: '#06C755', text_color: '#17352A' });
    const vRgba = body('s_form', fields, { button_color: JR('#06C755'), text_color: JR('#17352A') });
    expect(await fpOf(vRgba)).toBe(await fpOf(vHex));
  });
});
