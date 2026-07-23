// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { FormSubmitAction } from '@/lib/formaloo-advanced-api'

const builderProps = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}))
const getMock = vi.fn()
const shareMock = vi.fn()
const saveDefinitionMock = vi.fn()
const fetchApiMock = vi.fn()
const tagsListMock = vi.fn()

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/forms-advanced/builder', () => ({
  default: (props: Record<string, unknown>) => {
    builderProps.current = props
    return <div data-testid="form-builder" />
  },
}))
vi.mock('@/components/forms-advanced/share-panel', () => ({ default: () => null }))
vi.mock('@/components/forms-advanced/instant-webhook-settings', () => ({ default: () => null }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: null }),
}))
vi.mock('@/lib/formaloo-advanced-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/formaloo-advanced-api')>()
  return {
    ...actual,
    formsAdvancedApi: {
      get: (...args: unknown[]) => getMock(...args),
      share: (...args: unknown[]) => shareMock(...args),
      saveDefinition: (...args: unknown[]) => saveDefinitionMock(...args),
    },
  }
})
vi.mock('@/lib/api', () => ({
  fetchApi: (...args: unknown[]) => fetchApiMock(...args),
  api: {
    tags: { list: (...args: unknown[]) => tagsListMock(...args) },
  },
}))

import FormBuilderClient from './form-builder-client'

function form(extra: Record<string, unknown> = {}) {
  return {
    id: 'fa1',
    title: 'F',
    description: null,
    formalooSlug: null,
    renderBackend: 'formaloo',
    builderStatus: 'draft',
    publishedAt: null,
    submitCount: 0,
    fields: [],
    logic: [],
    publicUrl: null,
    embedCode: null,
    syncStatus: 'idle',
    syncError: null,
    lineAccountId: null,
    folderId: null,
    updatedAt: 'x',
    ...extra,
  }
}

beforeEach(() => {
  builderProps.current = undefined
  getMock.mockReset()
  shareMock.mockReset()
  saveDefinitionMock.mockReset()
  fetchApiMock.mockReset()
  tagsListMock.mockReset()
  shareMock.mockResolvedValue({
    published: false,
    publicUrl: null,
    iframeCode: null,
    scriptCode: null,
    gsheetConnected: false,
    gsheetUrl: null,
  })
  fetchApiMock.mockImplementation(async (path: string) => (
    path === '/api/friend-field-definitions'
      ? {
          success: true,
          data: [{
            id: 'field-status',
            name: '入金確認',
            defaultValue: '未',
            displayOrder: 0,
            isActive: true,
            createdAt: '2026-07-23',
            updatedAt: '2026-07-23',
          }],
        }
      : { data: { role: 'owner' } }
  ))
  tagsListMock.mockResolvedValue({
    success: true,
    data: [{ id: 'tag-old', name: '旧会員', color: '#999999', createdAt: '2026-07-23' }],
  })
})

afterEach(cleanup)

describe('フォーム詳細 — 送信後アクション配線', () => {
  it('GET の synthetic action と既存候補を builder へ渡す', async () => {
    const submitActions: FormSubmitAction[] = [{ type: 'add_tag', tagId: 'tag-old' }]
    getMock.mockResolvedValue(form({ onSubmitTagId: 'tag-old', submitActions }))

    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    await waitFor(() => expect(builderProps.current?.tags).toEqual([
      { id: 'tag-old', name: '旧会員', color: '#999999', createdAt: '2026-07-23' },
    ]))
    expect(builderProps.current?.initialSubmitActions).toEqual(submitActions)
    expect(builderProps.current?.fieldDefinitions).toEqual([
      expect.objectContaining({ id: 'field-status', name: '入金確認' }),
    ])
  })

  it('旧 worker 応答でも onSubmitTagId を synthetic action 1件として表示する', async () => {
    getMock.mockResolvedValue(form({ onSubmitTagId: 'tag-old' }))

    render(<FormBuilderClient id="fa1" />)

    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())
    expect(builderProps.current?.initialSubmitActions).toEqual([
      { type: 'add_tag', tagId: 'tag-old' },
    ])
  })

  it('builder が触った ordered submitActions を PUT body へ欠落なく渡す', async () => {
    const submitActions: FormSubmitAction[] = [
      { type: 'remove_tag', tagId: 'tag-old' },
      { type: 'set_field', fieldId: 'field-status', value: '済' },
    ]
    getMock.mockResolvedValue(form({ submitActions: [] }))
    saveDefinitionMock.mockResolvedValue(form({ submitActions }))

    render(<FormBuilderClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('form-builder')).toBeTruthy())

    await act(async () => {
      await (builderProps.current?.onSave as (definition: Record<string, unknown>) => Promise<void>)({
        fields: [],
        logic: [],
        title: 'F',
        submitActions,
      })
    })

    expect(saveDefinitionMock).toHaveBeenCalledWith(
      'fa1',
      expect.objectContaining({ submitActions }),
      'formaloo',
    )
  })
})
