'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import InquiryConsoleClient from './inquiry-console-client'

function InquiryConsoleRoute() {
  const searchParams = useSearchParams()
  const friendId = searchParams.get('friend')

  if (!friendId) {
    return (
      <main className="flex h-[100dvh] items-center justify-center px-6 text-center">
        <div>
          <h1 className="text-lg font-bold text-gray-900">問い合わせを特定できません</h1>
          <p className="mt-2 text-sm text-gray-600">通知に記載されたリンクから開いてください。</p>
        </div>
      </main>
    )
  }

  return <InquiryConsoleClient friendId={friendId} />
}

export default function InquiryConsolePage() {
  return (
    <Suspense
      fallback={(
        <main className="flex h-[100dvh] items-center justify-center px-6">
          <p className="text-sm text-gray-600">問い合わせを開いています…</p>
        </main>
      )}
    >
      <InquiryConsoleRoute />
    </Suspense>
  )
}
