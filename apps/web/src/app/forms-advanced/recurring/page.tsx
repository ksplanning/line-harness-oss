'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import RecurringSubmissionsClient from './recurring-submissions-client'

function RecurringSubmissionsInner() {
  const id = useSearchParams().get('id')
  if (!id) {
    return <div className="p-8 text-center text-sm text-gray-500">フォーム ID が指定されていません</div>
  }
  return <RecurringSubmissionsClient formId={id} />
}

export default function RecurringSubmissionsPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-gray-500">読み込み中...</div>}>
      <RecurringSubmissionsInner />
    </Suspense>
  )
}
