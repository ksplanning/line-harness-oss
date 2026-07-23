import {
  addTagToFriend,
  getFriendFieldDefinition,
  mergeFriendMetadata,
  removeTagFromFriend,
} from '@line-crm/db';

export type FormSubmitAction =
  | { type: 'add_tag'; tagId: string }
  | { type: 'remove_tag'; tagId: string }
  | { type: 'set_field'; fieldId: string; value: string }
  | { type: 'clear_field'; fieldId: string };

export type FormSubmitActionOutcome = {
  index: number;
  type: FormSubmitAction['type'];
  status: 'applied' | 'failed' | 'skipped';
  reason?: string;
};

export type ParseFormSubmitActionsResult =
  | { ok: true; actions: FormSubmitAction[] }
  | { ok: false; error: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseFormSubmitActions(input: unknown): ParseFormSubmitActionsResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: '送信後アクションは配列で指定してください' };
  }

  const actions: FormSubmitAction[] = [];
  for (let index = 0; index < input.length; index++) {
    const candidate = input[index];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { ok: false, error: `送信後アクション ${index + 1} が不正です` };
    }
    const action = candidate as Record<string, unknown>;
    switch (action.type) {
      case 'add_tag':
      case 'remove_tag':
        if (!nonEmptyString(action.tagId)) {
          return { ok: false, error: `送信後アクション ${index + 1} のタグが不正です` };
        }
        actions.push({ type: action.type, tagId: action.tagId });
        break;
      case 'set_field':
        if (!nonEmptyString(action.fieldId) || typeof action.value !== 'string') {
          return { ok: false, error: `送信後アクション ${index + 1} のカスタムフィールドが不正です` };
        }
        actions.push({
          type: 'set_field',
          fieldId: action.fieldId,
          value: action.value,
        });
        break;
      case 'clear_field':
        if (!nonEmptyString(action.fieldId)) {
          return { ok: false, error: `送信後アクション ${index + 1} のカスタムフィールドが不正です` };
        }
        actions.push({ type: 'clear_field', fieldId: action.fieldId });
        break;
      default:
        return { ok: false, error: `送信後アクション ${index + 1} の種類が不正です` };
    }
  }
  return { ok: true, actions };
}

export function resolveFormSubmitActions(
  actionsJson: string | null,
  legacyTagId: string | null,
): FormSubmitAction[] {
  if (actionsJson === null) {
    return legacyTagId ? [{ type: 'add_tag', tagId: legacyTagId }] : [];
  }
  try {
    const parsed = parseFormSubmitActions(JSON.parse(actionsJson) as unknown);
    return parsed.ok ? parsed.actions : [];
  } catch {
    return [];
  }
}

class FormSubmitActionError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function logOutcome(formId: string, outcome: FormSubmitActionOutcome): void {
  console.log(`[form-submit-action] ${JSON.stringify({
    formId,
    index: outcome.index,
    type: outcome.type,
    status: outcome.status,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  })}`);
}

async function applyAction(
  db: D1Database,
  friendId: string,
  action: FormSubmitAction,
): Promise<void> {
  switch (action.type) {
    case 'add_tag':
      await addTagToFriend(db, friendId, action.tagId);
      return;
    case 'remove_tag':
      await removeTagFromFriend(db, friendId, action.tagId);
      return;
    case 'set_field':
    case 'clear_field': {
      const definition = await getFriendFieldDefinition(db, action.fieldId);
      if (!definition) throw new FormSubmitActionError('field_not_found');
      const result = await mergeFriendMetadata(db, friendId, {
        [definition.name]: action.type === 'set_field' ? action.value : '',
      });
      if (result.status !== 'updated') {
        throw new FormSubmitActionError(`metadata_${result.status}`);
      }
    }
  }
}

export async function executeFormSubmitActions(
  db: D1Database,
  input: {
    formId: string;
    friendId: string | null;
    actions: readonly FormSubmitAction[];
  },
): Promise<FormSubmitActionOutcome[]> {
  const outcomes: FormSubmitActionOutcome[] = [];
  for (let index = 0; index < input.actions.length; index++) {
    const action = input.actions[index]!;
    let outcome: FormSubmitActionOutcome;
    if (!input.friendId) {
      outcome = {
        index,
        type: action.type,
        status: 'skipped',
        reason: 'friend_not_linked',
      };
    } else {
      try {
        await applyAction(db, input.friendId, action);
        outcome = { index, type: action.type, status: 'applied' };
      } catch (error) {
        outcome = {
          index,
          type: action.type,
          status: 'failed',
          reason: error instanceof FormSubmitActionError
            ? error.reason
            : 'operation_failed',
        };
      }
    }
    outcomes.push(outcome);
    if (outcome.status !== 'applied') logOutcome(input.formId, outcome);
  }
  return outcomes;
}
