// @vitest-environment jsdom
/**
 * submissions-visibility-fix (T-B1) — /form-submissions (旧レール /api/forms) の空表示に、
 * 高機能フォーム (forms-advanced)「回答データ」への誘導 hint を additive 追加した配線 test。
 *   - 旧レール forms=0 は仕様どおり「フォームがまだありません」を出す (二重実装しない)。
 *   - その空表示に /forms-advanced へ向かう Link (data-testid=forms-advanced-hint) が出る (additive)。
 *   - forms が 1 件以上ある時は空表示も hint も出さない (通常一覧を表示・旧レール読取無改変)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

const m = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('@/lib/api', () => ({
  fetchApi: (...a: unknown[]) => m.fetchApi(...a),
  downloadCsv: vi.fn(),
}))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

import FormSubmissionsPage from './page'

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup() })

describe('T-B1 forms-advanced 誘導 hint', () => {
  it('旧レール forms=0 → 空表示 + 回答データへの Link を出す', async () => {
    m.fetchApi.mockResolvedValue({ success: true, data: [] })
    render(<FormSubmissionsPage />)
    await waitFor(() => expect(screen.getByText('フォームがまだありません')).toBeTruthy())
    const hint = screen.getByTestId('forms-advanced-hint')
    expect(hint.getAttribute('href')).toBe('/forms-advanced')
    expect(hint.textContent).toContain('回答データ')
  })

  it('forms が 1 件以上 → 空表示も hint も出さない (旧レール一覧を表示)', async () => {
    m.fetchApi.mockResolvedValue({
      success: true,
      data: [{ id: 'f1', name: 'アンケート', usedByAccounts: [], submitCount: 0 }],
    })
    render(<FormSubmissionsPage />)
    await waitFor(() => expect(screen.getByText('アンケート')).toBeTruthy())
    expect(screen.queryByText('フォームがまだありません')).toBeNull()
    expect(screen.queryByTestId('forms-advanced-hint')).toBeNull()
  })
})
