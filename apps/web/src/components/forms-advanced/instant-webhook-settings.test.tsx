// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const getMock = vi.hoisted(() => vi.fn())
const setMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/formaloo-instant-webhook-api', () => ({
  formalooInstantWebhookApi: {
    get: (...args: unknown[]) => getMock(...args),
    set: (...args: unknown[]) => setMock(...args),
  },
}))

import InstantWebhookSettings from './instant-webhook-settings'

beforeEach(() => {
  getMock.mockReset()
  setMock.mockReset()
  getMock.mockResolvedValue({ enabled: false, available: true })
})
afterEach(() => cleanup())

describe('回答の即時反映 toggle', () => {
  test('既定 OFF を表示し、ON で form 単位 API を呼んで成功後だけ表示を切り替える', async () => {
    setMock.mockResolvedValue({ enabled: true, available: true })
    render(<InstantWebhookSettings formId="fa_1" />)
    await waitFor(() => expect(screen.getByTestId('instant-webhook-status').textContent).toBe('OFF'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '有効化' })) })
    expect(setMock).toHaveBeenCalledWith('fa_1', true)
    expect(screen.getByTestId('instant-webhook-status').textContent).toBe('ON')
  })

  test('API 失敗時は見かけだけ ON にせず、日本語エラーを表示する', async () => {
    setMock.mockRejectedValue({ body: { error: 'Webhook の登録確認に失敗しました' } })
    getMock.mockResolvedValue({ enabled: false, available: true })
    render(<InstantWebhookSettings formId="fa_1" />)
    await waitFor(() => expect(screen.getByTestId('instant-webhook-status').textContent).toBe('OFF'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '有効化' })) })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Webhook の登録確認に失敗しました'))
    expect(screen.getByTestId('instant-webhook-status').textContent).toBe('OFF')
  })

  test('Formaloo 未保存 form は toggle を無効化し、先に保存する案内を出す', async () => {
    getMock.mockResolvedValue({ enabled: false, available: false })
    render(<InstantWebhookSettings formId="fa_local" />)
    await waitFor(() => expect(screen.getByTestId('instant-webhook-unavailable')).toBeTruthy())
    expect((screen.getByRole('button', { name: '有効化' }) as HTMLButtonElement).disabled).toBe(true)
    expect(setMock).not.toHaveBeenCalled()
  })

  test('日常語で「最大6時間待ち→即時」を説明する', async () => {
    render(<InstantWebhookSettings formId="fa_1" />)
    await waitFor(() => expect(screen.getByTestId('instant-webhook-settings')).toBeTruthy())
    expect(screen.getByTestId('instant-webhook-description').textContent).toContain('最大6時間待ち→即時')
  })
})
