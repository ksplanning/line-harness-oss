/**
 * 定型文ピッカーを開いたときの load 手順を担う純関数。
 *
 * バグ (Codex P2): reload 失敗時に旧 items が残ると、account 切替後に
 * ピッカーを再オープンして fetch が失敗したとき、旧 account の定型文が
 * 見え得た。挿入のみ (認可境界は不破) だが鮮度として不適切。
 *
 * 修正: load の一番最初に必ず setItems([]) でクリアしてから取得する。
 * 取得が成功したときだけ新データをセットする。失敗 (success:false / throw) は
 * サイレントにクリア状態のまま残す (ピッカーは空表示)。
 *
 * component から DOM/state 依存を切り離した純ロジックとしてテスト可能にする
 * (insert-canned-text.ts と同じ流儀)。
 */

/** テスト用の最小 shape。実コードは CannedResponseData を渡す (T で汎用化)。 */
export interface CannedResponseLike {
  id: string
  title: string
  content: string
}

interface ListResult<T> {
  success: boolean
  data: T[]
}

/**
 * ピッカーを開いたときの items load。item 型 T は呼び出し側が決める
 * (実コード: CannedResponseData / テスト: CannedResponseLike)。
 *   1. まず setItems([]) で必ずクリア (stale 除去)
 *   2. accountId が無ければここで終了 (取得しない)
 *   3. fetch 成功時のみ setItems(data)
 *   4. 失敗 (success:false / throw) はサイレント。クリア状態を維持
 */
export async function loadPickerItems<T>(
  accountId: string | null,
  setItems: (items: T[]) => void,
  fetchList: (accountId: string) => Promise<ListResult<T>>,
): Promise<void> {
  // 取得前に必ずクリア: reload 失敗時に旧 (別 account の) 定型文が残らない。
  setItems([])
  if (!accountId) return
  try {
    const res = await fetchList(accountId)
    if (res.success) setItems(res.data)
  } catch {
    // サイレント失敗 (ピッカーは空表示のまま)。クリア済みなので stale は残らない。
  }
}
