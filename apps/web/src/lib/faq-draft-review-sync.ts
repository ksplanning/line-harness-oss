export const FAQ_DRAFT_REVIEW_CHANNEL = 'line-harness:faq-draft-reviews'

export interface FaqDraftReviewChangedEvent {
  type: 'faq-draft-review-changed'
  accountId: string
  draftId?: string
  sourceId?: string
}

function isFaqDraftReviewChangedEvent(value: unknown): value is FaqDraftReviewChangedEvent {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<FaqDraftReviewChangedEvent>
  return candidate.type === 'faq-draft-review-changed'
    && typeof candidate.accountId === 'string'
    && (candidate.draftId === undefined || typeof candidate.draftId === 'string')
    && (candidate.sourceId === undefined || typeof candidate.sourceId === 'string')
}

export function notifyFaqDraftReviewChanged(
  change: Omit<FaqDraftReviewChangedEvent, 'type'>,
): void {
  if (typeof BroadcastChannel === 'undefined') return
  let channel: BroadcastChannel | null = null
  try {
    channel = new BroadcastChannel(FAQ_DRAFT_REVIEW_CHANNEL)
    channel.postMessage({ type: 'faq-draft-review-changed', ...change } satisfies FaqDraftReviewChangedEvent)
  } catch {
    // BroadcastChannel unavailable/blocked: focus reload remains the fallback.
  } finally {
    channel?.close()
  }
}

export function subscribeFaqDraftReviewChanges(
  listener: (event: FaqDraftReviewChangedEvent) => void,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  let channel: BroadcastChannel
  try {
    channel = new BroadcastChannel(FAQ_DRAFT_REVIEW_CHANNEL)
  } catch {
    return () => {}
  }
  const onMessage = (event: MessageEvent<unknown>) => {
    if (isFaqDraftReviewChangedEvent(event.data)) listener(event.data)
  }
  channel.addEventListener('message', onMessage)
  return () => {
    channel.removeEventListener('message', onMessage)
    channel.close()
  }
}
