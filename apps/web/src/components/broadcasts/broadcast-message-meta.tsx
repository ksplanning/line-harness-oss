import { messageTypeLabels } from '@/lib/broadcast-labels'
import type { ApiBroadcast } from '@/lib/api'

/** combo(複数メッセージ)なら通数を、single なら 0 を返す (1 通は combo とみなさない)。 */
export function comboMessageCount(broadcast: Pick<ApiBroadcast, 'messages'>): number {
  return broadcast.messages && broadcast.messages.length > 1 ? broadcast.messages.length : 0
}

/**
 * 一覧の配信メタ表示 (broadcast-combo-messages Batch 2 / U6)。種別ラベル + combo バッジ。
 * 先頭ミラーだけを見ると combo が「1通」に見える誤認を防ぐため「N通のメッセージ」を明示する。
 */
export default function BroadcastMessageMeta({
  broadcast,
}: {
  broadcast: Pick<ApiBroadcast, 'messageType' | 'messages'>
}) {
  const n = comboMessageCount(broadcast)
  return (
    <span className="inline-flex items-center gap-1">
      {messageTypeLabels[broadcast.messageType]}
      {n > 0 && (
        <span className="inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium bg-blue-100 text-blue-700">
          {n}通のメッセージ
        </span>
      )}
    </span>
  )
}
