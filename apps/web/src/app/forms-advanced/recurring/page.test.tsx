// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

const getMock = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useSearchParams: () => ({ get: getMock }) }))
vi.mock('./recurring-submissions-client', () => ({ default: ({ formId }: { formId: string }) => <div data-testid="client">{formId}</div> }))

import Page from './page'

describe('recurring submissions static page', () => {
  test('passes query id through a Suspense-safe fixed route', () => {
    getMock.mockReturnValue('fa_1')
    render(<Page />)
    expect(screen.getByTestId('client').textContent).toBe('fa_1')
  })

  test('shows a clear message when query id is absent', () => {
    getMock.mockReturnValue(null)
    render(<Page />)
    expect(screen.getByText('フォーム ID が指定されていません')).toBeTruthy()
  })
})
