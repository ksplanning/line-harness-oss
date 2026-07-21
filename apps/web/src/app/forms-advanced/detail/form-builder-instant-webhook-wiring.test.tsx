// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'

const mockAccount: { selectedAccountId: string | null } = { selectedAccountId: 'acc_A' }
const getMock = vi.fn()
const getRenderBackendMock = vi.fn()
const shareMock = vi.fn()

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/forms-advanced/builder', () => ({ default: () => <div data-testid="form-builder" /> }))
vi.mock('@/components/forms-advanced/share-panel', () => ({ default: () => null }))
vi.mock('@/components/forms-advanced/instant-webhook-settings', () => ({
  default: ({ formId }: { formId: string }) => <div data-testid="instant-webhook-wiring">{formId}</div>,
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: {
    get: (...args: unknown[]) => getMock(...args),
    getRenderBackend: (...args: unknown[]) => getRenderBackendMock(...args),
    share: (...args: unknown[]) => shareMock(...args),
  },
}))
vi.mock('@/lib/api', () => ({ fetchApi: vi.fn(async () => ({ data: { role: 'owner' } })) }))

import FormBuilderClient from './form-builder-client'

function form(lineAccountId: string | null) {
  return {
    id: 'fa_1', title: 'F', description: null, formalooSlug: 'remote', renderBackend: 'formaloo', builderStatus: 'draft', publishedAt: null,
    submitCount: 0, fields: [], logic: [], publicUrl: null, embedCode: null, syncStatus: 'idle', syncError: null,
    lineAccountId, updatedAt: 'x',
  }
}

beforeEach(() => {
  getMock.mockReset()
  getRenderBackendMock.mockReset()
  shareMock.mockReset()
  mockAccount.selectedAccountId = 'acc_A'
  getRenderBackendMock.mockResolvedValue('formaloo')
  shareMock.mockResolvedValue(null)
})
afterEach(() => cleanup())

describe('フォーム詳細の即時 webhook 設定配線', () => {
  test('表示許可された form の builder 外側に formId 付き設定カードを出す', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    render(<FormBuilderClient id="fa_1" />)
    await waitFor(() => expect(screen.getByTestId('instant-webhook-wiring').textContent).toBe('fa_1'))
    expect(screen.getByTestId('form-builder')).toBeTruthy()
  })

  test('別アカウントで scope-blocked 中は設定カードも出さない', async () => {
    getMock.mockResolvedValue(form('acc_B'))
    render(<FormBuilderClient id="fa_1" />)
    await waitFor(() => expect(screen.getByTestId('scope-blocked')).toBeTruthy())
    expect(screen.queryByTestId('instant-webhook-wiring')).toBeNull()
  })
})
