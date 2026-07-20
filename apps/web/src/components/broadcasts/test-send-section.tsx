'use client'

import type { TestSendMessage } from '@/lib/api'
import TestSendDialog from '@/components/shared/test-send-dialog'

interface TestSendSectionProps {
  /** 保存済み配信との対応を呼び側で追えるよう保持する。送信 payload には含めない。 */
  broadcastId: string
  accountIds: string[]
  messages: TestSendMessage[]
  disabled: boolean
  senderPresetId?: string | null
}

export default function TestSendSection({ accountIds, messages, disabled, senderPresetId }: TestSendSectionProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">テスト送信</h3>
      <TestSendDialog
        accountIds={accountIds}
        source="broadcast"
        messages={messages}
        buttonLabel="テスト送信する"
        disabled={disabled}
        senderPresetId={accountIds.length === 1 ? senderPresetId : null}
      />
    </div>
  )
}
