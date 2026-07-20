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
const mockAccount: { selectedAccountId: string | null } = { selectedAccountId: 'acc_A' }
const getMock = vi.fn()
const getRenderBackendMock = vi.fn()
const setRenderBackendMock = vi.fn()
const shareMock = vi.fn()
const saveDefinitionMock = vi.fn()
const fetchApiMock = vi.fn()

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
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: {
    get: (...a: unknown[]) => getMock(...a),
    getRenderBackend: (...a: unknown[]) => getRenderBackendMock(...a),
    setRenderBackend: (...a: unknown[]) => setRenderBackendMock(...a),
    share: (...a: unknown[]) => shareMock(...a),
    saveDefinition: (...a: unknown[]) => saveDefinitionMock(...a),
  },
}))
vi.mock('@/lib/api', () => ({ fetchApi: (...a: unknown[]) => fetchApiMock(...a) }))

import FormBuilderClient from './form-builder-client'

function form(lineAccountId: string | null) {
  return { id: 'fa1', title: 'F', description: null, formalooSlug: null, builderStatus: 'draft', publishedAt: null, submitCount: 0, fields: [], logic: [], publicUrl: null, embedCode: null, syncStatus: 'idle', syncError: null, lineAccountId, updatedAt: 'x' }
}

beforeEach(() => {
  getMock.mockReset(); getRenderBackendMock.mockReset(); setRenderBackendMock.mockReset(); shareMock.mockReset(); saveDefinitionMock.mockReset(); fetchApiMock.mockReset()
  builderProps.current = undefined
  sharePanelProps.current = undefined
  mockAccount.selectedAccountId = 'acc_A'
  getRenderBackendMock.mockResolvedValue('formaloo')
  setRenderBackendMock.mockImplementation(async (_id: string, backend: string) => backend)
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
    })
  })

  it('配信方式を別 endpoint から読み、builder に復元する', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    getRenderBackendMock.mockResolvedValue('internal')
    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(builderProps.current?.initialRenderBackend).toBe('internal'))
    expect(getRenderBackendMock).toHaveBeenCalledWith('fa1')
  })

  it('builder の配信方式変更を専用 endpoint にだけ保存する', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())

    await act(async () => {
      await (builderProps.current?.onRenderBackendChange as (backend: string) => Promise<void>)('internal')
    })

    expect(setRenderBackendMock).toHaveBeenCalledWith('fa1', 'internal')
    expect(saveDefinitionMock).not.toHaveBeenCalled()
  })

  it('配信方式の読込だけ失敗した場合は既定 Formaloo のままフォームを表示する', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    getRenderBackendMock.mockRejectedValue(new Error('backend unavailable'))
    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    expect(builderProps.current?.initialRenderBackend).toBe('formaloo')
  })

  it('自前配信では local 公開 URL を表示しつつ Formaloo 専用 Sheets 操作を隠す', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    getRenderBackendMock.mockResolvedValue('internal')
    shareMock.mockResolvedValue({
      published: true,
      publicUrl: 'https://api.example.test/f/fa1',
      lineDistUrl: null,
      iframeCode: null,
      scriptCode: null,
      gsheetConnected: false,
      gsheetUrl: null,
    })
    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(sharePanelProps.current?.share).toEqual(expect.objectContaining({
      publicUrl: 'https://api.example.test/f/fa1',
    })))
    expect(sharePanelProps.current?.isOwner).toBe(false)
    expect(screen.queryByTestId('instant-webhook-settings')).toBeNull()
  })

  it('Formaloo 配信の owner は既存共有操作を維持する', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(sharePanelProps.current?.isOwner).toBe(true))
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
