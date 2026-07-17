// @vitest-environment jsdom
/**
 * route-terminal-phase2 (T-C2/T-C3) — redirect の load/relay/reload 配線 (詳細画面 client)。
 *   - load: GET が返す formRedirect を builder の initialFormRedirect へ渡す (保存済 redirect が reload で復元)。
 *   - relay(T-C2): builder onSave の formRedirect を saveDefinition body へ欠落なく転送する。
 *   - clear(CX-4): url 空の formRedirect(touched) も relay され解除意図が worker へ届く。
 *   - 未編集: onSave が formRedirect を送らなければ body にも formRedirect が載らない (absent = 既存不干渉)。
 * form-builder-scope.test.tsx を写経元にした mocked-builder 結合 harness。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import type { ReactNode } from 'react'

const builderProps = vi.hoisted(() => ({ current: undefined as Record<string, unknown> | undefined }))
const mockAccount: { selectedAccountId: string | null } = { selectedAccountId: null }
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

function form(extra: Record<string, unknown> = {}) {
  return {
    id: 'fa1', title: 'F', description: null, formalooSlug: null, builderStatus: 'draft', publishedAt: null,
    submitCount: 0, fields: [], logic: [], publicUrl: null, embedCode: null, syncStatus: 'idle', syncError: null,
    lineAccountId: null, updatedAt: 'x', ...extra,
  }
}

beforeEach(() => {
  getMock.mockReset(); shareMock.mockReset(); saveDefinitionMock.mockReset(); fetchApiMock.mockReset()
  builderProps.current = undefined
  mockAccount.selectedAccountId = null
  shareMock.mockResolvedValue({ published: false, publicUrl: null, iframeCode: null, scriptCode: null, gsheetConnected: false, gsheetUrl: null })
  fetchApiMock.mockResolvedValue({ data: { role: 'owner' } })
})
afterEach(() => cleanup())

describe('詳細画面 redirect load/relay 配線', () => {
  it('T-C3 load: GET の formRedirect を builder の initialFormRedirect へ渡す (保存済 redirect の復元)', async () => {
    getMock.mockResolvedValue(form({ formRedirect: { url: 'https://saved.example.com/lp', openExternalBrowser: true } }))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    expect(builderProps.current?.initialFormRedirect).toEqual({ url: 'https://saved.example.com/lp', openExternalBrowser: true })
  })

  it('T-C3 load: formRedirect null は initialFormRedirect=undefined (redirect なしフォーム)', async () => {
    getMock.mockResolvedValue(form({ formRedirect: null }))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    expect(builderProps.current?.initialFormRedirect).toBeUndefined()
  })

  it('T-C2 relay: onSave の formRedirect を saveDefinition body へ欠落なく転送する', async () => {
    getMock.mockResolvedValue(form())
    saveDefinitionMock.mockResolvedValue(form({ syncStatus: 'idle' }))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    await act(async () => {
      await (builderProps.current?.onSave as (def: Record<string, unknown>) => Promise<void>)({
        fields: [], logic: [], title: 'F', formRedirect: { url: 'https://example.com/lp', openExternalBrowser: false },
      })
    })
    expect(saveDefinitionMock).toHaveBeenCalledWith('fa1', expect.objectContaining({
      formRedirect: { url: 'https://example.com/lp', openExternalBrowser: false },
    }))
  })

  it('CX-4 relay: url 空の formRedirect(clear 意図) も saveDefinition へ転送される', async () => {
    getMock.mockResolvedValue(form({ formRedirect: { url: 'https://old.example.com/lp' } }))
    saveDefinitionMock.mockResolvedValue(form({ syncStatus: 'idle' }))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    await act(async () => {
      await (builderProps.current?.onSave as (def: Record<string, unknown>) => Promise<void>)({
        fields: [], logic: [], title: 'F', formRedirect: { url: '', openExternalBrowser: false },
      })
    })
    expect(saveDefinitionMock).toHaveBeenCalledWith('fa1', expect.objectContaining({
      formRedirect: { url: '', openExternalBrowser: false },
    }))
  })

  it('未編集: onSave が formRedirect を送らなければ body にも載らない (absent)', async () => {
    getMock.mockResolvedValue(form())
    saveDefinitionMock.mockResolvedValue(form({ syncStatus: 'idle' }))
    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    await act(async () => {
      await (builderProps.current?.onSave as (def: Record<string, unknown>) => Promise<void>)({ fields: [], logic: [], title: 'F' })
    })
    const body = saveDefinitionMock.mock.calls[0][1] as Record<string, unknown>
    expect('formRedirect' in body).toBe(false)
  })
})
