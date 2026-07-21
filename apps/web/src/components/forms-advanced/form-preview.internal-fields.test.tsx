// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'
import FormPreview from './form-preview'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function field(
  type: HarnessField['type'],
  label: string,
  config: HarnessField['config'] = {},
): HarnessField {
  return { id: `field-${type}`, type, label, required: false, position: 0, config }
}

const postalFields: HarnessField[] = [
  {
    id: 'zip', type: 'text', label: '郵便番号', required: true, position: 0,
    config: { postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' } },
  },
  { id: 'pref', type: 'text', label: '都道府県', required: true, position: 1, config: {} },
  { id: 'city', type: 'text', label: '市区町村', required: true, position: 2, config: {} },
  { id: 'town', type: 'text', label: '町域', required: false, position: 3, config: {} },
]

describe('internal preview input freedoms', () => {
  test.each([
    ['text', '1行'],
    ['textarea', '複数行'],
  ] as const)('%s renders the configured placeholder and a live Unicode-aware remaining counter', (type, label) => {
    render(<FormPreview
      title="確認"
      renderBackend="internal"
      fields={[field(type, label, { placeholder: '自由に入力', minLength: 2, maxLength: 5 })]}
    />)

    const input = screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement
    expect(input.placeholder).toBe('自由に入力')
    expect(input.minLength).toBe(2)
    expect(input.maxLength).toBe(5)
    fireEvent.change(input, { target: { value: '😀あ' } })
    expect(screen.getByTestId('preview-char-counter').textContent).toContain('残り 3 文字')
  })

  test('renders configured defaults for single, dropdown, and multiple selections', () => {
    render(<FormPreview
      title="確認"
      renderBackend="internal"
      fields={[
        field('choice', 'ひとつ', { choices: ['A', 'B'], defaultValue: 'B' }),
        field('dropdown', '一覧', { choices: ['A', 'B'], defaultValue: 'B', placeholder: '選んでください' }),
        field('multiple_select', '複数', { choices: ['A', 'B'], defaultValues: ['A'] }),
      ]}
    />)

    expect((screen.getByLabelText('ひとつ: B') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('一覧') as HTMLSelectElement).value).toBe('B')
    expect((screen.getByLabelText('複数: A') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('複数: B') as HTMLInputElement).checked).toBe(false)
  })

  test('updates displayed defaults while the builder stays mounted', () => {
    const { rerender } = render(<FormPreview
      title="確認"
      renderBackend="internal"
      fields={[
        field('choice', 'ひとつ', { choices: ['A', 'B'], defaultValue: 'A' }),
        field('multiple_select', '複数', { choices: ['A', 'B'], defaultValues: ['A'] }),
      ]}
    />)

    rerender(<FormPreview
      title="確認"
      renderBackend="internal"
      fields={[
        field('choice', 'ひとつ', { choices: ['A', 'B'], defaultValue: 'B' }),
        field('multiple_select', '複数', { choices: ['A', 'B'], defaultValues: ['B'] }),
      ]}
    />)

    expect((screen.getByLabelText('ひとつ: B') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('複数: A') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('複数: B') as HTMLInputElement).checked).toBe(true)
  })

  test.each([
    ['datetime', 'datetime-local'],
    ['country', 'text'],
    ['postal_code', 'text'],
    ['prefecture', 'text'],
    ['address_city', 'text'],
    ['address_street', 'text'],
    ['address_building', 'text'],
  ] as const)('%s has an operable internal preview control', (type, htmlType) => {
    render(<FormPreview title="確認" renderBackend="internal" fields={[field(type, `項目-${type}`)]} />)
    expect((screen.getByLabelText(`項目-${type}`) as HTMLInputElement).type).toBe(htmlType)
  })

  test('全角郵便番号は検索用だけ正規化し、入力値を保ったまま住所3欄を補完する', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://worker.example.test')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ pref: '東京都', city: '千代田区', town: '千代田' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<FormPreview title="住所" fields={postalFields} internalLogicPreview />)
    const zip = screen.getByLabelText('郵便番号') as HTMLInputElement
    const rawZip = '１－２ー３−４‐５‑６-７'

    fireEvent.change(zip, { target: { value: rawZip } })
    fireEvent.click(screen.getByRole('button', { name: '郵便番号から住所を入力' }))

    await waitFor(() => expect(screen.getByText('住所を入力しました')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example.test/api/postal-lookup?zip=1234567',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    )
    expect(zip.value).toBe(rawZip)
    expect((screen.getByLabelText('都道府県') as HTMLInputElement).value).toBe('東京都')
    expect((screen.getByLabelText('市区町村') as HTMLInputElement).value).toBe('千代田区')
    expect((screen.getByLabelText('町域') as HTMLInputElement).value).toBe('千代田')
  })

  test('変換後も7桁数字でないプレビュー入力は従来エラーを示し、APIを呼ばない', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<FormPreview title="住所" fields={postalFields} internalLogicPreview />)
    const zip = screen.getByLabelText('郵便番号') as HTMLInputElement
    const rawZip = '１２３－４５Ａ７'

    fireEvent.change(zip, { target: { value: rawZip } })
    fireEvent.click(screen.getByRole('button', { name: '郵便番号から住所を入力' }))

    expect(screen.getByText('郵便番号は半角数字7桁で入力してください')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(zip.value).toBe(rawZip)
  })

  test('検索中に郵便番号を変えたら旧応答を住所欄へ入れない', async () => {
    let resolveResponse!: (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const pending = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
      resolveResponse = resolve
    })
    const fetchMock = vi.fn().mockReturnValue(pending)
    vi.stubGlobal('fetch', fetchMock)
    render(<FormPreview title="住所" fields={postalFields} internalLogicPreview />)
    const zip = screen.getByLabelText('郵便番号') as HTMLInputElement

    fireEvent.change(zip, { target: { value: '５６９－００００' } })
    fireEvent.click(screen.getByRole('button', { name: '郵便番号から住所を入力' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.change(zip, { target: { value: '１６０－００２２' } })
    resolveResponse({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ pref: '大阪府', city: '高槻市', town: '旧町域' }),
    })

    await waitFor(() => expect((screen.getByLabelText('都道府県') as HTMLInputElement).value).toBe(''))
    expect(screen.queryByText('住所を入力しました')).toBeNull()
  })

  test('訂正後の再検索は前回の自動入力だけ更新し、手入力した住所を保つ', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ pref: '大阪府', city: '高槻市', town: '旧町域' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ pref: '東京都', city: '新宿区', town: '新宿' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    render(<FormPreview title="住所" fields={postalFields} internalLogicPreview />)
    const zip = screen.getByLabelText('郵便番号') as HTMLInputElement
    const pref = screen.getByLabelText('都道府県') as HTMLInputElement
    const city = screen.getByLabelText('市区町村') as HTMLInputElement
    const town = screen.getByLabelText('町域') as HTMLInputElement

    fireEvent.change(zip, { target: { value: '５６９－００００' } })
    fireEvent.click(screen.getByRole('button', { name: '郵便番号から住所を入力' }))
    await waitFor(() => expect(pref.value).toBe('大阪府'))
    fireEvent.change(city, { target: { value: '利用者が手入力' } })
    fireEvent.change(town, { target: { value: '' } })
    fireEvent.change(zip, { target: { value: '１６０－００２２' } })
    fireEvent.click(screen.getByRole('button', { name: '郵便番号から住所を入力' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(pref.value).toBe('東京都'))
    expect(city.value).toBe('利用者が手入力')
    expect(town.value).toBe('')
  })
})
