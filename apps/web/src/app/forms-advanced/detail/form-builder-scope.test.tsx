// @vitest-environment jsdom
/**
 * T-B3 (F6-2 / web 詳細画面) — 表示スコープ照合 (Codex B#3)。
 *   - form.lineAccountId != null かつ 選択アカウント不一致 → scope-blocked (ビルダー非表示)。
 *   - NULL 共通 form / 一致 form は表示 (blocked でない)。
 *   ※ 表示フィルタで API 直打ちは防げない旨 (N-17) を画面に明記。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import type { ReactNode } from 'react'

const builderProps = vi.hoisted(() => ({ current: undefined as Record<string, unknown> | undefined }))
const sharePanelProps = vi.hoisted(() => ({ current: undefined as Record<string, unknown> | undefined }))
const notificationSettingsProps = vi.hoisted(() => ({ current: undefined as Record<string, unknown> | undefined }))
const mockAccount: { selectedAccountId: string | null } = { selectedAccountId: 'acc_A' }
const getMock = vi.fn()
const getRenderBackendMock = vi.fn()
const setRenderBackendMock = vi.fn()
const shareMock = vi.fn()
const saveDefinitionMock = vi.fn()
const sheetsListMock = vi.fn()
const submitForReviewMock = vi.fn()
const publishMock = vi.fn()
const unpublishMock = vi.fn()
const reimportMock = vi.fn()
const fetchApiMock = vi.fn()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/forms-advanced/builder', () => ({
  default: (props: Record<string, unknown>) => {
    builderProps.current = props
    return <div data-testid="form-builder" />
  },
}))
vi.mock('@/components/forms-advanced/share-panel', () => ({
  default: (props: Record<string, unknown>) => {
    sharePanelProps.current = props
    return null
  },
}))
vi.mock('@/components/forms-advanced/internal-submission-notification-settings', () => ({
  default: (props: Record<string, unknown>) => {
    notificationSettingsProps.current = props
    return <div data-testid="notification-settings" />
  },
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: {
    get: (...a: unknown[]) => getMock(...a),
    getRenderBackend: (...a: unknown[]) => getRenderBackendMock(...a),
    setRenderBackend: (...a: unknown[]) => setRenderBackendMock(...a),
    share: (...a: unknown[]) => shareMock(...a),
    saveDefinition: (...a: unknown[]) => saveDefinitionMock(...a),
    submitForReview: (...a: unknown[]) => submitForReviewMock(...a),
    publish: (...a: unknown[]) => publishMock(...a),
    unpublish: (...a: unknown[]) => unpublishMock(...a),
    reimport: (...a: unknown[]) => reimportMock(...a),
  },
}))
vi.mock('@/lib/sheets-connections-api', () => ({
  sheetsConnectionsApi: {
    list: (...a: unknown[]) => sheetsListMock(...a),
  },
}))
vi.mock('@/lib/api', () => ({ fetchApi: (...a: unknown[]) => fetchApiMock(...a) }))

import FormBuilderClient from './form-builder-client'

function form(lineAccountId: string | null, renderBackend: 'formaloo' | 'internal' = 'formaloo') {
  return { id: 'fa1', title: 'F', description: null, formalooSlug: null, renderBackend, builderStatus: 'draft', publishedAt: null, submitCount: 0, fields: [], logic: [], publicUrl: null, embedCode: null, syncStatus: 'idle', syncError: null, lineAccountId, updatedAt: 'x' }
}

beforeEach(() => {
  getMock.mockReset(); getRenderBackendMock.mockReset(); setRenderBackendMock.mockReset(); shareMock.mockReset(); saveDefinitionMock.mockReset(); sheetsListMock.mockReset(); submitForReviewMock.mockReset(); publishMock.mockReset(); unpublishMock.mockReset(); reimportMock.mockReset(); fetchApiMock.mockReset()
  builderProps.current = undefined
  sharePanelProps.current = undefined
  notificationSettingsProps.current = undefined
  mockAccount.selectedAccountId = 'acc_A'
  getRenderBackendMock.mockResolvedValue('formaloo')
  setRenderBackendMock.mockImplementation(async (_id: string, backend: string) => backend)
  sheetsListMock.mockResolvedValue([])
  shareMock.mockResolvedValue({ published: false, publicUrl: null, iframeCode: null, scriptCode: null, gsheetConnected: false, gsheetUrl: null })
  fetchApiMock.mockImplementation(async (path: string) => (
    path === '/api/friend-field-definitions'
      ? { success: true, data: [{
          id: 'def-1', name: '入金確認', defaultValue: '未', displayOrder: 0, isActive: true,
          createdAt: '2026-07-19', updatedAt: '2026-07-19',
        }] }
      : { data: { role: 'owner' } }
  ))
})
afterEach(() => cleanup())

describe('詳細画面 scope 照合', () => {
  it('別アカウント form は scope-blocked (ビルダー非表示)', async () => {
    getMock.mockResolvedValue(form('acc_B'))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('scope-blocked')).toBeTruthy())
    expect(screen.queryByTestId('form-builder')).toBeNull()
    expect(sheetsListMock).not.toHaveBeenCalled()
  })

  it('NULL 共通 form は表示 (blocked でない)', async () => {
    getMock.mockResolvedValue(form(null))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    expect(screen.queryByTestId('scope-blocked')).toBeNull()
  })

  it('一致アカウント form は表示', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    expect(screen.queryByTestId('scope-blocked')).toBeNull()
  })

  it('tenant 定義を別取得して builder の候補 props に渡す', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(builderProps.current?.fieldDefinitions).toEqual([
      expect.objectContaining({ name: '入金確認', defaultValue: '未', isActive: true }),
    ]))
    expect(fetchApiMock).toHaveBeenCalledWith('/api/friend-field-definitions')
  })

  it('定義 API が失敗してもフォーム本体は表示する', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    fetchApiMock.mockImplementation(async (path: string) => {
      if (path === '/api/friend-field-definitions') throw new Error('definitions unavailable')
      return { data: { role: 'owner' } }
    })
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    expect(builderProps.current?.fieldDefinitions).toEqual([])
  })

  it('フォーム説明を builder に渡し、title/description を saveDefinition へ欠落なく転送する', async () => {
    const loaded = { ...form('acc_A'), title: '旧タイトル', description: '旧説明' }
    getMock.mockResolvedValue(loaded)
    saveDefinitionMock.mockResolvedValue({ ...loaded, title: '新タイトル', description: '' })
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())

    expect(builderProps.current?.formDescription).toBe('旧説明')
    await act(async () => {
      await (builderProps.current?.onSave as (def: Record<string, unknown>) => Promise<void>)({
        fields: [], logic: [], title: '新タイトル', description: '',
      })
    })
    expect(saveDefinitionMock).toHaveBeenCalledWith('fa1', {
      fields: [], logic: [], title: '新タイトル', description: '',
    }, 'formaloo')
  })

  it('配信方式と公開状態を同じ詳細応答のスナップショットから復元する', async () => {
    getMock.mockResolvedValue({
      ...form('acc_A'),
      renderBackend: 'internal',
      builderStatus: 'published',
      publicUrl: 'https://api.example.test/f/fa1',
    })
    getRenderBackendMock.mockResolvedValue('formaloo')
    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(builderProps.current?.initialRenderBackend).toBe('internal'))
    expect(builderProps.current?.status).toBe('published')
    expect(getRenderBackendMock).not.toHaveBeenCalled()
  })

  it('自前公開の送信ボタンと完了文言を builder に復元する', async () => {
    getMock.mockResolvedValue({
      ...form('acc_A', 'internal'),
      formCopy: { buttonText: '申し込む', successMessage: '受付完了' },
    })

    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(builderProps.current?.initialFormCopy).toEqual({
      buttonText: '申し込む',
      successMessage: '受付完了',
    }))
  })

  it('自前保存の確認 revision を builder へ欠落なく返す', async () => {
    const loaded = form('acc_A', 'internal')
    getMock.mockResolvedValue(loaded)
    saveDefinitionMock.mockResolvedValue({ ...loaded, publishRevision: 'revision-after-save' })
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())

    let result: unknown
    await act(async () => {
      result = await (builderProps.current?.onSave as (def: Record<string, unknown>) => Promise<unknown>)({
        fields: [], logic: [], title: 'F',
      })
    })

    expect(saveDefinitionMock).toHaveBeenCalledWith('fa1', {
      fields: [], logic: [], title: 'F',
    }, 'internal')
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      publishRevision: 'revision-after-save',
    }))
  })

  it('builder の配信方式変更を専用 endpoint にだけ保存する', async () => {
    getMock
      .mockResolvedValueOnce(form('acc_A'))
      .mockResolvedValue(form('acc_A', 'internal'))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())

    await act(async () => {
      await (builderProps.current?.onRenderBackendChange as (backend: string) => Promise<void>)('internal')
    })

    expect(setRenderBackendMock).toHaveBeenCalledWith('fa1', 'internal')
    expect(saveDefinitionMock).not.toHaveBeenCalled()
  })

  it('公開中フォームを自前配信へ切り替えた直後に authoritative draft 状態へ更新する', async () => {
    const published = { ...form('acc_A'), builderStatus: 'published', publicUrl: 'https://formaloo.example.test/form' }
    const internalDraft = { ...form('acc_A', 'internal'), builderStatus: 'draft', publicUrl: null }
    getMock.mockResolvedValueOnce(published).mockResolvedValue(internalDraft)
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(builderProps.current?.status).toBe('published'))

    await act(async () => {
      await (builderProps.current?.onRenderBackendChange as (backend: string) => Promise<void>)('internal')
    })

    await waitFor(() => expect(builderProps.current?.status).toBe('draft'))
    expect(builderProps.current?.publicUrl).toBeNull()
    expect(getMock).toHaveBeenCalledTimes(2)
  })

  it('backend切替の応答だけ失われてもauthoritative状態へ同期する', async () => {
    const initial = form('acc_A')
    const internalDraft = { ...initial, renderBackend: 'internal', builderStatus: 'draft', publicUrl: null }
    getMock.mockResolvedValueOnce(initial).mockResolvedValue(internalDraft)
    setRenderBackendMock.mockRejectedValue(new Error('response lost'))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(builderProps.current?.initialRenderBackend).toBe('formaloo'))

    await act(async () => {
      await (builderProps.current?.onRenderBackendChange as (backend: string) => Promise<void>)('internal')
    })

    await waitFor(() => expect(builderProps.current?.initialRenderBackend).toBe('internal'))
    expect(builderProps.current?.status).toBe('draft')
    expect(getRenderBackendMock).not.toHaveBeenCalled()
  })

  it('internalからFormalooへ切替成功後の詳細再取得失敗でもdraftとURL無効を表示する', async () => {
    const internalPublished = {
      ...form('acc_A', 'internal'),
      builderStatus: 'published',
      publicUrl: 'https://api.example.test/f/fa1',
      publishRevision: 'internal-revision',
    }
    getMock.mockResolvedValueOnce(internalPublished).mockRejectedValueOnce(new Error('detail unavailable'))
    setRenderBackendMock.mockResolvedValue('formaloo')
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(builderProps.current?.status).toBe('published'))

    await act(async () => {
      await (builderProps.current?.onRenderBackendChange as (backend: string) => Promise<void>)('formaloo')
    })

    await waitFor(() => expect(builderProps.current?.initialRenderBackend).toBe('formaloo'))
    expect(builderProps.current?.status).toBe('draft')
    expect(builderProps.current?.publicUrl).toBeNull()
  })

  it('配信方式の読込に失敗した場合はproviderを推測せず編集画面を閉じる', async () => {
    getMock.mockResolvedValue({ ...form('acc_A'), renderBackend: 'unexpected' })
    render(<FormBuilderClient id="fa1" />)

    expect(await screen.findByText('配信方式を確認できません。再読み込みしてください')).toBeTruthy()
    expect(screen.queryByTestId('form-builder')).toBeNull()
  })

  it('自前配信では local 公開 URL を表示しつつ Formaloo 専用 Sheets 操作を隠す', async () => {
    getMock.mockResolvedValue(form('acc_A', 'internal'))
    shareMock.mockResolvedValue({
      published: true,
      publicUrl: 'https://api.example.test/f/fa1',
      lineDistUrl: null,
      iframeCode: null,
      scriptCode: null,
      gsheetConnected: false,
      gsheetUrl: null,
    })
    const connection = {
      id: 'gsc_1', lineAccountId: 'acc_A', formId: 'fa1', spreadsheetId: 'sheet_1', sheetName: '回答一覧',
      syncDirection: 'bidirectional', conflictPolicy: 'last_write_wins', friendFieldMappings: [],
      friendLedgerEnabled: true, lastSyncAt: '2026-07-21T10:00:00.000+09:00', lastSyncStatus: 'success',
      lastSyncWarning: null, isActive: true, createdAt: 'x', updatedAt: 'x',
    }
    sheetsListMock.mockResolvedValue([connection])
    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(sharePanelProps.current?.share).toEqual(expect.objectContaining({
      publicUrl: 'https://api.example.test/f/fa1',
    })))
    expect(builderProps.current?.publicUrl).toBe('https://api.example.test/f/fa1')
    expect(builderProps.current?.embedCode).toBeNull()
    await waitFor(() => expect(sharePanelProps.current?.internalSheetConnection).toEqual(connection))
    expect(sheetsListMock).toHaveBeenCalledWith('acc_A', 'fa1')
    expect(sharePanelProps.current?.renderBackend).toBe('internal')
    expect(sharePanelProps.current?.isOwner).toBe(true)
    expect(screen.queryByTestId('instant-webhook-settings')).toBeNull()
    expect(builderProps.current?.onSubmitForReview).toBeUndefined()
    expect(builderProps.current?.onReimport).toBeUndefined()
  })

  it('自前公開の応答が失われても authoritative GET が published なら成功扱いにする', async () => {
    const draft = form('acc_A', 'internal')
    const published = {
      ...draft,
      builderStatus: 'published',
      publicUrl: 'https://api.example.test/f/fa1',
      internalAvailability: { status: 'open', message: null },
      publishRevision: 'revision-1',
    }
    getMock.mockResolvedValueOnce(draft).mockResolvedValue(published)
    publishMock.mockRejectedValue({ body: { error: '通信が途切れました' } })
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())

    let result: unknown
    await act(async () => {
      result = await (builderProps.current?.onPublish as (revision: string) => Promise<boolean>)('revision-1')
    })

    expect(result).toBe(true)
    expect(publishMock).toHaveBeenCalledWith('fa1', 'revision-1', 'internal')
    await waitFor(() => expect(builderProps.current?.status).toBe('published'))
    expect(screen.queryByText('通信が途切れました')).toBeNull()
  })

  it('別内容の revision が公開済みでも、失敗した公開確認を成功扱いしない', async () => {
    const draft = { ...form('acc_A', 'internal'), publishRevision: 'revision-a' }
    const otherPublished = {
      ...draft,
      builderStatus: 'published',
      publicUrl: 'https://api.example.test/f/fa1',
      publishRevision: 'revision-b',
    }
    getMock.mockResolvedValueOnce(draft).mockResolvedValue(otherPublished)
    publishMock.mockRejectedValue({ body: { error: 'フォーム内容が更新されました' } })
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())

    let result: unknown
    await act(async () => {
      result = await (builderProps.current?.onPublish as (revision: string) => Promise<boolean>)('revision-a')
    })

    expect(result).toBe(false)
    expect(await screen.findByText('フォーム内容が更新されました')).toBeTruthy()
    expect(builderProps.current?.status).toBe('published')
  })

  it('自前公開の再読込も draft のときだけ失敗を表示する', async () => {
    const draft = form('acc_A', 'internal')
    getMock.mockResolvedValue(draft)
    publishMock.mockRejectedValue({ body: { error: '公開できませんでした' } })
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())

    let result: unknown
    await act(async () => {
      result = await (builderProps.current?.onPublish as (revision: string) => Promise<boolean>)('revision-1')
    })

    expect(result).toBe(false)
    expect(await screen.findByText('公開できませんでした')).toBeTruthy()
  })

  it('失敗回復の詳細応答で provider も同期し、別 provider の同じ状態を成功扱いしない', async () => {
    const internalPublished = {
      ...form('acc_A', 'internal'),
      builderStatus: 'published',
      publicUrl: 'https://api.example.test/f/fa1',
      publishRevision: 'internal-revision',
    }
    const formalooDraft = form('acc_A', 'formaloo')
    getMock.mockResolvedValueOnce(internalPublished).mockResolvedValue(formalooDraft)
    unpublishMock.mockRejectedValue({ body: { error: '配信方式が更新されました。再読み込みしてください' } })
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(builderProps.current?.initialRenderBackend).toBe('internal'))

    let result: unknown
    await act(async () => {
      result = await (builderProps.current?.onUnpublish as () => Promise<boolean>)()
    })

    expect(result).toBe(false)
    await waitFor(() => expect(builderProps.current?.initialRenderBackend).toBe('formaloo'))
    expect(builderProps.current?.status).toBe('draft')
    expect(await screen.findByText('配信方式が更新されました。再読み込みしてください')).toBeTruthy()
  })

  it('自前非公開の応答だけ失われても同じ内容の authoritative draft を成功として回収する', async () => {
    const published = {
      ...form('acc_A', 'internal'),
      builderStatus: 'published',
      updatedAt: 'displayed-at',
      publishRevision: 'displayed-revision',
      publicUrl: 'https://api.example.test/f/fa1',
    }
    const unpublished = {
      ...published,
      builderStatus: 'draft',
      updatedAt: 'unpublished-at',
      publicUrl: null,
    }
    getMock.mockResolvedValueOnce(published).mockResolvedValue(unpublished)
    unpublishMock.mockRejectedValue({ body: { error: '通信が途切れました' } })
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(builderProps.current?.status).toBe('published'))

    let result: unknown
    await act(async () => {
      result = await (builderProps.current?.onUnpublish as () => Promise<boolean>)()
    })

    expect(result).toBe(true)
    expect(unpublishMock).toHaveBeenCalledWith('fa1', 'internal', 'displayed-at')
    await waitFor(() => expect(builderProps.current?.status).toBe('draft'))
    expect(screen.queryByText('通信が途切れました')).toBeNull()
  })

  it('自前非公開は画面に表示した updatedAt を競合防止条件として送る', async () => {
    const published = {
      ...form('acc_A', 'internal'),
      builderStatus: 'published',
      updatedAt: 'displayed-at',
      publishRevision: 'displayed-revision',
      publicUrl: 'https://api.example.test/f/fa1',
    }
    getMock.mockResolvedValue(published)
    unpublishMock.mockResolvedValue({
      ...published,
      builderStatus: 'draft',
      updatedAt: 'unpublished-at',
      publicUrl: null,
    })
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(builderProps.current?.status).toBe('published'))

    await act(async () => {
      await (builderProps.current?.onUnpublish as () => Promise<boolean>)()
    })

    expect(unpublishMock).toHaveBeenCalledWith('fa1', 'internal', 'displayed-at')
  })

  it('自前配信だけに回答者通知設定を表示し、フォーム定義を渡す', async () => {
    const loaded = { ...form('acc_A'), title: '参加申込', fields: [{ id: 'mail', type: 'email', label: 'メール', required: true, position: 0, config: {} }] }
    getMock.mockResolvedValue(loaded)
    getRenderBackendMock.mockResolvedValue('internal')
    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(screen.getByTestId('notification-settings')).toBeTruthy())
    expect(notificationSettingsProps.current).toEqual({
      formId: 'fa1',
      formTitle: '参加申込',
      fields: loaded.fields,
    })
  })

  it('Formaloo 配信の owner は既存共有操作を維持する', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(sharePanelProps.current?.isOwner).toBe(true))
    expect(sharePanelProps.current?.renderBackend).toBe('formaloo')
    expect(sheetsListMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('notification-settings')).toBeNull()
  })

  it('internal の NULL 共通 form は選択中アカウントで接続を取得する', async () => {
    getMock.mockResolvedValue(form(null, 'internal'))
    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(sheetsListMock).toHaveBeenCalledWith('acc_A', 'fa1'))
  })

  it('配信方式を切り替えた直後に共有情報も新しい backend で読み直す', async () => {
    getMock
      .mockResolvedValueOnce(form('acc_A'))
      .mockResolvedValue(form('acc_A', 'internal'))
    shareMock
      .mockResolvedValueOnce({ published: true, publicUrl: 'https://formaloo.example.test/f', gsheetConnected: false })
      .mockResolvedValue({ published: true, publicUrl: 'https://api.example.test/f/fa1', gsheetConnected: false })
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(sharePanelProps.current?.share).toEqual(expect.objectContaining({
      publicUrl: 'https://formaloo.example.test/f',
    })))

    await act(async () => {
      await (builderProps.current?.onRenderBackendChange as (backend: string) => Promise<void>)('internal')
    })

    await waitFor(() => expect(sharePanelProps.current?.share).toEqual(expect.objectContaining({
      publicUrl: 'https://api.example.test/f/fa1',
    })))
    expect(shareMock).toHaveBeenCalledTimes(2)
  })

  it('backend切替後の共有情報を再読込できなければ旧providerのURLを消す', async () => {
    const initial = form('acc_A')
    getMock
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(form('acc_A', 'internal'))
    shareMock
      .mockResolvedValueOnce({ published: true, publicUrl: 'https://formaloo.example.test/f', iframeCode: '<iframe />', scriptCode: '<script />', gsheetConnected: false })
      .mockRejectedValueOnce(new Error('share unavailable'))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(sharePanelProps.current?.share).toEqual(expect.objectContaining({
      publicUrl: 'https://formaloo.example.test/f',
    })))

    await act(async () => {
      await (builderProps.current?.onRenderBackendChange as (backend: string) => Promise<void>)('internal')
    })

    await waitFor(() => expect(sharePanelProps.current?.share).toBeNull())
  })

  it('backend切替開始時に旧URLを即座に消し、遅い旧応答で新URLを上書きしない', async () => {
    const staleInternalShare = deferred<Record<string, unknown>>()
    const currentFormalooShare = deferred<Record<string, unknown>>()
    getMock
      .mockResolvedValueOnce(form('acc_A'))
      .mockResolvedValueOnce(form('acc_A', 'internal'))
      .mockResolvedValue(form('acc_A'))
    shareMock
      .mockResolvedValueOnce({ published: true, publicUrl: 'https://formaloo.example.test/old', gsheetConnected: false })
      .mockReturnValueOnce(staleInternalShare.promise)
      .mockReturnValueOnce(currentFormalooShare.promise)
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(sharePanelProps.current?.share).toEqual(expect.objectContaining({
      publicUrl: 'https://formaloo.example.test/old',
    })))

    let firstSwitch!: Promise<void>
    act(() => {
      firstSwitch = (builderProps.current?.onRenderBackendChange as (backend: string) => Promise<void>)('internal')
    })
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(2))
    expect(sharePanelProps.current?.share).toBeNull()

    let secondSwitch!: Promise<void>
    act(() => {
      secondSwitch = (builderProps.current?.onRenderBackendChange as (backend: string) => Promise<void>)('formaloo')
    })
    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(3))
    await act(async () => {
      currentFormalooShare.resolve({ published: true, publicUrl: 'https://formaloo.example.test/current' })
      await secondSwitch
    })
    expect(sharePanelProps.current?.share).toEqual(expect.objectContaining({
      publicUrl: 'https://formaloo.example.test/current',
    }))

    await act(async () => {
      staleInternalShare.resolve({ published: true, publicUrl: 'https://api.example.test/f/fa1' })
      await firstSwitch
    })
    expect(sharePanelProps.current?.share).toEqual(expect.objectContaining({
      publicUrl: 'https://formaloo.example.test/current',
    }))
  })

  it('id が変わった後に届く古い詳細応答で現在のフォームを上書きしない', async () => {
    const staleA = deferred<ReturnType<typeof form>>()
    const currentB = { ...form('acc_A'), id: 'form-b', title: 'フォームB' }
    getMock
      .mockReturnValueOnce(staleA.promise)
      .mockResolvedValue(currentB)

    const view = render(<FormBuilderClient id="form-a" />)
    view.rerender(<FormBuilderClient id="form-b" />)
    await waitFor(() => expect(builderProps.current?.formTitle).toBe('フォームB'))

    await act(async () => {
      staleA.resolve({ ...form('acc_A'), id: 'form-a', title: 'フォームA' })
      await staleA.promise
    })

    expect(builderProps.current?.formTitle).toBe('フォームB')
  })

  it('P2 fail-closed: account 未確定 (selectedAccountId=null) で account-scoped form は描画せず hold', async () => {
    mockAccount.selectedAccountId = null
    getMock.mockResolvedValue(form('acc_B'))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('scope-hold')).toBeTruthy())
    expect(screen.queryByTestId('form-builder')).toBeNull()
  })

  it('P2: account 未確定でも NULL 共通 form は表示 (共通は全アカウント許容)', async () => {
    mockAccount.selectedAccountId = null
    getMock.mockResolvedValue(form(null))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    expect(screen.queryByTestId('scope-hold')).toBeNull()
  })
})
