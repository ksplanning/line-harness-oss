// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

const state = vi.hoisted(() => ({
  id: 'form-1' as string | null,
  rowId: 'row-1' as string | null,
  client: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => key === 'id' ? state.id : key === 'rowId' ? state.rowId : null,
  }),
}))

vi.mock('./data-cockpit-client', () => ({
  default: (props: { id: string; initialRowId?: string | null }) => {
    state.client(props)
    return <div data-testid="cockpit-client" />
  },
}))

import FormDataPage from './page'

beforeEach(() => {
  state.id = 'form-1'
  state.rowId = 'row-1'
  state.client.mockReset()
})

describe('FormDataPage query wiring', () => {
  it('?rowId= を DataCockpitClient の initialRowId へ渡す', () => {
    render(<FormDataPage />)
    expect(state.client).toHaveBeenCalledWith({ id: 'form-1', initialRowId: 'row-1' })
  })
})
