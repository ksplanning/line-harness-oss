import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  notifyFaqDraftReviewChanged,
  subscribeFaqDraftReviewChanges,
} from './faq-draft-review-sync'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AI下書きレビューの別タブ同期', () => {
  it('BroadcastChannel未対応環境でも通知・購読を安全にno-opできる', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const listener = vi.fn()

    expect(() => notifyFaqDraftReviewChanged({ accountId: 'acc-1', draftId: 'draft-1' })).not.toThrow()
    const unsubscribe = subscribeFaqDraftReviewChanges(listener)
    expect(() => unsubscribe()).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  it('chat側から送った変更イベントを購読側へ渡し、解除時にchannelを閉じる', () => {
    const instances: BroadcastChannelMock[] = []
    class BroadcastChannelMock {
      listeners = new Set<(event: MessageEvent) => void>()
      posted: unknown[] = []
      closed = false
      constructor(readonly name: string) { instances.push(this) }
      addEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listeners.add(listener) }
      removeEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listeners.delete(listener) }
      postMessage(value: unknown) { this.posted.push(value) }
      close() { this.closed = true }
      emit(data: unknown) { this.listeners.forEach((listener) => listener({ data } as MessageEvent)) }
    }
    vi.stubGlobal('BroadcastChannel', BroadcastChannelMock)
    const listener = vi.fn()
    const unsubscribe = subscribeFaqDraftReviewChanges(listener)

    instances[0].emit({ type: 'faq-draft-review-changed', accountId: 'acc-1', draftId: 'draft-1' })
    expect(listener).toHaveBeenCalledWith({
      type: 'faq-draft-review-changed',
      accountId: 'acc-1',
      draftId: 'draft-1',
    })

    notifyFaqDraftReviewChanged({ accountId: 'acc-1', draftId: 'draft-1' })
    expect(instances[1].posted).toEqual([{
      type: 'faq-draft-review-changed',
      accountId: 'acc-1',
      draftId: 'draft-1',
    }])
    expect(instances[1].closed).toBe(true)
    unsubscribe()
    expect(instances[0].closed).toBe(true)
  })
})
