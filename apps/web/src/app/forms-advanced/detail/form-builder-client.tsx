'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import FormBuilder from '@/components/forms-advanced/builder'
import SharePanel from '@/components/forms-advanced/share-panel'
import { formsAdvancedApi, type AdvancedForm, type ShareInfo } from '@/lib/formaloo-advanced-api'
import { fetchApi } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import type { HarnessField, HarnessLogicRule, FormDesign, FormDesignImages, FormDisplayType, FormCopy, FormRedirect, SuccessPageSpec, FriendMetadataMapping } from '@line-crm/shared'

// F-2/F-5 フォームビルダー本体。id は detail/page.tsx が ?id= から解決して渡す (static export 互換 / 新地雷)。
export default function FormBuilderClient({ id }: { id: string }) {
  const { selectedAccountId } = useAccount()
  const [form, setForm] = useState<AdvancedForm | null>(null)
  const [share, setShare] = useState<ShareInfo | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadShare = useCallback(async () => {
    try { setShare(await formsAdvancedApi.share(id)) } catch { /* fail-soft */ }
  }, [id])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setForm(await formsAdvancedApi.get(id))
      setError(null)
      await loadShare()
      try {
        const me = await fetchApi<{ data: { role: string } }>('/api/staff/me')
        setIsOwner(me.data.role === 'owner')
      } catch { /* 非 owner 扱い */ }
    } catch {
      setError('フォームが見つかりません')
    } finally {
      setLoading(false)
    }
  }, [id, loadShare])

  useEffect(() => {
    void load()
  }, [load])

  const withErr = (fn: () => Promise<AdvancedForm>) => async () => {
    try {
      setForm(await fn())
      setNotice(null)
      await loadShare() // publish/unpublish で埋め込みコードの有効/無効が変わる (N-7)
    } catch (e) {
      const body = (e as { body?: { error?: string } })?.body
      setNotice(body?.error ?? '操作に失敗しました')
    }
  }

  const handleSave = async (def: { fields: HarnessField[]; logic: HarnessLogicRule[]; rawLogic?: unknown; logicFingerprint?: string | null; title?: string; description?: string | null; design?: FormDesign; designImages?: FormDesignImages; formType?: FormDisplayType; formCopy?: FormCopy; formRedirect?: FormRedirect; successPages?: SuccessPageSpec[]; friendMetadataMappings?: FriendMetadataMapping[]; allowPostEdit?: number; allowEditMail?: number }) => {
    try {
      // preserve-raw: builder が carry した rawLogic + logicFingerprint をそのまま save body へ渡す。
      // form-design: design(色) + designImages(画像 intent) / form-route-branching: formType も同梱される。
      const updated = await formsAdvancedApi.saveDefinition(id, def)
      setForm(updated)
      await loadShare()
      const synced = updated.syncStatus !== 'out_of_sync'
      // F1: 画像同期失敗など out_of_sync 時は syncError を honest に表示 (silent success にしない)。
      setNotice(synced ? '保存しました' : (updated.syncError ?? '保存しました（Formaloo 未接続のためローカル保存）'))
      // F3: builder に確定結果を返す (ok=完全同期時のみ pending 画像 intent を消費 / design=新 S3 URL 含む)。
      //     form-route-branching: jump+simple backstop 等の非ブロッキング警告も返す。
      return { ok: synced, design: updated.design ?? undefined, warnings: updated.warnings }
    } catch (e) {
      const body = (e as { body?: { error?: string } })?.body
      setNotice(body?.error ?? '保存に失敗しました')
      // throw 経路は void 返却 = builder は pending 画像 intent を保持し再試行可能。
    }
  }

  const handleConnectSheets = async () => {
    setConnecting(true)
    try {
      const r = await formsAdvancedApi.connectGsheet(id)
      setNotice(r.note)
      await loadShare()
    } catch (e) {
      const body = (e as { body?: { error?: string } })?.body
      setNotice(body?.error ?? 'スプレッドシート連携に失敗しました')
    } finally {
      setConnecting(false)
    }
  }

  // F6-2 表示スコープ照合 (Codex B#3): 別アカウント向け form (lineAccountId != null かつ 選択アカウント不一致)
  //   は表示しない。NULL 共通は全アカウントで許容。これは表示フィルタであり、API 直打ちは防げない (N-17)。
  const scopeBlocked =
    form != null && form.lineAccountId != null && selectedAccountId != null && form.lineAccountId !== selectedAccountId
  // reviewer R1 P2 fail-closed: account-scoped form (lineAccountId != null) で selectedAccountId が未確定
  //   (null: cold 直 visit / zero-account / discovery 失敗) の間は scope 判定不能 → 内容を描画せず hold する。
  const scopeUnknown = form != null && form.lineAccountId != null && selectedAccountId == null

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
      ) : scopeUnknown ? (
        <div data-testid="scope-hold" className="text-sm text-gray-400">アカウントを確認しています...</div>
      ) : scopeBlocked ? (
        <div data-testid="scope-blocked" className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500 text-sm">
          このフォームは別の LINE アカウント向けです。表示するには対象のアカウントに切り替えてください。
          <div className="mt-2">
            <Link href="/forms-advanced" className="text-xs text-gray-500 underline">← 一覧に戻る</Link>
          </div>
          <p className="mt-3 text-[11px] text-gray-400">※これは画面上の仕分けです。URL を直接開くと表示される場合があります（アクセス制限は今後の対応です）。</p>
        </div>
      ) : form ? (
        <>
          {notice && (
            <div className="mb-3 text-xs px-3 py-2 rounded bg-gray-50 border border-gray-200 text-gray-700">{notice}</div>
          )}
          <FormBuilder
            key={`${form.id}:${form.builderStatus}`}
            formTitle={form.title}
            formDescription={form.description}
            status={form.builderStatus}
            initialFields={form.fields}
            initialLogic={form.logic}
            initialLogicFingerprint={form.logicFingerprint}
            initialDesign={form.design ?? undefined}
            initialFormType={form.formType ?? undefined}
            initialFormRedirect={form.formRedirect ?? undefined}
            initialSuccessPages={form.successPages ?? undefined}
            initialFriendMetadataMappings={form.friendMetadataMappings ?? undefined}
            initialAllowPostEdit={form.allowPostEdit}
            initialAllowEditMail={form.allowEditMail}
            syncStatus={form.syncStatus}
            syncError={form.syncError}
            driftStatus={form.driftStatus}
            publicUrl={form.publicUrl}
            embedCode={form.embedCode}
            onSave={handleSave}
            onSubmitForReview={withErr(() => formsAdvancedApi.submitForReview(id))}
            onPublish={withErr(() => formsAdvancedApi.publish(id))}
            onUnpublish={withErr(() => formsAdvancedApi.unpublish(id))}
            onReimport={async () => {
              try {
                const d = await formsAdvancedApi.reimport(id)
                setNotice(d.note)
                return d
              } catch (e) {
                const body = (e as { body?: { error?: string } })?.body
                setNotice(body?.error ?? '再取り込みに失敗しました')
                return null
              }
            }}
          />
          <div className="mt-4">
            <SharePanel share={share} isOwner={isOwner} connecting={connecting} onConnectSheets={handleConnectSheets} />
          </div>
        </>
      ) : null}
    </div>
  )
}
