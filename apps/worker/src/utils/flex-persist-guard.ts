/**
 * flex-persist-guard — 保存直前に Flex 内容を server 側で検証するゲート (batch2 / BACKLOG-flex)。
 *
 * WHY (セキュリティ): validateFlex は従来 web (client) のみ。API を直叩きすれば不正な Flex を
 *   保存でき、送信時に初めて LINE API で失敗する経路が残っていた。POST/PUT /api/broadcasts の
 *   保存直前にこのゲートを通し、client を迂回した不正 Flex 保存を 400 でブロックする。
 *   client と同一関数 (`@line-crm/shared` の validateFlex) を使うため drift しない。
 *
 * 後方互換:
 *   - `messageContent` が message-object 丸ごと ({type:'flex',altText,contents}) の場合も
 *     既存 `unwrapFlexMessageObject` で bare contents に正規化してから検証する。wrapped の
 *     正当な Flex を 400 にしない。unwrap で拾った altText も長さ検証に渡す。
 *   - 検証は messageType が実効的に 'flex' のときだけ。text/image は素通し。
 */
import { validateFlex } from '@line-crm/shared';
import type { FlexContents } from '@line-crm/shared';
import { unwrapFlexMessageObject, MessageBuildError } from './message-build.js';

export interface FlexGuardOk {
  ok: true;
}

export interface FlexGuardError {
  ok: false;
  /** 運用者向け日本語エラー (validateFlex の messageJa か parse 失敗の定型文)。 */
  messageJa: string;
}

export type FlexGuardResult = FlexGuardOk | FlexGuardError;

/**
 * messageType='flex' の messageContent (JSON 文字列) を検証する。
 * - JSON.parse 失敗 → ok:false (定型文)
 * - unwrap 後が非オブジェクト (MessageBuildError) → ok:false
 * - validateFlex ok:false → ok:false (errors[0].messageJa)
 * - それ以外 → ok:true
 *
 * @param messageContent broadcasts の message_content (Flex の JSON 文字列)
 * @param altText 明示 altText (present なら長さ検証に渡す)
 */
export function guardFlexContent(messageContent: string, altText?: string | null): FlexGuardResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(messageContent);
  } catch {
    return { ok: false, messageJa: 'メッセージの内容が正しい形式ではありません。もう一度作り直してください。' };
  }

  let contents: FlexContents;
  let unwrappedAlt: string | undefined;
  try {
    const r = unwrapFlexMessageObject(parsed);
    contents = r.contents as FlexContents;
    unwrappedAlt = r.altText;
  } catch (err) {
    if (err instanceof MessageBuildError) {
      return { ok: false, messageJa: 'メッセージの内容が正しい形式ではありません。もう一度作り直してください。' };
    }
    throw err;
  }

  // 明示 altText を優先し、無ければ wrapper 由来の altText を長さ検証に渡す。
  const altForCheck = (typeof altText === 'string' && altText.length > 0) ? altText : unwrappedAlt;
  const result = validateFlex(contents, altForCheck !== undefined ? { altText: altForCheck } : {});
  if (!result.ok) {
    return { ok: false, messageJa: result.errors[0].messageJa };
  }
  return { ok: true };
}
