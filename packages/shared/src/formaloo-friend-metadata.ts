/** Form 単位の Formaloo row → friend.metadata 反映ルール。 */
export interface FriendMetadataMapping {
  /** Formaloo row の field slug または alias。 */
  formalooFieldKey: string;
  /** friend.metadata に保存する表示キー。 */
  friendMetadataKey: string;
}

export const MAX_FRIEND_METADATA_MAPPINGS = 20;
const MAX_FORMALOO_FIELD_KEY_LENGTH = 128;
const MAX_FRIEND_METADATA_KEY_LENGTH = 100;
export const FORMALOO_INTERNAL_METADATA_PREFIX = '__formaloo_';
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export type FriendMetadataMappingsValidation =
  | { ok: true; mappings: FriendMetadataMapping[] }
  | { ok: false; error: string };

export function isInternalFormalooMetadataKey(key: string): boolean {
  return key.startsWith(FORMALOO_INTERNAL_METADATA_PREFIX);
}

/** 自動由来の内部 key と JavaScript object の特殊 key は手動/自動共に書かない。 */
export function isReservedFriendMetadataKey(key: string): boolean {
  return isInternalFormalooMetadataKey(key) || PROTOTYPE_POLLUTION_KEYS.has(key);
}

/**
 * API/DB 共通の whitelist validator。空配列は機能 OFF、壊れた入力は fail-closed で拒否する。
 */
export function validateFriendMetadataMappings(input: unknown): FriendMetadataMappingsValidation {
  if (!Array.isArray(input)) return { ok: false, error: '個人情報への反映ルールは配列で指定してください' };
  if (input.length > MAX_FRIEND_METADATA_MAPPINGS) {
    return { ok: false, error: `個人情報への反映ルールは最大 ${MAX_FRIEND_METADATA_MAPPINGS} 件です` };
  }

  const mappings: FriendMetadataMapping[] = [];
  const targetKeys = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const raw = input[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `反映ルール ${index + 1} の形式が不正です` };
    }
    const record = raw as Record<string, unknown>;
    const formalooFieldKey = typeof record.formalooFieldKey === 'string' ? record.formalooFieldKey.trim() : '';
    const friendMetadataKey = typeof record.friendMetadataKey === 'string' ? record.friendMetadataKey.trim() : '';
    if (!formalooFieldKey || !friendMetadataKey) {
      return { ok: false, error: `反映ルール ${index + 1} の field と個人情報項目名を入力してください` };
    }
    if (
      formalooFieldKey.length > MAX_FORMALOO_FIELD_KEY_LENGTH
      || CONTROL_CHARACTER.test(formalooFieldKey)
    ) {
      return { ok: false, error: `反映ルール ${index + 1} の Formaloo field が不正です` };
    }
    if (
      friendMetadataKey.length > MAX_FRIEND_METADATA_KEY_LENGTH
      || CONTROL_CHARACTER.test(friendMetadataKey)
      || isReservedFriendMetadataKey(friendMetadataKey)
    ) {
      return { ok: false, error: `反映ルール ${index + 1} の個人情報項目名が不正です` };
    }
    if (targetKeys.has(friendMetadataKey)) {
      return { ok: false, error: `個人情報項目「${friendMetadataKey}」が重複しています` };
    }
    targetKeys.add(friendMetadataKey);
    mappings.push({ formalooFieldKey, friendMetadataKey });
  }
  return { ok: true, mappings };
}

/** DB の JSON 列を読む fail-closed parser。壊れた値は機能 OFF (`[]`) に倒す。 */
export function parseFriendMetadataMappingsJson(json: string | null | undefined): FriendMetadataMapping[] {
  if (!json) return [];
  try {
    const result = validateFriendMetadataMappings(JSON.parse(json));
    return result.ok ? result.mappings : [];
  } catch {
    return [];
  }
}
