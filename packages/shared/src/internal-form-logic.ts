import type { HarnessField, HarnessLogicRule } from './formaloo-forms.js';

export const INTERNAL_FORM_CHANNEL_SOURCE_ID = '__channel__';

export type InternalFormChannel = 'line' | 'web';
export type InternalFormLogicAnswers = Record<string, unknown>;

export interface InternalFormLogicState {
  visibleFieldIds: string[];
  hiddenFieldIds: string[];
  activeJumpBySource: Record<string, string>;
  completionSourceId: string | null;
  completionPageId: string | null;
}

type LogicField = Pick<HarnessField, 'id' | 'position' | 'type'>;

/**
 * 郵便番号検索へ渡す値だけを正規化する。入力欄の表示値は呼び出し側で保持する。
 */
export function normalizePostalLookupCode(value: unknown): string {
  return String(value ?? '')
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/[\s\-－ー−‐‑]/g, '');
}

/** 折り返し表示する住所欄の値を、保存・連携用の1行文字列へそろえる。 */
export function normalizeSingleLineAddress(value: unknown): string {
  return String(value ?? '').replace(/\r\n|[\n\r\u2028\u2029]/g, ' ');
}

/**
 * Internal 公開画面と builder preview が共有する分岐評価器。
 *
 * 公開画面のビルド済み client asset と React preview の両方が、この module を
 * 通常 import して同じ実装を実行する。
 */
export function evaluateInternalFormLogic(
  fields: LogicField[],
  logic: HarnessLogicRule[],
  answers: InternalFormLogicAnswers,
  channel: InternalFormChannel,
): InternalFormLogicState {
  const ordered = [...fields].sort((a, b) => a.position - b.position);
  const positionById = new Map(ordered.map((field, index) => [field.id, index]));
  const compute = (allowedSources: Set<string>): InternalFormLogicState => {
    // Visibility is recomputed from scratch on every pass. `allowedSources`
    // controls which answers may drive rules; it must not permanently hide a
    // separate target that was affected by a forged answer in an earlier pass.
    const hidden = new Set<string>();
    const activeJumpBySource: Record<string, string> = {};

    const hideTarget = (targetFieldId: string): void => {
      const start = positionById.get(targetFieldId);
      if (start === undefined) return;
      hidden.add(targetFieldId);
      if (ordered[start].type !== 'section') return;
      for (let index = start + 1; index < ordered.length; index++) {
        if (ordered[index].type === 'section' || ordered[index].type === 'page_break') break;
        hidden.add(ordered[index].id);
      }
    };

    const values = (sourceFieldId: string): string[] => {
      if (sourceFieldId === '__channel__') return [channel];
      if (!allowedSources.has(sourceFieldId)) return [];
      const value = answers[sourceFieldId];
      if (Array.isArray(value)) return value.map((item) => String(item));
      if (value === undefined || value === null) return [];
      return [String(value)];
    };

    const conditionMatches = (sourceFieldId: string, operator: string, expected: string): boolean => {
      if (sourceFieldId !== '__channel__' && !allowedSources.has(sourceFieldId)) return false;
      const actual = values(sourceFieldId);
      const answered = actual.some((value) => value.trim() !== '');
      if (operator === 'is_answered') return answered;
      if (operator === 'not_equals' || operator === 'is_not') return !actual.includes(expected);
      if (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') {
        const left = Number(actual[0]);
        const right = Number(expected);
        if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
        if (operator === 'gt') return left > right;
        if (operator === 'gte') return left >= right;
        if (operator === 'lt') return left < right;
        return left <= right;
      }
      return actual.includes(expected);
    };

    const ruleMatches = (rule: HarnessLogicRule): boolean => {
      if (rule.terminalTrigger === 'on_answered' && rule.action === 'submit') {
        return values(rule.sourceFieldId).some((value) => value.trim() !== '');
      }
      if (Array.isArray(rule.conditions) && rule.conditions.length > 0) {
        const matches = rule.conditions.map((condition) => conditionMatches(
          condition.sourceFieldId,
          condition.operator,
          condition.value,
        ));
        return rule.conditionJoin === 'or' ? matches.some(Boolean) : matches.every(Boolean);
      }
      return conditionMatches(rule.sourceFieldId, rule.operator, rule.value);
    };

    const expanded = logic.flatMap((rule) => {
      const actions = Array.isArray(rule.actions) && rule.actions.length > 0
        ? rule.actions
        : [{ action: rule.action, targetFieldId: rule.targetFieldId }];
      return actions.map((action) => ({
        rule,
        // `skip` is the legacy projection name for Formaloo jump. Treating it
        // as hide would change existing definitions when rendered internally.
        action: action.action === 'skip' ? 'jump' : action.action,
        targetFieldId: action.targetFieldId,
        matches: ruleMatches(rule),
      }));
    });

    // A field controlled by one or more `show` rules starts hidden and appears when
    // any matching rule says so. A matching hide always wins.
    const showTargets = new Set(
      expanded.filter((entry) => entry.action === 'show').map((entry) => entry.targetFieldId),
    );
    for (const target of showTargets) {
      if (!expanded.some((entry) => entry.action === 'show' && entry.targetFieldId === target && entry.matches)) {
        hideTarget(target);
      }
    }
    for (const entry of expanded) {
      if (entry.matches && entry.action === 'hide') hideTarget(entry.targetFieldId);
    }

    // Jump rules sharing a source define sibling route segments. Before an answer,
    // every route segment is hidden. After an answer, only the selected segment is
    // visible. This is what makes ABC routing work on a one-page form as well.
    const jumpSources = [...new Set(
      expanded.filter((entry) => entry.action === 'jump').map((entry) => entry.rule.sourceFieldId),
    )];
    for (const source of jumpSources) {
      const entries = expanded
        .filter((entry) => entry.action === 'jump' && entry.rule.sourceFieldId === source && positionById.has(entry.targetFieldId))
        .sort((a, b) => (positionById.get(a.targetFieldId) ?? 0) - (positionById.get(b.targetFieldId) ?? 0));
      if (entries.length === 0) continue;
      const active = entries.find((entry) => entry.matches);
      if (active) activeJumpBySource[source] = active.targetFieldId;

      entries.forEach((entry, index) => {
        if (active && entry.targetFieldId === active.targetFieldId) return;
        const start = positionById.get(entry.targetFieldId)!;
        const end = index + 1 < entries.length
          ? positionById.get(entries[index + 1].targetFieldId)!
          : ordered.length;
        for (let current = start; current < end; current++) hidden.add(ordered[current].id);
      });
    }

    const visibleBeforeCompletion = new Set(
      ordered.map((field) => field.id).filter((id) => !hidden.has(id)),
    );
    const completion = expanded.find((entry) =>
      entry.action === 'submit' && entry.matches && visibleBeforeCompletion.has(entry.rule.sourceFieldId),
    );
    const completionPosition = completion ? positionById.get(completion.rule.sourceFieldId) : undefined;
    if (completionPosition !== undefined) {
      for (let index = completionPosition + 1; index < ordered.length; index++) {
        hidden.add(ordered[index].id);
      }
    }
    const visibleFieldIds = ordered.map((field) => field.id).filter((id) => !hidden.has(id));

    return {
      visibleFieldIds,
      hiddenFieldIds: ordered.map((field) => field.id).filter((id) => hidden.has(id)),
      activeJumpBySource,
      completionSourceId: completion?.rule.sourceFieldId ?? null,
      completionPageId: completion?.targetFieldId || null,
    };
  };

  // Begin with the unconditional/channel-only surface, then admit answers only
  // after their fields become visible. Sources that later disappear are banned
  // for the remainder of this evaluation, which gives cyclic/self-hiding rules
  // a safe deterministic result without letting hidden forged values hide
  // required fields.
  let state = compute(new Set());
  let allowedSources = new Set(state.visibleFieldIds);
  const bannedSources = new Set<string>();
  // Each field can enter `allowedSources` once and enter `bannedSources` once,
  // so at most 2N membership changes are possible before convergence.
  for (let pass = 0; pass <= ordered.length * 2; pass++) {
    const nextState = compute(allowedSources);
    const visible = new Set(nextState.visibleFieldIds);
    for (const source of allowedSources) {
      if (!visible.has(source)) bannedSources.add(source);
    }
    const nextAllowedSources = new Set(
      [...allowedSources, ...nextState.visibleFieldIds].filter((id) => !bannedSources.has(id)),
    );
    const stable = nextAllowedSources.size === allowedSources.size
      && [...nextAllowedSources].every((id) => allowedSources.has(id));
    state = nextState;
    if (stable) return state;
    allowedSources = nextAllowedSources;
  }
  // Defensive fail-closed fallback: if a future rule kind breaks the monotonic
  // bound, ignore all submitted field answers instead of trusting a transient
  // visibility state. Channel-only rules remain deterministic in `compute`.
  return compute(new Set());
}

export function nextInternalFormFieldId(
  fields: LogicField[],
  state: InternalFormLogicState,
  currentFieldId: string,
): string | null {
  if (state.completionSourceId === currentFieldId) return null;
  const jumpTarget = state.activeJumpBySource[currentFieldId];
  if (jumpTarget && state.visibleFieldIds.includes(jumpTarget)) return jumpTarget;
  const orderedIds = [...fields].sort((a, b) => a.position - b.position).map((field) => field.id);
  const current = orderedIds.indexOf(currentFieldId);
  if (current < 0) return state.visibleFieldIds[0] ?? null;
  for (let index = current + 1; index < orderedIds.length; index++) {
    if (state.visibleFieldIds.includes(orderedIds[index])) return orderedIds[index];
  }
  return null;
}
