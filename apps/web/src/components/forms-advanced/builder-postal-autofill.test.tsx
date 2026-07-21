// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'
import FormBuilder from './builder'

afterEach(() => cleanup())

const addressFields: HarnessField[] = [
  { id: 'zip', type: 'text', label: '郵便番号', required: true, position: 0, config: {} },
  { id: 'pref', type: 'text', label: '都道府県', required: false, position: 1, config: {} },
  { id: 'city', type: 'text', label: '市区町村', required: false, position: 2, config: {} },
  { id: 'town', type: 'text', label: '町域', required: false, position: 3, config: {} },
  { id: 'email', type: 'email', label: 'メール', required: false, position: 4, config: {} },
]

function base(overrides: Record<string, unknown> = {}) {
  return {
    formTitle: '住所入力',
    status: 'draft' as const,
    layoutMode: 'desktop' as const,
    initialFields: addressFields,
    initialLogic: [],
    initialRenderBackend: 'internal' as const,
    onSave: vi.fn(),
    ...overrides,
  }
}

describe('internal postal autofill mapping', () => {
  it('saves the selected zip and three distinct text-field destinations', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)

    fireEvent.click(screen.getByLabelText('郵便番号から住所を自動入力'))

    const prefecture = screen.getByLabelText('都道府県の入力先') as HTMLSelectElement
    const city = screen.getByLabelText('市区町村の入力先') as HTMLSelectElement
    const town = screen.getByLabelText('町域の入力先') as HTMLSelectElement
    expect(Array.from(prefecture.options).map((option) => option.value)).toEqual(['pref', 'city', 'town'])
    expect(Array.from(prefecture.options).map((option) => option.value)).not.toContain('zip')
    expect(Array.from(prefecture.options).map((option) => option.value)).not.toContain('email')

    fireEvent.change(prefecture, { target: { value: 'pref' } })
    fireEvent.change(city, { target: { value: 'city' } })
    fireEvent.change(town, { target: { value: 'town' } })
    fireEvent.click(screen.getByText('保存'))

    const savedFields = onSave.mock.calls[0][0].fields as HarnessField[]
    expect(savedFields.find((field) => field.id === 'zip')?.config.postalAutofill).toEqual({
      zipField: 'zip',
      prefField: 'pref',
      cityField: 'city',
      townField: 'town',
    })
  })

  it('does not allow the same destination to be selected twice', () => {
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('郵便番号から住所を自動入力'))

    const city = screen.getByLabelText('市区町村の入力先') as HTMLSelectElement
    fireEvent.change(city, { target: { value: 'pref' } })

    expect(city.value).toBe('city')
  })

  it('removes the mapping when the owner disables autofill', () => {
    const onSave = vi.fn()
    const withMapping: HarnessField[] = addressFields.map((field) => field.id === 'zip'
      ? {
          ...field,
          config: {
            ...field.config,
            postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' },
          },
        }
      : field)
    render(<FormBuilder {...base({ initialFields: withMapping, onSave })} />)

    expect((screen.getByLabelText('郵便番号から住所を自動入力') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByLabelText('郵便番号から住所を自動入力'))
    fireEvent.click(screen.getByText('保存'))

    const savedFields = onSave.mock.calls[0][0].fields as HarnessField[]
    expect(savedFields.find((field) => field.id === 'zip')?.config).not.toHaveProperty('postalAutofill')
  })

  it('removes a mapping that references a deleted address destination', () => {
    const onSave = vi.fn()
    const withMapping: HarnessField[] = addressFields.map((field) => field.id === 'zip'
      ? {
          ...field,
          config: {
            ...field.config,
            postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' },
          },
        }
      : field)
    render(<FormBuilder {...base({ initialFields: withMapping, onSave })} />)

    fireEvent.click(screen.getAllByLabelText('削除')[2])
    fireEvent.click(screen.getByText('はい'))
    fireEvent.click(screen.getByText('保存'))

    const savedFields = onSave.mock.calls[0][0].fields as HarnessField[]
    expect(savedFields.some((field) => field.id === 'city')).toBe(false)
    expect(savedFields.find((field) => field.id === 'zip')?.config).not.toHaveProperty('postalAutofill')
  })

  it('does not expose internal postal settings for Formaloo forms', () => {
    render(<FormBuilder {...base({ initialRenderBackend: 'formaloo' })} />)

    expect(screen.queryByLabelText('郵便番号から住所を自動入力')).toBeNull()
  })
})
