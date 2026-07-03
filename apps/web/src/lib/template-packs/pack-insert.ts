/**
 * F2 G16 テンプレパック挿入の純ロジック (broadcast-form への state 反映のみ・送信しない)。
 *
 * 現行 broadcast-form は単一 messageContent 前提。パックの吹き出しを載せる際は「1件ずつ選んで
 * フォームに入れる」フォールバック (ui-designer 申し送り承認)。この関数は「選んだ吹き出しを
 * form state (messageType/messageContent) に変換する」だけで、送信 API は一切呼ばない。
 */

import type { TemplatePackItem } from '../api'

export interface FormBubblePatch {
  messageType: 'text' | 'flex'
  messageContent: string
}

/**
 * パックの 1 吹き出しを form patch に変換する。text/flex をそのまま messageType/messageContent へ。
 * broadcast-form は image も持つが、パックは text/flex のみ (053 CHECK) なので安全。
 */
export function itemToFormPatch(item: Pick<TemplatePackItem, 'message_type' | 'message_content'>): FormBubblePatch {
  return { messageType: item.message_type, messageContent: item.message_content }
}

/** パックのラベル (一覧/セレクトの表示)。「名前（N吹き出し）」。 */
export function packOptionLabel(name: string, itemCount: number): string {
  return `${name}（${itemCount}吹き出し）`
}

/** パックが挿入可能か (吹き出しが 1 件以上)。空パックは挿入対象なし。 */
export function isInsertablePack(itemCount: number): boolean {
  return itemCount > 0
}
