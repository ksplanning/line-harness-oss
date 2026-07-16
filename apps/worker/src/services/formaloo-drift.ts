// =============================================================================
// Formaloo 定義 drift の定期検知サービス (formaloo-auto-pull / owner 必須発注)
// -----------------------------------------------------------------------------
// 6h cron tick 内で、Formaloo 連携済み全 form の定義 fingerprint を baseline と比較し drift を検知。
// 安全な変更 (弱化 warnings ゼロ ∧ ローカル編集なし) は flag ON 時のみ自動反映 (D1 のみ / push しない)、
// 危険な変更 / ローカル競合 (out_of_sync) は通知のみ。API 失敗 form は baseline 不変で skip (fail-safe)。
//
// 設計原則 (spec §2-§4):
//  - fingerprint は raw Formaloo body を射影して算出 = field_map 非依存 (auto-apply churn で false re-fire しない)。
//  - auto-apply は saveFormalooDefinition (D1 のみ) だけ。pushDefinitionToFormaloo は import すらしない
//    (逆方向 push は excluded_scope / push ループ防止 = 構造的に呼べない)。
//  - out_of_sync (ローカル未 push 編集待機) は絶対に auto-apply しない (conflict_held / failure_observable の芯)。
//  - fail-safe: GET 失敗 / client 無 / read-shape 不一致 / 例外 の form は state 無書込で skip (baseline 不変)。
//  - dedup: 通知系は pending_remote_hash が前回と変わった時だけ履歴記録 (6h 毎の重複を防ぐ)。
// =============================================================================

import {
  listLinkedFormalooForms,
  getFormalooForm,
  getFormalooSyncState,
  setFormalooSyncState,
  getFormalooFieldMap,
  saveFormalooDefinition,
  recordFormalooDriftEvent,
  type FormalooForm,
} from '@line-crm/db';
import { formalooDefinitionFingerprint, countWeakenedFormalooRules, normalizeFormDesign, type FormDesign } from '@line-crm/shared';
import { buildPullResult, extractFieldsList, extractRawLogic, extractLogic } from './formaloo-pull.js';
import type { FormalooClient } from './formaloo-client.js';

/** drift 判定の 5 分岐 (+ bootstrap)。副作用なしの純関数が返す action。 */
export type DriftAction = 'bootstrapped' | 'none' | 'auto_applied' | 'notified' | 'conflict_held';

export interface DriftDecisionInput {
  /** formaloo_sync_state.remote_definition_hash (最後に合意した Formaloo 側 fingerprint / NULL=未 bootstrap)。 */
  baseline: string | null;
  /** 今回 GET した Formaloo 定義の fingerprint。 */
  fingerprint: string;
  /** 弱化 warnings (複合ロジック) を伴う定義か (countWeakenedFormalooRules>0)。 */
  weakened: boolean;
  /** 現在の sync_status (out_of_sync = ローカル未 push 編集待機 = 競合)。 */
  syncStatus: string;
  /** FORMALOO_DRIFT_AUTO_APPLY flag (案 A=ON / 案 B=OFF)。 */
  autoApplyEnabled: boolean;
}

/**
 * 純粋な drift 判定器 (副作用なし)。以下の優先順で action を決める:
 *   1. baseline 無 → bootstrapped (前状態を知らない → 現状を基準採用・発火しない fail-safe)。
 *   2. fingerprint == baseline → none (drift なし)。
 *   3. drift かつ sync_status != idle → conflict_held (ローカル編集待機 out_of_sync / PUT in-flight
 *      pushing・pulling / error = **idle 以外は絶対 auto-apply しない** = 最優先の安全ガード / F1 TOCTOU 封じ)。
 *   4. drift かつ weakened → notified (弱化は flag に依らず自動反映しない = 分岐ロジック欠落防止)。
 *   5. drift かつ clean かつ idle かつ autoApply ON → auto_applied。
 *   6. drift かつ clean かつ idle かつ autoApply OFF → notified (案 B 既定)。
 */
export function decideDriftAction(i: DriftDecisionInput): DriftAction {
  if (i.baseline == null) return 'bootstrapped';
  if (i.fingerprint === i.baseline) return 'none';
  // drift。sync_status が idle 以外 (out_of_sync / pushing / pulling / error) は in-flight or ローカル編集待機 or
  // 異常 = D1 定義を黙って上書きしない → 必ず conflict_held で surface (F1: PUT×cron TOCTOU の decide 側ガード)。
  if (i.syncStatus !== 'idle') return 'conflict_held';
  if (i.weakened) return 'notified';
  return i.autoApplyEnabled ? 'auto_applied' : 'notified';
}

// ─── runFormalooDriftCheck orchestration (T-B2 / T-B3 part2) ─────────────────

/** 1 tick で drift-check する form 数の上限 (Workers 1000-subrequest 予算保護 / R5)。 */
export const MAX_DRIFT_CHECKS_PER_TICK = 50;

export interface RunDriftCheckDeps {
  db: D1Database;
  /** form.workspace_id から Formaloo client を解決 (未配備 dev / 未登録は null → skip)。 */
  resolveClient: (workspaceId: string | null) => Promise<FormalooClient | null>;
  /** FORMALOO_DRIFT_AUTO_APPLY (案 A=ON / 案 B=OFF)。OFF でも検知/通知/バッジは動く。 */
  autoApplyEnabled: boolean;
  /** 時刻注入 (テスト用)。 */
  now?: () => Date;
  /** 1 tick の走査上限 (既定 MAX_DRIFT_CHECKS_PER_TICK)。 */
  maxChecks?: number;
}

export interface DriftCheckSummary {
  checked: number;      // GET まで到達した form 数
  bootstrapped: number;
  autoApplied: number;
  notified: number;     // 新規/変化した通知
  conflicts: number;    // 新規/変化した競合
  inSync: number;
  skipped: number;      // client 無 / GET 失敗 / read-shape 不一致 / 例外 (fail-safe)
}

/** definition_json から formalooAddress のみ取り出す (auto-apply で既存 address を保持)。 */
function parseFormalooAddress(definitionJson: string): string | null {
  try {
    const d = JSON.parse(definitionJson) as { formalooAddress?: unknown };
    return typeof d?.formalooAddress === 'string' ? d.formalooAddress : null;
  } catch {
    return null;
  }
}

/** definition_json から保存済み form-design を取り出す (auto-apply で design を carry / gap-check #2)。 */
function parseStoredDesign(definitionJson: string): FormDesign | undefined {
  try {
    const d = JSON.parse(definitionJson) as { design?: unknown };
    return d?.design && typeof d.design === 'object' && !Array.isArray(d.design)
      ? normalizeFormDesign(d.design)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * auto-apply: pull 結果を D1 のみに反映 (push しない)。field_map の formaloo_field_slug は
 * `existingMap[id] ?? fieldSlugById[id]` で carry (slug wipe → 重複 push 回帰を防ぐ / T-B3)。
 * rawLogic + logicFingerprint を definition_json に必ず carry (preserve-raw を落とさない)。
 * @returns true=D1 反映済 / false=変換不能で反映せず (呼び側で skip 扱い)。
 */
async function applyDriftToD1(
  db: D1Database,
  form: FormalooForm,
  body: unknown,
): Promise<boolean> {
  const map = await getFormalooFieldMap(db, form.id);
  const bySlug = new Map<string, string>();
  const existingFieldSlugs: Record<string, string> = {};
  for (const row of map) {
    if (row.formaloo_field_slug) {
      bySlug.set(row.formaloo_field_slug, row.id);
      existingFieldSlugs[row.id] = row.formaloo_field_slug;
    }
  }
  const pull = buildPullResult(body, (s) => bySlug.get(s) ?? s);
  if (!pull.ok) return false;

  // form-design carry (gap-check #2 BLOCKER): remote body の design を優先、無ければ local(保存済み)
  // design を保つ。carry しないと fields/logic だけの無関係 drift で保存済み design が消える。
  const localDesign = parseStoredDesign(form.definition_json);
  const design = pull.design && Object.keys(pull.design).length ? pull.design : localDesign;

  const definitionJson = JSON.stringify({
    fields: pull.fields,
    logic: pull.logic,
    formalooAddress: parseFormalooAddress(form.definition_json),
    ...(pull.rawLogic != null ? { rawLogic: pull.rawLogic } : {}),
    logicFingerprint: pull.logicFingerprint,
    ...(design && Object.keys(design).length ? { design } : {}),
  });
  const fieldRows = pull.fields.map((f) => ({
    id: f.id,
    formalooFieldSlug: existingFieldSlugs[f.id] ?? pull.fieldSlugById?.[f.id] ?? null, // T-B3 slug carry
    fieldType: f.type,
    label: f.label,
    position: f.position,
    configJson: JSON.stringify(f.config),
  }));
  // saveFormalooDefinition = D1 のみ (push しない)。逆方向 push は excluded_scope (本サービスは push を import しない)。
  await saveFormalooDefinition(db, form.id, { definitionJson, fields: fieldRows });
  return true;
}

/**
 * 6h cron tick 内で全連携 form の定義 drift を検知し、決定ポリシー (decideDriftAction) に沿って
 * 反映/通知/競合保留に振り分ける。form 単位 try/catch + allSettled で 1 form の失敗が tick 全体を止めない。
 * fail-safe: client 無 / GET 失敗 / read-shape 不一致 / 例外 の form は state 無書込で skip (baseline 不変)。
 */
export async function runFormalooDriftCheck(deps: RunDriftCheckDeps): Promise<DriftCheckSummary> {
  const now = deps.now ?? (() => new Date());
  const cap = deps.maxChecks ?? MAX_DRIFT_CHECKS_PER_TICK;
  const forms = (await listLinkedFormalooForms(deps.db)).slice(0, cap);
  const summary: DriftCheckSummary = {
    checked: 0, bootstrapped: 0, autoApplied: 0, notified: 0, conflicts: 0, inSync: 0, skipped: 0,
  };

  await Promise.allSettled(
    forms.map(async (form) => {
      try {
        const client = await deps.resolveClient(form.workspace_id);
        if (!client) { summary.skipped += 1; return; } // fail-safe: 無書込 skip

        const res = await client.get(`/v3.0/forms/${form.formaloo_slug}/`);
        if (!res.ok) { summary.skipped += 1; return; } // fail-safe: 無書込 skip

        const fieldsArr = extractFieldsList(res.data);
        if (fieldsArr === null) { summary.skipped += 1; return; } // read-shape 不一致 = fail-safe skip

        const rawLogic = extractRawLogic(res.data);
        const logicForFp: unknown = rawLogic != null ? rawLogic : extractLogic(res.data);
        const fp = await formalooDefinitionFingerprint(fieldsArr, logicForFp);
        const weakened = countWeakenedFormalooRules(rawLogic != null ? rawLogic : extractLogic(res.data)) > 0;

        summary.checked += 1;
        const sync = await getFormalooSyncState(deps.db, form.id);
        const baseline = sync?.remote_definition_hash ?? null;
        const syncStatus = sync?.sync_status ?? 'idle';
        const nowIso = now().toISOString();

        const action = decideDriftAction({ baseline, fingerprint: fp, weakened, syncStatus, autoApplyEnabled: deps.autoApplyEnabled });

        switch (action) {
          case 'bootstrapped': {
            await setFormalooSyncState(deps.db, form.id, {
              syncStatus, remoteDefinitionHash: fp, pendingRemoteHash: null, driftStatus: 'none', driftDetectedAt: null,
            });
            await recordFormalooDriftEvent(deps.db, { formId: form.id, action: 'bootstrapped', detectedAt: nowIso, remoteHash: fp, prevHash: null, syncStatusAt: syncStatus });
            summary.bootstrapped += 1;
            break;
          }
          case 'none': {
            // remote drift 解消 (Formaloo が baseline へ戻った) → 残った remote drift 状態を掃除
            // (sync_status=out_of_sync のローカル編集はそのまま維持 = drift_status は remote 軸で別)。
            if ((sync?.drift_status && sync.drift_status !== 'none') || sync?.pending_remote_hash != null) {
              await setFormalooSyncState(deps.db, form.id, { syncStatus, driftStatus: 'none', pendingRemoteHash: null, driftDetectedAt: null });
            }
            summary.inSync += 1;
            break;
          }
          case 'auto_applied': {
            // F1 CAS: decide 後・書込前に最新状態を再読込。listLinked の snapshot 以降に併走 PUT が
            // landed (updated_at 前進) / sync_status が idle でなくなった (PUT が 'pushing' へ先行遷移) 場合は
            // ローカル保存の silent 上書きを避けるため apply せず skip (次 tick が settled 状態で再評価)。
            const fresh = await getFormalooForm(deps.db, form.id);
            const freshSync = await getFormalooSyncState(deps.db, form.id);
            if (!fresh || fresh.deleted || fresh.updated_at !== form.updated_at || (freshSync?.sync_status ?? 'idle') !== 'idle') {
              summary.skipped += 1;
              break; // 併走保存/in-flight 検知 → 上書きしない (fail-safe)
            }
            const applied = await applyDriftToD1(deps.db, form, res.data);
            if (!applied) { summary.skipped += 1; break; } // 変換不能 = fail-safe skip (baseline 不変)
            await setFormalooSyncState(deps.db, form.id, {
              syncStatus: 'idle', lastPulledAt: nowIso,
              remoteDefinitionHash: fp, pendingRemoteHash: null, driftStatus: 'applied', driftDetectedAt: nowIso,
            });
            await recordFormalooDriftEvent(deps.db, { formId: form.id, action: 'auto_applied', detectedAt: nowIso, remoteHash: fp, prevHash: baseline, hasWarnings: false, syncStatusAt: syncStatus });
            summary.autoApplied += 1;
            break;
          }
          case 'notified': {
            // F3: 状態遷移 (drift_status/detectedAt/pending) は毎 tick 最新判定を反映し、履歴 event の
            // 記録だけを dedup する。新規 drift (pending 変化) or 遷移 (drift_status != detected = 例 conflict→detected)
            // の時だけ書込 + 記録。同一 status + 同一 fp の repeat は no-op (badge/audit は既に最新 = 固着しない)。
            const isNew = sync?.pending_remote_hash !== fp;
            const transitioned = (sync?.drift_status ?? 'none') !== 'detected';
            if (isNew || transitioned) {
              await setFormalooSyncState(deps.db, form.id, { syncStatus, driftStatus: 'detected', pendingRemoteHash: fp, driftDetectedAt: nowIso });
              await recordFormalooDriftEvent(deps.db, { formId: form.id, action: 'notified', detectedAt: nowIso, remoteHash: fp, prevHash: baseline, hasWarnings: weakened, syncStatusAt: syncStatus });
              summary.notified += 1;
            }
            break;
          }
          case 'conflict_held': {
            // F3: 同上。detected→conflict (同一 fp でも sync_status が out_of_sync 化) の遷移を毎 tick 反映。
            const isNew = sync?.pending_remote_hash !== fp;
            const transitioned = (sync?.drift_status ?? 'none') !== 'conflict';
            if (isNew || transitioned) {
              await setFormalooSyncState(deps.db, form.id, { syncStatus, driftStatus: 'conflict', pendingRemoteHash: fp, driftDetectedAt: nowIso });
              await recordFormalooDriftEvent(deps.db, { formId: form.id, action: 'conflict_held', detectedAt: nowIso, remoteHash: fp, prevHash: baseline, hasWarnings: weakened, syncStatusAt: syncStatus });
              summary.conflicts += 1;
            }
            break;
          }
        }
      } catch {
        summary.skipped += 1; // 例外 form も fail-safe skip (baseline 不変 / tick 全体は止めない)
      }
    }),
  );

  return summary;
}
