import {
  fromFormalooField,
  fromFormalooLogic,
  type HarnessField,
  type HarnessLogicRule,
  type FormalooLogicObject,
} from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client';

// =============================================================================
// Formaloo pull (N-8 / formaloo-pull-wiring) — Formaloo → harness 定義 再取り込み。
// -----------------------------------------------------------------------------
// SoT (§4): Formaloo = 定義の権威。運用者が Formaloo 管理画面で直接編集したフォームを
//   harness builder に読み戻す (push の逆方向)。shared の fromFormalooField / fromFormalooLogic
//   (round-trip 変換・実装済/無改変) を builder pull 経路に結線する薄い層。
// 非破壊: D1 は書き換えない (setFormalooSyncState / saveFormalooDefinition は呼ばない)。
//   再取り込みは builder エディタ state への反映のみ。永続化は運用者が既存 PUT で「保存」。
// fail-soft (N-6): read endpoint / JSON パスは live 未確定 → 候補キーを許容的に拾い、
//   どの段の失敗も {ok:false} で返す (throw しない)。誤 JSON パスの silent 空定義は W1 で {ok:false}。
// =============================================================================

/**
 * pull 結果 (discriminated union)。`ok` は「builder editor に適用してよいか」の判別子。
 * frontend は ok===true の時だけ state を置換し、ok:false は note のみ表示する (B2 = editor を空へ潰さない)。
 */
export type PullResult =
  | { ok: true; fields: HarnessField[]; logic: HarnessLogicRule[] }
  | { ok: false; error: string };

/**
 * form-detail JSON body から fields 配列を許容的に抽出 (Rk1 / read endpoint の JSON パス live 未確定)。
 * 候補パスを順に試し、最初に見つかった配列を返す。どの候補も配列でなければ null (= read-shape 不一致 / W1)。
 * 明示的な空配列 [] は「正当な空フォーム」として返す (誤パスの silent 空定義と区別)。
 */
export function extractFieldsList(root: unknown): unknown[] | null {
  const r = (root ?? {}) as Record<string, any>;
  const candidates: unknown[] = [
    r?.data?.form?.fields_list,
    r?.data?.fields_list,
    r?.form?.fields_list,
    r?.fields_list,
    r?.data?.form?.fields,
    r?.data?.fields,
    r?.form?.fields,
    r?.fields,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as unknown[];
  }
  return null;
}

/**
 * form-detail JSON body から logic object ({ rules:[...] } 形) を許容的に抽出。
 * rules 配列を持つ object のみ採用し、無ければ空 { rules:[] } (fromFormalooLogic が安全に空を返す)。
 */
export function extractLogic(root: unknown): FormalooLogicObject {
  const r = (root ?? {}) as Record<string, any>;
  const candidates: unknown[] = [r?.data?.form?.logic, r?.data?.logic, r?.form?.logic, r?.logic];
  for (const c of candidates) {
    if (c && typeof c === 'object' && Array.isArray((c as { rules?: unknown }).rules)) {
      return c as FormalooLogicObject;
    }
  }
  return { rules: [] };
}

/**
 * Formaloo form-detail を GET し、fields_list / logic を harness 定義へ変換して返す。
 *  - fields: fromFormalooField (非 subset は null で drop / M-21) → 空/欠落 id を drop (W3)
 *            → Formaloo position 昇順に安定ソート (W2)。
 *  - logic: fromFormalooLogic → 変換済 field-id 集合に無い rule を除去 (孤立防止 / B5)。
 *  - fail-soft: formalooSlug 無 / GET 非 ok / read-shape 不一致 / 例外 は {ok:false} (throw しない / N-6)。
 */
export async function pullDefinitionFromFormaloo(
  client: FormalooClient,
  params: {
    formalooSlug: string | null;
    resolveId: (formalooFieldSlug: string) => string | undefined;
  },
): Promise<PullResult> {
  try {
    if (!params.formalooSlug) return { ok: false, error: 'form 未 push（Formaloo slug 無し）' };

    const res = await client.get(`/v3.0/forms/${params.formalooSlug}/`);
    if (!res.ok) return { ok: false, error: `pull failed: HTTP ${res.status}` };

    const fieldsArr = extractFieldsList(res.data);
    if (fieldsArr === null) return { ok: false, error: 'read shape mismatch: fields_list not found' };

    const fields = fieldsArr
      .map((el) => fromFormalooField(el, params.resolveId))
      .filter((f): f is HarnessField => f !== null)
      .filter((f) => typeof f.id === 'string' && f.id !== '') // W3: 空/欠落 id は drop
      .sort((a, b) => a.position - b.position); // W2: Formaloo position 昇順に安定ソート

    const idSet = new Set(fields.map((f) => f.id));
    const logic = fromFormalooLogic(extractLogic(res.data), params.resolveId).filter(
      // B5: 変換済 field-id 集合に無い rule を除去 (孤立参照を editor に入れない)
      (r) => idSet.has(r.sourceFieldId) && idSet.has(r.targetFieldId),
    );

    return { ok: true, fields, logic };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
