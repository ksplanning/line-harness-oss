'use client'

import { useState, type ReactNode, type RefObject } from 'react'
import { parseStickerMessageContent, stickerFallback } from '@line-crm/shared'
import FlexPreviewComponent from '@/components/flex-preview'

export interface ChatHistoryMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  staffMemberId?: string | null
  staffMemberName?: string | null
  createdAt: string
}

export function StickerMessageImage({ content }: { content: string }) {
  const [failed, setFailed] = useState(false)
  const sticker = parseStickerMessageContent(content)
  const fallback = stickerFallback(content)

  if (!sticker || failed) return <span>{fallback}</span>

  return (
    <img
      src={sticker.stickerUrl}
      alt={fallback}
      className="max-h-[140px] max-w-[140px] object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function sameYmd(aIso: string, bIso: string): boolean {
  const a = new Date(aIso)
  const b = new Date(bIso)
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  )
}

function formatYmdSlash(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export default function ChatMessageHistory({
  messages,
  friendPictureUrl,
  scrollRef,
  expanded = false,
  afterMessage,
  bodyTextClassName = 'text-sm',
}: {
  messages: ChatHistoryMessage[]
  friendPictureUrl: string | null
  scrollRef: RefObject<HTMLDivElement | null>
  expanded?: boolean
  afterMessage?: (message: ChatHistoryMessage) => ReactNode
  bodyTextClassName?: string
}) {
  return (
    <div
      ref={scrollRef}
      data-testid="chat-message-history"
      className="min-h-0 basis-0 flex-1 space-y-2 overflow-y-auto p-4"
      style={{ backgroundColor: '#7494C0' }}
    >
      {messages.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm text-white/60">メッセージはまだありません。</p>
        </div>
      ) : (
        messages.map((message, index) => {
          const previousMessage = index > 0 ? messages[index - 1] : null
          const showDateSeparator = !previousMessage
            || !sameYmd(previousMessage.createdAt, message.createdAt)
          const isOutgoing = message.direction === 'outgoing'

          let bubbleContent: ReactNode
          if (message.messageType === 'flex') {
            bubbleContent = (
              <div
                data-testid="chat-flex-message"
                className={expanded ? 'min-w-0 max-w-full' : 'max-w-[300px]'}
              >
                <FlexPreviewComponent content={message.content} maxWidth={280} />
              </div>
            )
          } else if (message.messageType === 'image') {
            try {
              const parsed = JSON.parse(message.content) as {
                originalContentUrl?: string
                previewImageUrl?: string
              }
              bubbleContent = (
                <img
                  src={parsed.originalContentUrl || parsed.previewImageUrl}
                  alt=""
                  className={`${expanded ? 'max-w-full sm:max-w-lg' : 'max-w-[200px]'} h-auto rounded`}
                />
              )
            } catch {
              bubbleContent = <span>🖼️ [画像]</span>
            }
          } else if (message.messageType === 'sticker') {
            bubbleContent = <StickerMessageImage content={message.content} />
          } else {
            bubbleContent = <span>{message.content}</span>
          }

          return (
            <div key={message.id}>
              {showDateSeparator && (
                <div className="my-3 flex justify-center">
                  <span className="rounded-full bg-black/20 px-2.5 py-0.5 text-[11px] text-white/85">
                    {formatYmdSlash(message.createdAt)}
                  </span>
                </div>
              )}
              <div className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                {!isOutgoing && (
                  friendPictureUrl ? (
                    <img
                      src={friendPictureUrl}
                      alt=""
                      className="mb-1 h-8 w-8 flex-shrink-0 rounded-full"
                    />
                  ) : (
                    <div className="mb-1 h-8 w-8 flex-shrink-0 rounded-full bg-gray-300" />
                  )
                )}

                <div className={`flex min-w-0 max-w-full flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
                  {isOutgoing && message.staffMemberName && (
                    <span className="mb-0.5 px-1 text-[11px] text-white/80">
                      担当: {message.staffMemberName}
                    </span>
                  )}
                  <div
                    data-testid="chat-message-bubble"
                    className={`${expanded ? 'w-fit max-w-full sm:max-w-3xl' : 'max-w-[320px]'} break-words whitespace-pre-wrap px-3 py-2 ${bodyTextClassName} ${
                      isOutgoing
                        ? 'rounded-bl-2xl rounded-br-2xl rounded-tl-2xl rounded-tr-md text-white'
                        : 'rounded-bl-2xl rounded-br-2xl rounded-tl-md rounded-tr-2xl bg-white text-gray-900'
                    }`}
                    style={isOutgoing ? { backgroundColor: '#06C755' } : undefined}
                  >
                    {bubbleContent}
                  </div>
                  <span className="mt-0.5 px-1 text-xs text-white/50">
                    {new Date(message.createdAt).toLocaleTimeString('ja-JP', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>
              {afterMessage?.(message)}
            </div>
          )
        })
      )}
    </div>
  )
}
