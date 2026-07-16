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
const mockAccount: { selectedAccountId: string | null } = { selectedAccountId: 'acc_A' }
const getMock = vi.fn()
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
vi.mock('@/components/forms-advanced/share-panel', () => ({ default: () => null }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: {
    get: (...a: unknown[]) => getMock(...a),
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
  getMock.mockReset(); shareMock.mockReset(); saveDefinitionMock.mockReset(); fetchApiMock.mockReset()
  builderProps.current = undefined
  mockAccount.selectedAccountId = 'acc_A'
  shareMock.mockResolvedValue({ published: false, publicUrl: null, iframeCode: null, scriptCode: null, gsheetConnected: false, gsheetUrl: null })
  fetchApiMock.mockResolvedValue({ data: { role: 'owner' } })
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
