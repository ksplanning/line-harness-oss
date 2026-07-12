'use client'

/**
 * /scenarios/flow?id=<id> — シナリオを「線で繋いだ図」で読み取り表示するページ（Phase1）。
 *
 * static export（next.config.ts: output:'export'）では動的 `[id]` ルートが使えないため、
 * `?id=` クエリ + useSearchParams で回避する（L1）。
 * useSearchParams は Next15 の CSR-bailout 対策として <Suspense> 境界で包む
 * （events/edit・rich-menus/edit と同型。detail/page.tsx の bare 版は踏襲しない・codex-independent-check）。
 * データは既存 api.scenarios.get のみで取得（新 API・新 migration・新依存ゼロ = D-4 / read-only）。
 */

import { Suspense, useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import ScenarioFlowView from '@/components/scenarios/scenario-flow-view'
import type { ScenarioWithBranchSteps } from '@/lib/scenario-graph'

function ScenarioFlowInner() {
  const params = useSearchParams()
  const id = params.get('id')

  const [scenario, setScenario] = useState<ScenarioWithBranchSteps | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const res = await api.scenarios.get(id)
      if (res.success) {
        setScenario(res.data)
      } else {
        setError(res.error)
      }
    } catch {
      setError('シナリオの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  if (!id) {
    return (
      <>
        <Header title="フロー表示" />
        <div className="p-8 text-center text-sm text-gray-500">シナリオ ID が指定されていません</div>
      </>
    )
  }

  const actions = (
    <div className="flex gap-2">
      <Link
        href={`/scenarios/detail?id=${id}`}
        className="inline-flex min-h-[44px] items-center rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200"
      >
        ← シナリオ詳細
      </Link>
      <Link
        href="/scenarios"
        className="inline-flex min-h-[44px] items-center rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200"
      >
        一覧
      </Link>
    </div>
  )

  return (
    <>
      <Header title="フロー表示" action={actions} />

      {loading ? (
        <div className="animate-pulse space-y-4 rounded-lg border border-gray-200 bg-white p-8">
          <div className="h-6 w-1/3 rounded bg-gray-200" />
          <div className="h-4 w-2/3 rounded bg-gray-100" />
          <div className="h-4 w-1/2 rounded bg-gray-100" />
        </div>
      ) : error || !scenario ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
          <p className="text-gray-500">{error || 'シナリオが見つかりません'}</p>
          <Link href="/scenarios" className="mt-4 inline-block text-sm text-green-600 hover:text-green-700">
            ← シナリオ一覧に戻る
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-lg font-semibold text-gray-900">{scenario.name}</h2>
            {scenario.description && <p className="mt-1 text-sm text-gray-500">{scenario.description}</p>}
            <p className="mt-1 text-xs text-gray-400">
              全体像を図で確認できます（読み取り専用）。内容の編集はシナリオ詳細から行えます。
            </p>
          </div>
          <ScenarioFlowView scenario={scenario} />
        </div>
      )}
    </>
  )
}

export default function ScenarioFlowPage() {
  return (
    <Suspense fallback={<div className="p-4 text-gray-500">読み込み中...</div>}>
      <ScenarioFlowInner />
    </Suspense>
  )
}
