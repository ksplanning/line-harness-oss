'use client'

import { useSearchParams } from 'next/navigation'
import DataCockpitClient from './data-cockpit-client'

// static export 互換: 動的 [id]/data セグメントでなく ?id= クエリで entity を渡す (scenarios/detail 等と同流儀)。
export default function FormDataPage() {
  const params = useSearchParams()
  const id = params.get('id')
  if (!id) {
    return <div className="p-8 text-center text-sm text-gray-500">フォーム ID が指定されていません</div>
  }
  return <DataCockpitClient id={id} initialRowId={params.get('rowId')} />
}
