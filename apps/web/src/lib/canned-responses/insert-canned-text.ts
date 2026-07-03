/**
 * G23 C6 — チャット定型文の「挿入のみ」helper。
 *
 * 設計の核 (failure_observable 筆頭): 定型文の選択は入力欄 (composer) に文字を入れる
 * "だけ" で、送信経路 (api.chats.send / handleSendMessage / triggerLoadingAnimation) には
 * 一切触れない。このモジュールは送信系を import すらしない (構造的に送信不能)。
 */

/**
 * 入力欄の現在値 current に insert を挿入した新しい値を返す純関数。
 *   - 空 composer → insert をそのまま
 *   - 既存文字あり → 改行を 1 つ挟んで末尾追記 (2 文がベタ結合して読めなくなるのを防ぐ)
 *   - 既に改行で終わっていれば余計な改行は足さない
 * 副作用なし・引数を破壊しない。
 */
export function insertCannedText(current: string, insert: string): string {
  if (!current) return insert
  return current.endsWith('\n') ? current + insert : current + '\n' + insert
}

/**
 * ピッカーで定型文を選んだときの適用処理。composer の state 更新関数 setContent を
 * insertCannedText 経由で呼ぶ "だけ"。送信系には触れない (このモジュールは api を import
 * しないので構造的に送信できない)。フォーカス/カーソル移動は DOM 依存のため呼び出し側で行う。
 */
export function applyCannedSelection(
  insert: string,
  setContent: (updater: (prev: string) => string) => void,
): void {
  setContent((prev) => insertCannedText(prev, insert))
}
