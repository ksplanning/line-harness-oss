import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { formalooDefinitionFingerprint } from '@line-crm/shared';
import { saveFormalooDefinition, setFormalooSyncState, getFormalooSyncState, listFormalooDriftEvents } from '@line-crm/db';
import { decideDriftAction, runFormalooDriftCheck } from './formaloo-drift.js';
import { checkSystemFieldHealth } from './formaloo-system-fields.js';
import type { FormalooClient } from './formaloo-client.js';

// =============================================================================
// fr-id-capture-fix / T-C5: drift/fingerprint は予約 friend system field を除外する (false-drift ゼロ)。
//   (1) system field 有無で fingerprint/drift 判定不変 — auto-push した hidden field が「未知 field」として
//       drift 誤検知・pull 逆流を起こさない (共通 projection = canonicalDefinitionProjection 経由)。
//   (3) 通常 drift とは別建ての system-field 健全性チェックが削除/visible化/型変更/重複を検知する。
// =============================================================================

const baseFields = [
  { slug: 's1', type: 'short_text', title: '名前', position: 0, required: true },
  { slug: 's2', type: 'email', title: 'メール', position: 1, required: false },
];

describe('fingerprint/drift system-field exclusion (T-C5(1))', () => {
  test('type=hidden の fr_id/fr_name を足しても fingerprint byte 不変 (false-drift ゼロ)', async () => {
    const fpBase = await formalooDefinitionFingerprint(baseFields, []);
    const withSys = [
      ...baseFields,
      { slug: 'h1', type: 'hidden', alias: 'fr_id', title: 'sys id', position: 2 },
      { slug: 'h2', type: 'hidden', alias: 'fr_name', title: 'sys name', position: 3 },
    ];
    expect(await formalooDefinitionFingerprint(withSys, [])).toBe(fpBase);
  });

  test('system field を先頭へ移して通常 field が再採番されても fingerprint byte 不変', async () => {
    const fpBase = await formalooDefinitionFingerprint(baseFields, []);
    const systemFirst = [
      { slug: 'h1', type: 'hidden', alias: 'fr_id', title: 'sys id', position: 0 },
      { slug: 'h2', type: 'hidden', alias: 'fr_name', title: 'sys name', position: 1 },
      { ...baseFields[0], position: 2 },
      { ...baseFields[1], position: 3 },
    ];
    expect(await formalooDefinitionFingerprint(systemFirst, [])).toBe(fpBase);
  });

  test('subset 型(short_text)の予約 alias でも fingerprint 不変 (type filter でなく alias filter が効く芯)', async () => {
    const fpBase = await formalooDefinitionFingerprint(baseFields, []);
    // 予約 alias を subset 型で作ると、alias 除外が無ければ fingerprint が変わってしまう = false-drift。
    const withSysSubset = [
      ...baseFields,
      { slug: 'h1', type: 'short_text', alias: 'fr_id', title: 'sys id', position: 2 },
    ];
    expect(await formalooDefinitionFingerprint(withSysSubset, [])).toBe(fpBase);
  });

  test('drift 判定: system field 追加後も baseline と一致 → decideDriftAction=none (誤検知しない)', async () => {
    const baseline = await formalooDefinitionFingerprint(baseFields, []);
    const withSys = [...baseFields, { slug: 'h1', type: 'hidden', alias: 'fr_id', title: 'x', position: 2 }];
    const fingerprint = await formalooDefinitionFingerprint(withSys, []);
    const action = decideDriftAction({ baseline, fingerprint, weakened: 0, syncStatus: 'idle', autoApplyEnabled: false });
    expect(action).toBe('none');
  });

  test('通常 field の変更は依然 fingerprint を変える (除外が通常 drift 検知を潰していない)', async () => {
    const fpBase = await formalooDefinitionFingerprint(baseFields, []);
    const changed = [{ ...baseFields[0], title: '氏名変更' }, baseFields[1]];
    expect(await formalooDefinitionFingerprint(changed, [])).not.toBe(fpBase);
  });

  test('fr-id-hardening-round2 ③: 通常 answer field に alias=slug を足しても fingerprint 不変 (alias 自動付与が false-drift を誘発しない)', async () => {
    const fpBase = await formalooDefinitionFingerprint(baseFields, []);
    // createField/backfill が付ける alias=slug は projectField が非射影ゆえ fingerprint を変えない = drift 誤検知ゼロ。
    const withAlias = baseFields.map((f) => ({ ...f, alias: f.slug }));
    expect(await formalooDefinitionFingerprint(withAlias, [])).toBe(fpBase);
  });
});

describe('system-field 健全性チェック (T-C5(3): drift とは別建て)', () => {
  test('exactly-one hidden なら健全 / 削除・visible化・重複を検知', () => {
    const healthy = [
      { slug: 'h1', alias: 'fr_id', type: 'hidden', position: 0 },
      { slug: 'h2', alias: 'fr_name', type: 'hidden', position: 1 },
      { ...baseFields[0], position: 2 },
      { ...baseFields[1], position: 3 },
    ];
    expect(checkSystemFieldHealth(healthy, { includeOwnerGated: true }).ok).toBe(true);

    // 削除 (fr_id 消失)
    expect(checkSystemFieldHealth(baseFields, { includeOwnerGated: false }).issues.find((i) => i.alias === 'fr_id')?.issue).toBe('missing');
    // visible 化 (型変更)
    expect(
      checkSystemFieldHealth([{ slug: 'h1', alias: 'fr_id', type: 'short_text' }], { includeOwnerGated: false }).issues.find((i) => i.alias === 'fr_id')?.issue,
    ).toBe('not_hidden');
  });
});

// =============================================================================
// fr-id-hardening-round2 / T-C5 配線: checkSystemFieldHealth を runFormalooDriftCheck の走行点に配線し、不健全なら
//   既存 drift 通知経路 (recordFormalooDriftEvent + drift_status detected) で surface する (dead code 解消)。
//   - systemFieldHealthCheck:true + fr_id 欠落 → summary.systemFieldUnhealthy>=1 + notified 1 件 + drift_status detected。
//   - flag 無 (default) → 発火 0 (既存 drift 挙動 byte 不変)。healthy form → 発火 0。dedup: 同一不健全 2 tick で 1 件。
// =============================================================================
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
function driftBody(slug: string, fieldsList: unknown[], logic: unknown[] = []): unknown {
  return { data: { form: { slug, fields_list: fieldsList, logic } } };
}
/** get のみ本物 (書込 spy は 0 回想定)。fields_list は raw Formaloo field 要素。 */
function getClient(bodyFor: (slug: string) => unknown) {
  const get = vi.fn(async (path: string) => {
    const slug = path.match(/forms\/([^/]+)\//)?.[1] ?? '';
    return { ok: true, status: 200, data: bodyFor(slug) };
  });
  const noop = vi.fn(async () => ({ ok: true, status: 200, data: {} }));
  return { get, post: noop, put: noop, request: noop, delete: noop } as unknown as FormalooClient;
}

let wRaw: Database.Database;
let WDB: D1Database;
async function seedLinked(id: string, slug: string, defJson = '{"fields":[],"logic":[]}') {
  wRaw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, formaloo_slug, workspace_id, deleted) VALUES (?, ?, ?, ?, NULL, 0)`,
  ).run(id, id, defJson, slug);
  await saveFormalooDefinition(WDB, id, {
    definitionJson: defJson,
    fields: [{ id: `${id}_q1`, formalooFieldSlug: 's1', fieldType: 'text', label: '名前', position: 0, configJson: '{}' }],
  });
}

const answerFields = [{ slug: 's1', type: 'short_text', title: '名前', position: 0, required: true }];
const withSysFields = [
  { slug: 'h1', type: 'hidden', alias: 'fr_id', title: 'sys id', position: 0 },
  { slug: 'h2', type: 'hidden', alias: 'fr_name', title: 'sys name', position: 1 },
  { ...answerFields[0], position: 2 },
];

describe('T-C5 配線: runFormalooDriftCheck × checkSystemFieldHealth', () => {
  beforeEach(() => {
    wRaw = new Database(':memory:');
    replayAll(wRaw);
    WDB = d1(wRaw);
  });

  test('systemFieldHealthCheck:true + fr_id 欠落 → summary.systemFieldUnhealthy + notified event + drift_status detected', async () => {
    await seedLinked('fh1', 's_form_h1');
    const client = getClient(() => driftBody('s_form_h1', answerFields)); // fr_id/fr_name 無し
    const deps = { db: WDB, resolveClient: async () => client, autoApplyEnabled: false, systemFieldHealthCheck: true, includeOwnerGatedSystemFields: true };
    // tick1: baseline null → bootstrapped (health は action==='none' のみ発火ゆえ bootstrap では発火しない)
    const s1 = await runFormalooDriftCheck(deps);
    expect(s1.bootstrapped).toBe(1);
    expect(s1.systemFieldUnhealthy).toBe(0);
    // tick2: fp==baseline → action='none' → health 発火 (fr_id/fr_name missing)
    const s2 = await runFormalooDriftCheck(deps);
    expect(s2.systemFieldUnhealthy).toBe(1);
    expect(s2.notified).toBe(1);
    const sync = await getFormalooSyncState(WDB, 'fh1');
    expect(sync?.drift_status).toBe('detected');
    const events = await listFormalooDriftEvents(WDB, 'fh1');
    const healthEvent = events.find((e) => e.detail === 'system_field_health');
    expect(healthEvent).toBeTruthy();
    expect(healthEvent?.action).toBe('notified');
  });

  test('flag 無 (default) → fr_id 欠落でも health 発火 0 (既存 drift 挙動 byte 不変)', async () => {
    await seedLinked('fh2', 's_form_h2');
    const client = getClient(() => driftBody('s_form_h2', answerFields));
    const deps = { db: WDB, resolveClient: async () => client, autoApplyEnabled: false }; // systemFieldHealthCheck 未指定
    await runFormalooDriftCheck(deps); // bootstrap
    const s2 = await runFormalooDriftCheck(deps);
    expect(s2.systemFieldUnhealthy).toBe(0);
    expect(s2.notified).toBe(0);
    expect(s2.inSync).toBe(1);
    const events = await listFormalooDriftEvents(WDB, 'fh2');
    expect(events.some((e) => e.detail === 'system_field_health')).toBe(false);
  });

  test('healthy form (fr_id/fr_name present) → systemFieldHealthCheck:true でも発火 0', async () => {
    await seedLinked('fh3', 's_form_h3');
    const client = getClient(() => driftBody('s_form_h3', withSysFields));
    const deps = { db: WDB, resolveClient: async () => client, autoApplyEnabled: false, systemFieldHealthCheck: true, includeOwnerGatedSystemFields: true };
    await runFormalooDriftCheck(deps); // bootstrap
    const s2 = await runFormalooDriftCheck(deps);
    expect(s2.systemFieldUnhealthy).toBe(0);
    expect(s2.inSync).toBe(1); // SP 無し + health 健全 = in-sync
    const events = await listFormalooDriftEvents(WDB, 'fh3');
    expect(events.some((e) => e.detail === 'system_field_health')).toBe(false);
  });

  test('dedup: 同一不健全を 2 tick 連続 → notified 履歴 1 件のみ (sysfield: pending prefix)', async () => {
    await seedLinked('fh4', 's_form_h4');
    const client = getClient(() => driftBody('s_form_h4', answerFields));
    const deps = { db: WDB, resolveClient: async () => client, autoApplyEnabled: false, systemFieldHealthCheck: true, includeOwnerGatedSystemFields: true };
    await runFormalooDriftCheck(deps); // bootstrap
    await runFormalooDriftCheck(deps); // 1st detect → 1 event
    const s3 = await runFormalooDriftCheck(deps); // 2nd tick same unhealthy → dedup
    expect(s3.systemFieldUnhealthy).toBe(1); // 観測は毎 tick
    expect(s3.notified).toBe(0); // 記録は dedup
    const events = await listFormalooDriftEvents(WDB, 'fh4');
    expect(events.filter((e) => e.detail === 'system_field_health')).toHaveLength(1);
  });

  test('logicConflict: fr_id が is_answered→submit host より後ろ → systemFieldUnhealthy', async () => {
    await seedLinked('fh5', 's_form_h5');
    const misplacedFields = [
      { slug: 's1', type: 'short_text', title: '名前', position: 0, required: true },
      { slug: 'h1', type: 'hidden', alias: 'fr_id', title: 'sys id', position: 2 },
      { slug: 'h2', type: 'hidden', alias: 'fr_name', title: 'sys name', position: 3 },
    ];
    const logic = [{
      type: 'field', identifier: 's1',
      actions: [{ action: 'submit', args: [], when: { operation: 'is_answered', args: [{ type: 'field', value: 's1' }] } }],
    }];
    const client = getClient(() => driftBody('s_form_h5', misplacedFields, logic));
    const deps = { db: WDB, resolveClient: async () => client, autoApplyEnabled: false, systemFieldHealthCheck: true, includeOwnerGatedSystemFields: true };
    await runFormalooDriftCheck(deps); // bootstrap (fp は logic 含む)
    const s2 = await runFormalooDriftCheck(deps);
    expect(s2.systemFieldUnhealthy).toBe(1); // field は健全でも logic 破棄で不健全判定
    const events = await listFormalooDriftEvents(WDB, 'fh5');
    const healthEvent = events.find((e) => e.detail === 'system_field_health');
    expect(healthEvent).toBeTruthy();
    expect(healthEvent?.warnings_json ?? '').toContain('fr_id');
    expect(healthEvent?.warnings_json ?? '').toContain('トリガー位置以降');
    expect(healthEvent?.warnings_json ?? '').toContain('先頭');
  });

  // P2 [Important reviewer R1]: system field 不健全時に early-return して SP 本文 drift をマスクしない。両 signal を
  //   同 tick で surface する (system field 不健全 ∧ SP 本文 drift 有りの form で両方 = fr_id issue + 完了ページ変更)。
  test('P2: system field 不健全 ∧ SP 本文 drift 有り → 両方を同 tick で surface (SP をマスクしない)', async () => {
    // stored 定義に SP(sp1/OLD)。remote は SP(sp1/NEW=本文変更) + fr_id 欠落 (health 不健全)。
    const defJson = JSON.stringify({ fields: [], logic: [], successPages: [{ id: 'sp1', slug: 'sp1', title: 'OLD 完了' }] });
    await seedLinked('fh6', 's_form_h6', defJson);
    const remote = () => driftBody('s_form_h6', [
      ...answerFields, // fr_id/fr_name 無し = health 不健全
      { slug: 'sp1', type: 'success_page', title: 'NEW 完了', position: 5 }, // SP 本文変更 = SP drift
    ]);
    const client = getClient(remote);
    const deps = { db: WDB, resolveClient: async () => client, autoApplyEnabled: false, systemFieldHealthCheck: true, includeOwnerGatedSystemFields: true };
    await runFormalooDriftCheck(deps); // bootstrap
    const s2 = await runFormalooDriftCheck(deps);
    // 両 signal が同 tick で surface: health 計上 + drift_status detected + 1 event に fr_id issue と 完了ページ変更 の両方
    expect(s2.systemFieldUnhealthy).toBe(1);
    const sync = await getFormalooSyncState(WDB, 'fh6');
    expect(sync?.drift_status).toBe('detected');
    const events = await listFormalooDriftEvents(WDB, 'fh6');
    const ev = events.find((e) => e.detail === 'system_field_health');
    expect(ev).toBeTruthy();
    expect(ev?.warnings_json ?? '').toContain('fr_id');       // health signal
    expect(ev?.warnings_json ?? '').toContain('完了ページ');    // SP signal (旧 early-return では欠落=マスク)
  });
});
