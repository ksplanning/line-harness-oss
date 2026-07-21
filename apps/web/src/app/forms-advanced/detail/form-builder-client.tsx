'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import FormBuilder from '@/components/forms-advanced/builder'
import SharePanel from '@/components/forms-advanced/share-panel'
import InstantWebhookSettings from '@/components/forms-advanced/instant-webhook-settings'
import { formsAdvancedApi, type AdvancedForm, type RenderBackend, type ShareInfo } from '@/lib/formaloo-advanced-api'
import { fetchApi } from '@/lib/api'
import { sheetsConnectionsApi, type SheetsConnection } from '@/lib/sheets-connections-api'
import { useAccount } from '@/contexts/account-context'
import type { FriendFieldDefinition, HarnessField, HarnessLogicRule, FormDesign, FormDesignImages, FormDisplayType, FormCopy, FormRedirect, SuccessPageSpec, FriendMetadataMapping, FormOperationsSettingsPatch } from '@line-crm/shared'

// F-2/F-5 フォームビルダー本体。id は detail/page.tsx が ?id= から解決して渡す (static export 互換 / 新地雷)。
export default function FormBuilderClient({ id }: { id: string }) {
  const { selectedAccountId } = useAccount()
  const [form, setForm] = useState<AdvancedForm | null>(null)
  const [renderBackend, setRenderBackend] = useState<RenderBackend>('formaloo')
  const [share, setShare] = useState<ShareInfo | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fieldDefinitions, setFieldDefinitions] = useState<FriendFieldDefinition[]>([])
  const [internalSheetConnection, setInternalSheetConnection] = useState<SheetsConnection | null>(null)
  const shareRequestGeneration = useRef(0)
  const loadRequestGeneration = useRef(0)

  const invalidateShare = useCallback(() => {
    shareRequestGeneration.current += 1
    setShare(null)
  }, [])

  const loadShare = useCallback(async () => {
    const generation = ++shareRequestGeneration.current
    try {
      const loadedShare = await formsAdvancedApi.share(id)
      if (generation === shareRequestGeneration.current) setShare(loadedShare)
    } catch {
      // Provider/status changes invalidate every previously displayed URL.
      if (generation === shareRequestGeneration.current) setShare(null)
    }
  }, [id])

  const load = useCallback(async () => {
    const generation = ++loadRequestGeneration.current
    setLoading(true)
    invalidateShare()
    try {
      const loadedForm = await formsAdvancedApi.get(id)
      if (generation !== loadRequestGeneration.current) return
      if (loadedForm.renderBackend !== 'formaloo' && loadedForm.renderBackend !== 'internal') {
        setForm(null)
        setShare(null)
        setError('配信方式を確認できません。再読み込みしてください')
        return
      }
      setForm(loadedForm)
      setRenderBackend(loadedForm.renderBackend)
      setError(null)
      await loadShare()
      if (generation !== loadRequestGeneration.current) return
      try {
        const me = await fetchApi<{ data: { role: string } }>('/api/staff/me')
        if (generation === loadRequestGeneration.current) setIsOwner(me.data.role === 'owner')
      } catch { /* 非 owner 扱い */ }
    } catch {
      if (generation === loadRequestGeneration.current) setError('フォームが見つかりません')
    } finally {
      if (generation === loadRequestGeneration.current) setLoading(false)
    }
  }, [id, invalidateShare, loadShare])

  useEffect(() => {
    void load()
    return () => {
      loadRequestGeneration.current += 1
      shareRequestGeneration.current += 1
    }
  }, [load])

  useEffect(() => {
    let active = true
    void fetchApi<{ success: boolean; data: FriendFieldDefinition[] }>('/api/friend-field-definitions')
      .then((response) => {
        if (active && response.success && Array.isArray(response.data)) {
          setFieldDefinitions(response.data)
        }
      })
      .catch(() => {
        // Fail-soft: mapping suggestions must not block the form builder.
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    setInternalSheetConnection(null)
    const formId = form?.id
    const formLineAccountId = form?.lineAccountId ?? null
    if (
      renderBackend !== 'internal'
      || !isOwner
      || !formId
      || (formLineAccountId !== null && formLineAccountId !== selectedAccountId)
    ) {
      return () => { active = false }
    }
    const accountId = formLineAccountId ?? selectedAccountId
    if (!accountId) return () => { active = false }

    void sheetsConnectionsApi.list(accountId, formId)
      .then((connections) => {
        if (active) setInternalSheetConnection(connections[0] ?? null)
      })
      .catch(() => {
        if (active) setInternalSheetConnection(null)
      })
    return () => { active = false }
  }, [form?.id, form?.lineAccountId, isOwner, renderBackend, selectedAccountId])

  const withErr = (
    fn: () => Promise<AdvancedForm>,
    expectedStatus?: AdvancedForm['builderStatus'],
    expectedPublishRevision?: string,
  ) => async (): Promise<boolean> => {
    const expectedBackend = renderBackend
    invalidateShare()
    try {
      const updated = await fn()
      setForm(updated)
      setRenderBackend(updated.renderBackend)
      setNotice(null)
      await loadShare() // publish/unpublish で埋め込みコードの有効/無効が変わる (N-7)
      return true
    } catch (e) {
      // 自前公開は D1 が権威。応答ロスト時は再読込し、既に期待状態なら失敗表示へ戻さない。
      if (expectedBackend === 'internal' && expectedStatus && expectedPublishRevision !== undefined) {
        try {
          const authoritative = await formsAdvancedApi.get(id)
          setForm(authoritative)
          setRenderBackend(authoritative.renderBackend)
          await loadShare()
          if (authoritative.renderBackend === expectedBackend
            && authoritative.builderStatus === expectedStatus
            && authoritative.publishRevision === expectedPublishRevision) {
            setNotice(null)
            return true
          }
        } catch {
          // 下の元エラー表示へ進む。
        }
      }
      const body = (e as { body?: { error?: string } })?.body
      setNotice(body?.error ?? '操作に失敗しました')
      return false
    }
  }

  const handleSave = async (def: { fields: HarnessField[]; logic: HarnessLogicRule[]; rawLogic?: unknown; logicFingerprint?: string | null; title?: string; description?: string | null; design?: FormDesign; designImages?: FormDesignImages; formType?: FormDisplayType; formCopy?: FormCopy; formRedirect?: FormRedirect; successPages?: SuccessPageSpec[]; friendMetadataMappings?: FriendMetadataMapping[]; operationsSettings?: FormOperationsSettingsPatch; allowPostEdit?: number; allowEditMail?: number; editMailFieldId?: string | null }) => {
    const expectedBackend = renderBackend
    invalidateShare()
    try {
      // preserve-raw: builder が carry した rawLogic + logicFingerprint をそのまま save body へ渡す。
      // form-design: design(色) + designImages(画像 intent) / form-route-branching: formType も同梱される。
      const updated = await formsAdvancedApi.saveDefinition(id, def, expectedBackend)
      setForm(updated)
      setRenderBackend(updated.renderBackend)
      await loadShare()
      const synced = updated.syncStatus !== 'out_of_sync'
      // F1: 画像同期失敗など out_of_sync 時は syncError を honest に表示 (silent success にしない)。
      setNotice(synced ? '保存しました' : (updated.syncError ?? '保存しました（Formaloo 未接続のためローカル保存）'))
      // F3: builder に確定結果を返す (ok=完全同期時のみ pending 画像 intent を消費 / design=新 S3 URL 含む)。
      //     form-route-branching: jump+simple backstop 等の非ブロッキング警告も返す。
      return {
        ok: synced,
        design: updated.design ?? undefined,
        warnings: updated.warnings,
        publishRevision: updated.publishRevision,
      }
    } catch (e) {
      const body = (e as { body?: { error?: string } })?.body
      setNotice(body?.error ?? '保存に失敗しました')
      if (expectedBackend === 'internal') {
        try {
          const authoritative = await formsAdvancedApi.get(id)
          setForm(authoritative)
          setRenderBackend(authoritative.renderBackend)
          await loadShare()
        } catch {
          // 元の失敗表示を維持する。
        }
      }
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
      setNotice(body?.error ?? 'スプレッドシートの再同期に失敗しました')
    } finally {
      setConnecting(false)
    }
  }

  const handleRenderBackendChange = async (next: RenderBackend) => {
    invalidateShare()
    try {
      const confirmed = await formsAdvancedApi.setRenderBackend(id, next)
      const authoritative = await formsAdvancedApi.get(id).catch(() => null)
      if (authoritative) {
        setRenderBackend(authoritative.renderBackend)
        setForm(authoritative)
      } else {
        // The switch endpoint guarantees either backend starts as draft. Keep
        // stale provider URLs hidden even if the follow-up detail response is lost.
        setRenderBackend(confirmed)
        setForm((current) => current ? {
          ...current,
          builderStatus: 'draft',
          publicUrl: null,
          embedCode: null,
        } : current)
      }
      await loadShare()
      const currentBackend = authoritative?.renderBackend ?? confirmed
      setNotice(currentBackend === 'internal' ? '自前配信 (β) に切り替えました' : 'Formaloo 配信に切り替えました')
      return currentBackend
    } catch (error) {
      try {
        const authoritativeForm = await formsAdvancedApi.get(id)
        setRenderBackend(authoritativeForm.renderBackend)
        setForm(authoritativeForm)
        await loadShare()
        if (authoritativeForm.renderBackend === next) {
          setNotice(next === 'internal' ? '自前配信 (β) に切り替えました' : 'Formaloo 配信に切り替えました')
          return authoritativeForm.renderBackend
        }
      } catch {
        // 下の失敗表示へ進む。
      }
      const body = (error as { body?: { error?: string } })?.body
      setNotice(body?.error ?? '配信方式の変更に失敗しました')
      throw error
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
          {renderBackend === 'formaloo' && (
            <div className="mb-4">
              <InstantWebhookSettings formId={form.id} />
            </div>
          )}
          <FormBuilder
            key={`${form.id}:${form.builderStatus}:${renderBackend}`}
            formId={form.id}
            formTitle={form.title}
            formDescription={form.description}
            status={form.builderStatus}
            initialFields={form.fields}
            initialLogic={form.logic}
            initialLogicFingerprint={form.logicFingerprint}
            initialDesign={form.design ?? undefined}
            initialFormType={form.formType ?? undefined}
            initialFormCopy={form.formCopy ?? undefined}
            initialFormRedirect={form.formRedirect ?? undefined}
            initialSuccessPages={form.successPages ?? undefined}
            initialFriendMetadataMappings={form.friendMetadataMappings ?? undefined}
            initialOperationsSettings={form.operationsSettings ?? undefined}
            initialRenderBackend={renderBackend}
            internalAvailability={form.internalAvailability}
            fieldDefinitions={fieldDefinitions}
            initialAllowPostEdit={form.allowPostEdit}
            initialAllowEditMail={form.allowEditMail}
            initialEditMailFieldId={form.editMailFieldId}
            syncStatus={form.syncStatus}
            syncError={form.syncError}
            driftStatus={form.driftStatus}
            publicUrl={renderBackend === 'internal' ? (share?.publicUrl ?? null) : form.publicUrl}
            embedCode={renderBackend === 'internal' ? null : form.embedCode}
            onSave={handleSave}
            onRenderBackendChange={handleRenderBackendChange}
            onSubmitForReview={renderBackend === 'formaloo' ? withErr(() => formsAdvancedApi.submitForReview(id, renderBackend), 'in_review') : undefined}
            onPublish={renderBackend === 'internal'
              ? (publishRevision) => withErr(
                  () => formsAdvancedApi.publish(id, publishRevision, renderBackend),
                  'published',
                  publishRevision,
                )()
              : withErr(() => formsAdvancedApi.publish(id, undefined, renderBackend), 'published')}
            onUnpublish={renderBackend === 'internal'
              ? withErr(
                  () => formsAdvancedApi.unpublish(id, renderBackend, form.updatedAt),
                  'draft',
                  form.publishRevision,
                )
              : withErr(() => formsAdvancedApi.unpublish(id, renderBackend), 'draft')}
            onReimport={renderBackend === 'formaloo' ? async () => {
              try {
                const d = await formsAdvancedApi.reimport(id)
                setNotice(d.note)
                return d
              } catch (e) {
                const body = (e as { body?: { error?: string } })?.body
                setNotice(body?.error ?? '再取り込みに失敗しました')
                return null
              }
            } : undefined}
          />
          <div className="mt-4">
            <SharePanel share={share} renderBackend={renderBackend} isOwner={isOwner} internalSheetConnection={internalSheetConnection} connecting={connecting} onConnectSheets={handleConnectSheets} />
          </div>
        </>
      ) : null}
    </div>
  )
}
