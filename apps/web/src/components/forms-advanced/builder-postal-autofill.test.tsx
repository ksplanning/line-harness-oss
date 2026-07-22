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

const legacyMappedAddressFields: HarnessField[] = addressFields.map((field) => field.id === 'zip'
  ? {
      ...field,
      config: {
        ...field.config,
        postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' },
      },
    }
  : field)

const nativeAddressFields: HarnessField[] = [
  { id: 'zip-native', type: 'postal_code', label: '郵便番号', required: true, position: 0, config: {} },
  { id: 'pref-text', type: 'text', label: '都道府県（旧項目）', required: false, position: 1, config: {} },
  { id: 'pref-native', type: 'prefecture', label: '都道府県', required: false, position: 2, config: {} },
  { id: 'city-text', type: 'text', label: '市区町村（旧項目）', required: false, position: 3, config: {} },
  { id: 'city-native', type: 'address_city', label: '市区町村', required: false, position: 4, config: {} },
  { id: 'town-text', type: 'text', label: '町名・番地（旧項目）', required: false, position: 5, config: {} },
  { id: 'town-native', type: 'address_street', label: '町名・番地', required: false, position: 6, config: {} },
  { id: 'email', type: 'email', label: 'メール', required: false, position: 7, config: {} },
]

const modeCapableFields: HarnessField[] = [
  { id: 'zip-native', type: 'postal_code', label: '郵便番号', required: true, position: 0, config: {} },
  { id: 'pref-native', type: 'prefecture', label: '都道府県', required: false, position: 1, config: {} },
  { id: 'city-native', type: 'address_city', label: '市区町村', required: false, position: 2, config: {} },
  { id: 'town-native', type: 'address_street', label: '町名・番地', required: false, position: 3, config: {} },
  { id: 'address-primary', type: 'address' as HarnessField['type'], label: '住所', required: false, position: 4, config: {} },
  { id: 'address-secondary', type: 'address' as HarnessField['type'], label: '別の住所', required: false, position: 5, config: {} },
  { id: 'notes', type: 'text', label: '備考', required: false, position: 6, config: {} },
  { id: 'email', type: 'email', label: 'メール', required: false, position: 7, config: {} },
]

function combinedConfig(zipField: string, addressField: string): HarnessField['config'] {
  return {
    postalAutofill: {
      mode: 'combined',
      zipField,
      addressField,
    } as unknown as NonNullable<HarnessField['config']['postalAutofill']>,
  }
}

const legacyMappingWithNativeDestinations: HarnessField[] = [
  {
    id: 'zip', type: 'text', label: '郵便番号（旧項目）', required: true, position: 0,
    config: { postalAutofill: { zipField: 'zip', prefField: 'pref-text', cityField: 'city-text', townField: 'town-text' } },
  },
  { id: 'pref-native', type: 'prefecture', label: '都道府県', required: false, position: 1, config: {} },
  { id: 'city-native', type: 'address_city', label: '市区町村', required: false, position: 2, config: {} },
  { id: 'town-native', type: 'address_street', label: '町名・番地', required: false, position: 3, config: {} },
  { id: 'pref-text', type: 'text', label: '都道府県（旧項目）', required: false, position: 4, config: {} },
  { id: 'city-text', type: 'text', label: '市区町村（旧項目）', required: false, position: 5, config: {} },
  { id: 'town-text', type: 'text', label: '町名・番地（旧項目）', required: false, position: 6, config: {} },
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
  it('offers native destinations first, keeps text fallbacks, and saves a native zip mapping', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: nativeAddressFields, onSave })} />)

    fireEvent.click(screen.getByLabelText('郵便番号から住所を自動入力'))

    const prefecture = screen.getByLabelText('都道府県の入力先') as HTMLSelectElement
    const city = screen.getByLabelText('市区町村の入力先') as HTMLSelectElement
    const town = screen.getByLabelText('町名・番地の入力先') as HTMLSelectElement
    expect(Array.from(prefecture.options).map((option) => option.value)).toEqual([
      'pref-native', 'pref-text', 'city-text', 'town-text',
    ])
    expect(Array.from(city.options).map((option) => option.value)).toEqual([
      'city-native', 'pref-text', 'city-text', 'town-text',
    ])
    expect(Array.from(town.options).map((option) => option.value)).toEqual([
      'town-native', 'pref-text', 'city-text', 'town-text',
    ])
    expect(prefecture.value).toBe('pref-native')
    expect(city.value).toBe('city-native')
    expect(town.value).toBe('town-native')

    fireEvent.change(prefecture, { target: { value: 'pref-text' } })
    fireEvent.click(screen.getByText('保存'))

    const savedFields = onSave.mock.calls[0][0].fields as HarnessField[]
    expect(savedFields.find((field) => field.id === 'zip-native')?.config.postalAutofill).toEqual({
      zipField: 'zip-native',
      prefField: 'pref-text',
      cityField: 'city-native',
      townField: 'town-native',
    })
  })

  it('hides postal settings on a new text field', () => {
    render(<FormBuilder {...base()} />)

    expect(screen.queryByLabelText('郵便番号から住所を自動入力')).toBeNull()
  })

  it('does not replace a grandfathered text mapping when native destinations are added', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({
      initialFields: [
        ...legacyMappingWithNativeDestinations,
        { id: 'address', type: 'address' as HarnessField['type'], label: '住所', required: false, position: 7, config: {} },
      ],
      onSave,
    })} />)

    expect((screen.getByLabelText('郵便番号から住所を自動入力') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: '分割' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: '一括' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('都道府県の入力先') as HTMLSelectElement).value).toBe('pref-text')
    expect((screen.getByLabelText('市区町村の入力先') as HTMLSelectElement).value).toBe('city-text')
    expect((screen.getByLabelText('町名・番地の入力先') as HTMLSelectElement).value).toBe('town-text')
    fireEvent.click(screen.getByText('保存'))

    const savedFields = onSave.mock.calls[0][0].fields as HarnessField[]
    expect(savedFields.find((field) => field.id === 'zip')).toEqual(legacyMappingWithNativeDestinations[0])
    expect(savedFields.find((field) => field.id === 'zip')?.config.postalAutofill).toEqual({
      zipField: 'zip',
      prefField: 'pref-text',
      cityField: 'city-text',
      townField: 'town-text',
    })
    expect(savedFields.find((field) => field.id === 'zip')?.config.postalAutofill).not.toHaveProperty('mode')
  })

  it('defaults to 分割 when both modes are available and keeps the legacy four-key save shape', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: modeCapableFields, onSave })} />)

    fireEvent.click(screen.getByLabelText('郵便番号から住所を自動入力'))

    expect((screen.getByRole('radio', { name: '分割' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: '一括' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByLabelText('都道府県の入力先')).toBeTruthy()
    expect(screen.getByLabelText('市区町村の入力先')).toBeTruthy()
    expect(screen.getByLabelText('町名・番地の入力先')).toBeTruthy()
    expect(screen.queryByLabelText('住所の入力先')).toBeNull()

    fireEvent.click(screen.getByText('保存'))
    const savedFields = onSave.mock.calls[0][0].fields as HarnessField[]
    expect(savedFields.find((field) => field.id === 'zip-native')?.config.postalAutofill).toEqual({
      zipField: 'zip-native',
      prefField: 'pref-native',
      cityField: 'city-native',
      townField: 'town-native',
    })
  })

  it('switches to 一括, shows only address destinations, and saves the exact combined shape', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: modeCapableFields, onSave })} />)

    fireEvent.click(screen.getByLabelText('郵便番号から住所を自動入力'))
    fireEvent.click(screen.getByRole('radio', { name: '一括' }))

    expect(screen.queryByLabelText('都道府県の入力先')).toBeNull()
    expect(screen.queryByLabelText('市区町村の入力先')).toBeNull()
    expect(screen.queryByLabelText('町名・番地の入力先')).toBeNull()
    const addressDestination = screen.getByLabelText('住所の入力先') as HTMLSelectElement
    expect(Array.from(addressDestination.options).map((option) => option.value)).toEqual([
      'address-primary',
      'address-secondary',
    ])
    expect(Array.from(addressDestination.options).map((option) => option.value)).not.toContain('notes')
    expect(Array.from(addressDestination.options).map((option) => option.value)).not.toContain('email')

    fireEvent.change(addressDestination, { target: { value: 'address-secondary' } })
    fireEvent.click(screen.getByText('保存'))

    const savedFields = onSave.mock.calls[0][0].fields as HarnessField[]
    expect(savedFields.find((field) => field.id === 'zip-native')?.config.postalAutofill).toEqual({
      mode: 'combined',
      zipField: 'zip-native',
      addressField: 'address-secondary',
    })
  })

  it('can enable 一括 with only a postal-code field and one address field', () => {
    const onSave = vi.fn()
    const addressOnlyFields: HarnessField[] = [
      { id: 'zip-native', type: 'postal_code', label: '郵便番号', required: true, position: 0, config: {} },
      { id: 'address', type: 'address' as HarnessField['type'], label: '住所', required: false, position: 1, config: {} },
    ]
    render(<FormBuilder {...base({ initialFields: addressOnlyFields, onSave })} />)

    const enabled = screen.getByLabelText('郵便番号から住所を自動入力') as HTMLInputElement
    expect(enabled.disabled).toBe(false)
    fireEvent.click(enabled)

    expect((screen.getByRole('radio', { name: '一括' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('住所の入力先') as HTMLSelectElement).value).toBe('address')
    fireEvent.click(screen.getByText('保存'))

    const savedFields = onSave.mock.calls[0][0].fields as HarnessField[]
    expect(savedFields.find((field) => field.id === 'zip-native')?.config.postalAutofill).toEqual({
      mode: 'combined',
      zipField: 'zip-native',
      addressField: 'address',
    })
  })

  it('chooses three distinct text fallbacks when a native zip has no dedicated destinations', () => {
    render(<FormBuilder {...base({ initialFields: [
      { id: 'zip-native', type: 'postal_code', label: '郵便番号', required: true, position: 0, config: {} },
      ...addressFields.slice(1, 4),
    ] })} />)

    fireEvent.click(screen.getByLabelText('郵便番号から住所を自動入力'))

    expect((screen.getByLabelText('都道府県の入力先') as HTMLSelectElement).value).toBe('pref')
    expect((screen.getByLabelText('市区町村の入力先') as HTMLSelectElement).value).toBe('city')
    expect((screen.getByLabelText('町名・番地の入力先') as HTMLSelectElement).value).toBe('town')
  })

  it('saves the selected zip and three distinct text-field destinations', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: legacyMappedAddressFields, onSave })} />)

    const prefecture = screen.getByLabelText('都道府県の入力先') as HTMLSelectElement
    const city = screen.getByLabelText('市区町村の入力先') as HTMLSelectElement
    const town = screen.getByLabelText('町名・番地の入力先') as HTMLSelectElement
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
    render(<FormBuilder {...base({ initialFields: legacyMappedAddressFields })} />)

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

  it('keeps a combined mapping when deleting an unrelated field whose id equals the mode value', () => {
    const onSave = vi.fn()
    const withCombinedMapping: HarnessField[] = [
      {
        id: 'zip-native', type: 'postal_code', label: '郵便番号', required: true, position: 0,
        config: combinedConfig('zip-native', 'address'),
      },
      { id: 'address', type: 'address' as HarnessField['type'], label: '住所', required: false, position: 1, config: {} },
      { id: 'combined', type: 'text', label: '備考', required: false, position: 2, config: {} },
    ]
    render(<FormBuilder {...base({ initialFields: withCombinedMapping, onSave })} />)

    fireEvent.click(screen.getAllByLabelText('削除')[2])
    fireEvent.click(screen.getByText('はい'))
    fireEvent.click(screen.getByText('保存'))

    const savedFields = onSave.mock.calls[0][0].fields as HarnessField[]
    expect(savedFields.some((field) => field.id === 'combined')).toBe(false)
    expect(savedFields.find((field) => field.id === 'zip-native')?.config.postalAutofill).toEqual({
      mode: 'combined',
      zipField: 'zip-native',
      addressField: 'address',
    })
  })

  it('removes a combined mapping when its address destination is deleted', () => {
    const onSave = vi.fn()
    const withCombinedMapping: HarnessField[] = [
      {
        id: 'zip-native', type: 'postal_code', label: '郵便番号', required: true, position: 0,
        config: combinedConfig('zip-native', 'address'),
      },
      { id: 'address', type: 'address' as HarnessField['type'], label: '住所', required: false, position: 1, config: {} },
    ]
    render(<FormBuilder {...base({ initialFields: withCombinedMapping, onSave })} />)

    fireEvent.click(screen.getAllByLabelText('削除')[1])
    fireEvent.click(screen.getByText('はい'))
    fireEvent.click(screen.getByText('保存'))

    const savedFields = onSave.mock.calls[0][0].fields as HarnessField[]
    expect(savedFields.some((field) => field.id === 'address')).toBe(false)
    expect(savedFields.find((field) => field.id === 'zip-native')?.config).not.toHaveProperty('postalAutofill')
  })

  it('does not expose internal postal settings for Formaloo forms', () => {
    render(<FormBuilder {...base({ initialRenderBackend: 'formaloo' })} />)

    expect(screen.queryByLabelText('郵便番号から住所を自動入力')).toBeNull()
  })
})
