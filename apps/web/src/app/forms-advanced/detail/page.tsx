'use client'

import { useSearchParams } from 'next/navigation'
import FormBuilderClient from './form-builder-client'

// static export 互換: 動的 [id] セグメントでなく ?id= クエリで entity を渡す (scenarios/detail 等と同流儀)。
export default function FormBuilderDetailPage() {
  const id = useSearchParams().get('id')
  if (!id) {
    return <div className="p-8 text-center text-sm text-gray-500">フォーム ID が指定されていません</div>
  }
  return <FormBuilderClient id={id} />
}
