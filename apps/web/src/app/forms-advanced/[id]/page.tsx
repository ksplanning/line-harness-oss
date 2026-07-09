'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import FormBuilder from '@/components/forms-advanced/builder'
import { formsAdvancedApi, type AdvancedForm } from '@/lib/formaloo-advanced-api'
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared'

export default function FormBuilderPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [form, setForm] = useState<AdvancedForm | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setForm(await formsAdvancedApi.get(id))
      setError(null)
    } catch {
      setError('フォームが見つかりません')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const withErr = (fn: () => Promise<AdvancedForm>) => async () => {
    try {
      setForm(await fn())
      setNotice(null)
    } catch (e) {
      const body = (e as { body?: { error?: string } })?.body
      setNotice(body?.error ?? '操作に失敗しました')
    }
  }

  const handleSave = async (def: { fields: HarnessField[]; logic: HarnessLogicRule[] }) => {
    try {
      const updated = await formsAdvancedApi.saveDefinition(id, def)
      setForm(updated)
      setNotice(updated.syncStatus === 'out_of_sync' ? '保存しました（Formaloo 未接続のためローカル保存）' : '保存しました')
    } catch (e) {
      const body = (e as { body?: { error?: string } })?.body
      setNotice(body?.error ?? '保存に失敗しました')
    }
  }

  return (
    <div>
      <Header title="フォームビルダー" description="項目をドラッグ&ドロップして高機能フォームを組み立てます" />
      <div className="mb-3">
        <Link href="/forms-advanced" className="text-xs text-gray-500 hover:text-gray-800">← 一覧に戻る</Link>
      </div>

      {loading ? (
        <div className="text-sm text-gray-400">読み込み中...</div>
      ) : error ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400 text-sm">{error}</div>
      ) : form ? (
        <>
          {notice && (
            <div className="mb-3 text-xs px-3 py-2 rounded bg-gray-50 border border-gray-200 text-gray-700">{notice}</div>
          )}
          <FormBuilder
            key={`${form.id}:${form.builderStatus}`}
            formTitle={form.title}
            status={form.builderStatus}
            initialFields={form.fields}
            initialLogic={form.logic}
            syncStatus={form.syncStatus}
            publicUrl={form.publicUrl}
            embedCode={form.embedCode}
            onSave={handleSave}
            onSubmitForReview={withErr(() => formsAdvancedApi.submitForReview(id))}
            onPublish={withErr(() => formsAdvancedApi.publish(id))}
            onUnpublish={withErr(() => formsAdvancedApi.unpublish(id))}
          />
        </>
      ) : null}
    </div>
  )
}
