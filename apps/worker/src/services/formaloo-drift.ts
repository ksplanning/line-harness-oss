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
import { formalooDefinitionFingerprint, countWeakenedFormalooRules, normalizeFormDesign, normalizeSuccessPages, type FormDesign, type FormDisplayType, type SuccessPageSpec } from '@line-crm/shared';
import { buildPullResult, extractFieldsList, extractRawLogic, extractLogic, extractSuccessPages } from './formaloo-pull.js';
import { checkSystemFieldHealth } from './formaloo-system-fields.js';
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
  /**
   * fr-id-hardening-round2 / T-C5 配線: friend system field 健全性チェック (fr_id/fr_name の削除/visible化/重複/
   * logic 破棄) を drift 走行点で実行し、不健全なら既存 drift 通知経路で surface するか。default false = 既存挙動
   * byte 不変 (既存 drift test は未指定ゆえ発火 0)。scheduler は `FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE!=='1'` を渡す
   * (autopush 無効テナントでは fr_id 不在が正常ゆえ false alarm を出さない)。
   */
  systemFieldHealthCheck?: boolean;
  /** fr_name (PII owner-gate) も健全性対象にするか。default true。scheduler は `FORMALOO_FR_NAME_AUTOPUSH_DISABLE!=='1'`。 */
  includeOwnerGatedSystemFields?: boolean;
}

export interface DriftCheckSummary {
  checked: number;      // GET まで到達した form 数
  bootstrapped: number;
  autoApplied: number;
  notified: number;     // 新規/変化した通知
  conflicts: number;    // 新規/変化した競合
  inSync: number;
  skipped: number;      // client 無 / GET 失敗 / read-shape 不一致 / 例外 (fail-safe)
  systemFieldUnhealthy: number; // T-C5: fr_id/fr_name の削除/visible化/重複/logic破棄を検知した form 数 (観測用・dedup 非依存)
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

/** definition_json から保存済み formType を取り出す (form-route-branching: auto-apply で form_type を carry)。 */
function parseStoredFormType(definitionJson: string): FormDisplayType | undefined {
  try {
    const d = JSON.parse(definitionJson) as { formType?: unknown };
    return d?.formType === 'simple' || d?.formType === 'multi_step' ? d.formType : undefined;
  } catch {
    return undefined;
  }
}

/** definition_json から保存済み successPages を取り出す (route-terminal-phase2: drift auto-apply で carry)。 */
function parseStoredSuccessPages(definitionJson: string): SuccessPageSpec[] {
  try {
    const d = JSON.parse(definitionJson) as { successPages?: unknown };
    return normalizeSuccessPages(d?.successPages);
  } catch {
    return [];
  }
}

/**
 * drift carry: local の harness id/slug を保ちつつ remote pull の title/description を **slug で** 反映する
 *   (route-terminal-phase2 T-E5 / CX-1: SP 本文変更は fingerprint に映らない → drift carry 側で検知する方針)。
 *   - local SP を slug で remote に照合し、remote があれば本文 (title/description) を remote 値へ更新
 *     (submit rule が参照する harness id は保つ = dangling 参照を作らない)。remote に無い local は保守的に保持。
 *   - remote-only (外部で追加された SP) は id=slug で追記。
 */
export function mergeDriftSuccessPages(local: SuccessPageSpec[], remote: SuccessPageSpec[]): SuccessPageSpec[] {
  const remoteBySlug = new Map<string, SuccessPageSpec>();
  for (const r of remote) if (r.slug) remoteBySlug.set(r.slug, r);
  const out: SuccessPageSpec[] = [];
  const usedSlugs = new Set<string>();
  for (const l of local) {
    const r = l.slug ? remoteBySlug.get(l.slug) : undefined;
    if (r) {
      usedSlugs.add(l.slug!);
      out.push({ id: l.id, slug: l.slug, title: r.title, ...(r.description ? { description: r.description } : {}) });
    } else {
      out.push(l); // remote 未確認 (未 push / 抽出漏れ) は local を保守的に保持
    }
  }
  for (const r of remote) if (r.slug && !usedSlugs.has(r.slug)) out.push(r); // 外部追加 SP
  return out;
}

// crypto.subtle / TextEncoder は Node18+ / Workers 双方の runtime global (formaloo-fingerprint.ts と同型 ambient)。
declare const crypto: { subtle: { digest(algorithm: string, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer> } };
declare class TextEncoder { encode(input?: string): Uint8Array }

/**
 * route-terminal-phase2 (fix / T-E5 gap): SP 本文 (title/description) の安定シグネチャ。
 *   slug を持つ SP だけを対象に slug 昇順で (slug,title,description) を連結する (順序無依存)。
 *   SP を持たない (または未 push の) フォームは '' を返す = 既存フォームと signature 不変 (false-drift ゼロ)。
 *   description は parse 時 (normalizeSuccessPages) / pull 時 (extractSuccessPages) 双方で plain-text 化済 =
 *   両辺が同じ正規化ゆえ apples-to-apples 比較。
 */
export function successPagesSignature(sps: SuccessPageSpec[]): string {
  return sps
    .filter((s) => !!s.slug)
    .map((s) => ({ slug: s.slug as string, title: s.title, description: s.description ?? '' }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((s) => `${s.slug}${s.title}${s.description}`)
    .join('');
}

/** SP 本文 (title/description) が等価か (slug で照合・fingerprint 非包含の別建て比較 / design/copy confirm 同族)。 */
export function successPagesContentEqual(a: SuccessPageSpec[], b: SuccessPageSpec[]): boolean {
  return successPagesSignature(a) === successPagesSignature(b);
}

/** 文字列の SHA-256 hex (SP drift の dedup キーを固定長・不透明化する。fingerprint とは別軸の pending キー)。 */
async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

  // form-route-branching: formType carry (remote pull 優先・無ければ保存済みを保つ = 無関係 drift で消えない)。
  const formType = pull.formType ?? parseStoredFormType(form.definition_json);

  // route-terminal-phase2 (T-E5): successPages carry。local harness id を保ちつつ remote 本文 (title/description)
  //   を slug で反映 (完了ページ本文変更を検知)。remote 抽出無しは local を保持 (無関係 drift で消えない)。
  const successPages = mergeDriftSuccessPages(parseStoredSuccessPages(form.definition_json), pull.successPages ?? []);

  const definitionJson = JSON.stringify({
    fields: pull.fields,
    logic: pull.logic,
    formalooAddress: parseFormalooAddress(form.definition_json),
    ...(pull.rawLogic != null ? { rawLogic: pull.rawLogic } : {}),
    logicFingerprint: pull.logicFingerprint,
    ...(design && Object.keys(design).length ? { design } : {}),
    ...(formType ? { formType } : {}),
    ...(successPages.length ? { successPages } : {}),
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
    checked: 0, bootstrapped: 0, autoApplied: 0, notified: 0, conflicts: 0, inSync: 0, skipped: 0, systemFieldUnhealthy: 0,
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

        // fr-id-hardening-round2 / T-C5 + route-terminal-phase2 T-E5: fingerprint 一致 (action='none') でも fingerprint
        //   非包含の 2 軸を別建て監査する — (a) friend system field 健全性 (T-C5・deps.systemFieldHealthCheck gated)、
        //   (b) SP 本文 (T-E5)。**両者を同 tick で同時に surface する** (どちらかで early-return して他方をマスクしない
        //   = reviewer R1 P2: system field 不健全時に SP 本文 drift を無期限に隠さない)。pending_remote_hash は両 signature を
        //   `|` 連結した合成ハッシュで dedup し (単軸時は従来個別ハッシュと byte 一致 = SP 単軸/health 単軸とも既存挙動不変)、
        //   1 回の setFormalooSyncState / recordFormalooDriftEvent で両 signal を告知する (badge 固着防止 dedup は維持)。
        //   定義 drift (action!=='none') がある form では本分岐に入らない = 定義 drift 通知を優先。
        if (action === 'none') {
          // (a) friend system field 健全性。deps.systemFieldHealthCheck=false (default) は完全短絡 = 既存挙動不変。
          let healthUnhealthy = false;
          let healthSig = '';
          const combinedWarnings: string[] = [];
          if (deps.systemFieldHealthCheck) {
            const health = checkSystemFieldHealth(fieldsArr, { includeOwnerGated: deps.includeOwnerGatedSystemFields ?? true }, rawLogic);
            if (!health.ok) {
              healthUnhealthy = true;
              summary.systemFieldUnhealthy += 1; // 観測用 (dedup 非依存 = この tick で不健全だった form 数)
              combinedWarnings.push(
                ...health.issues.map((i) => `friend system field ${i.alias}: ${i.issue}`),
                ...(health.logicConflict ? ['form logic が有効なため Formaloo が fr_id 値を intake で破棄します (再入場 prefill 不能)'] : []),
              );
              healthSig = `sysfield:${JSON.stringify({ issues: health.issues, logicConflict: health.logicConflict })}`;
            }
          }

          // (b) SP 本文 drift (T-E5・fingerprint 非包含): remote SP 本文 vs 保存済 SP 本文を直接比較する。SP 無しフォームは
          //   両 signature '' で常に一致 = 既存挙動不変。health 不健全でもここを必ず評価する (reviewer R1 P2 = マスク解消)。
          const remoteSp = extractSuccessPages(res.data);
          const spDrifted = !successPagesContentEqual(parseStoredSuccessPages(form.definition_json), remoteSp);
          const spSig = spDrifted ? `sp:${successPagesSignature(remoteSp)}` : '';
          if (spDrifted && healthUnhealthy) combinedWarnings.push('完了ページ本文が Formaloo 側で変更されています');

          if (healthUnhealthy || spDrifted) {
            // 合成 pending: filter(Boolean).join('|') ゆえ単軸時は従来個別ハッシュ (sha256('sp:xxx') / sha256('sysfield:...'))
            //   と byte 一致・両軸同時の時のみ連結する (SP 単軸/health 単軸の dedup は既存と不変)。
            const combinedPending = await sha256Hex([healthSig, spSig].filter(Boolean).join('|'));
            const isNew = sync?.pending_remote_hash !== combinedPending;
            const transitioned = (sync?.drift_status ?? 'none') !== 'detected';
            if (isNew || transitioned) {
              await setFormalooSyncState(deps.db, form.id, {
                syncStatus, driftStatus: 'detected', pendingRemoteHash: combinedPending, driftDetectedAt: nowIso,
                // reviewer R1 P2-3: health 由来 surface の時だけ既存 last_error を保持する (SP 単軸は従来どおり omit=clear で
                //   byte 不変 = L341 pattern の他 3 箇所は非改変)。
                ...(healthUnhealthy ? { lastError: sync?.last_error ?? null } : {}),
              });
              await recordFormalooDriftEvent(deps.db, {
                formId: form.id, action: 'notified', detectedAt: nowIso, remoteHash: fp, prevHash: baseline,
                // SP 単軸 (health off/healthy) は従来どおり hasWarnings=weakened・warningsJson/detail 無し (byte 不変)。
                hasWarnings: healthUnhealthy ? true : weakened,
                ...(healthUnhealthy ? { warningsJson: JSON.stringify(combinedWarnings), detail: 'system_field_health' } : {}),
                syncStatusAt: syncStatus,
              });
              summary.notified += 1;
            } else {
              summary.inSync += 1; // 既に detected 済 = 重複記録しない (badge 固着防止)
            }
            return; // 2 軸を同 tick で surface 済 (通常 switch を回さない = 二重処理しない)
          }
        }

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
