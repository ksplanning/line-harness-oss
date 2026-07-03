import { describe, it, expect } from 'vitest'
import { loadPickerItems, type CannedResponseLike } from './picker-load'

// picker を開くたびに走る load 手順の純関数テスト。
// バグ: reload 失敗時に旧 items が残ると、account 切替後の再オープンで
// fetch が失敗したとき旧 account の定型文が見え得た (Codex P2)。
// 修正: load 開始時に必ず一旦クリアしてから取得する。
describe('loadPickerItems', () => {
  const a: CannedResponseLike = { id: '1', title: 'A', content: 'a' }
  const b: CannedResponseLike = { id: '2', title: 'B', content: 'b' }

  it('load 開始時に items を空へクリアする (取得前に stale を消す)', async () => {
    const cleared: boolean[] = []
    const setItems = (v: CannedResponseLike[]) => {
      cleared.push(v.length === 0)
    }
    await loadPickerItems('acc-1', setItems, async () => ({ success: true, data: [a] }))
    // 最初の setItems 呼び出しは必ず空配列 (clear が先)
    expect(cleared[0]).toBe(true)
  })

  it('取得成功時: クリア後に新 items をセットする', async () => {
    const seen: CannedResponseLike[][] = []
    const setItems = (v: CannedResponseLike[]) => seen.push(v)
    await loadPickerItems('acc-1', setItems, async () => ({ success: true, data: [a, b] }))
    expect(seen[0]).toEqual([]) // clear
    expect(seen[seen.length - 1]).toEqual([a, b]) // 新データ
  })

  it('取得失敗 (success:false) 時: クリアされたまま旧データは復活しない', async () => {
    const seen: CannedResponseLike[][] = []
    const setItems = (v: CannedResponseLike[]) => seen.push(v)
    await loadPickerItems('acc-1', setItems, async () => ({ success: false, data: [] }))
    expect(seen[0]).toEqual([]) // clear
    // success:false なので clear 後に何もセットしない = 空表示のまま
    expect(seen.every((v) => v.length === 0)).toBe(true)
  })

  it('取得例外 (throw) 時: サイレント失敗しクリアされたまま (旧 account 定型文が残らない)', async () => {
    const seen: CannedResponseLike[][] = []
    const setItems = (v: CannedResponseLike[]) => seen.push(v)
    await loadPickerItems('acc-1', setItems, async () => {
      throw new Error('network down')
    })
    expect(seen[0]).toEqual([]) // clear
    expect(seen.every((v) => v.length === 0)).toBe(true)
  })

  it('accountId が null: fetch せずクリアのみ (何も取得しない)', async () => {
    const seen: CannedResponseLike[][] = []
    let fetchCalled = false
    const setItems = (v: CannedResponseLike[]) => seen.push(v)
    await loadPickerItems(null, setItems, async () => {
      fetchCalled = true
      return { success: true, data: [a] }
    })
    expect(seen[0]).toEqual([]) // clear
    expect(fetchCalled).toBe(false)
    expect(seen.every((v) => v.length === 0)).toBe(true)
  })
})
