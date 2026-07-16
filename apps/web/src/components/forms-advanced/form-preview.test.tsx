// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { HarnessField, FormDesign } from '@line-crm/shared'
import FormPreview from './form-preview'

afterEach(() => cleanup())

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '')
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`
}
function colorMatches(actual: string, hex: string): boolean {
  return actual.toLowerCase() === hex.toLowerCase() || actual === hexToRgb(hex)
}

const inputFields: HarnessField[] = [
  { id: 'text', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
  { id: 'textarea', type: 'textarea', label: 'お問い合わせ内容', required: true, position: 1, config: {} },
  { id: 'number', type: 'number', label: '人数', required: true, position: 2, config: {} },
  { id: 'email', type: 'email', label: 'メールアドレス', required: true, position: 3, config: {} },
  { id: 'phone', type: 'phone', label: '電話番号', required: true, position: 4, config: {} },
  { id: 'date', type: 'date', label: '希望日', required: true, position: 5, config: {} },
  { id: 'choice', type: 'choice', label: 'ご希望', required: true, position: 6, config: { choices: ['相談', '見積もり'] } },
  { id: 'dropdown', type: 'dropdown', label: 'ご連絡時間', required: true, position: 7, config: { choices: ['午前', '午後'] } },
  { id: 'multiple', type: 'multiple_select', label: '興味のある内容', required: true, position: 8, config: { choices: ['製品', '採用'] } },
  { id: 'file', type: 'file', label: '添付資料', required: true, position: 9, config: { allowedExtensions: ['pdf'] } },
]

describe('FormPreview — harness self-render (T-C1)', () => {
  it('10 種の入力 field を given order で描画し、ラベル・必須・型別 control・選択肢を出す', () => {
    render(<FormPreview title="お問い合わせ" fields={inputFields} />)

    const preview = screen.getByTestId('form-preview')
    const fieldNodes = screen.getAllByTestId('preview-field')
    expect(fieldNodes).toHaveLength(10)
    expect(fieldNodes.map((node) => inputFields.findIndex((field) => node.textContent?.includes(field.label)))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    for (const [index, field] of inputFields.entries()) {
      expect(within(fieldNodes[index]).getByText(field.label)).toBeTruthy()
      expect(within(fieldNodes[index]).getByText('必須')).toBeTruthy()
    }

    expect(fieldNodes[0].querySelector('input[type="text"]')).toBeTruthy()
    expect(fieldNodes[1].querySelector('textarea')).toBeTruthy()
    expect(fieldNodes[2].querySelector('input[type="number"]')).toBeTruthy()
    expect(fieldNodes[3].querySelector('input[type="email"]')).toBeTruthy()
    expect(fieldNodes[4].querySelector('input[type="tel"]')).toBeTruthy()
    expect(fieldNodes[5].querySelector('input[type="date"]')).toBeTruthy()

    const choice = fieldNodes[6]
    expect((within(choice).getByLabelText('プレビュー 相談') as HTMLInputElement).type).toBe('radio')
    expect((within(choice).getByLabelText('プレビュー 見積もり') as HTMLInputElement).type).toBe('radio')

    const dropdown = fieldNodes[7]
    const select = dropdown.querySelector('select') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['午前', '午後'])

    const multiple = fieldNodes[8]
    expect((within(multiple).getByLabelText('プレビュー 製品') as HTMLInputElement).type).toBe('checkbox')
    expect((within(multiple).getByLabelText('プレビュー 採用') as HTMLInputElement).type).toBe('checkbox')

    expect(fieldNodes[9].querySelector('input[type="file"]')).toBeTruthy()
    expect(within(fieldNodes[9]).getByText('ファイルを添付する項目です。実際の選択は公開フォームで行えます。')).toBeTruthy()

    // Formaloo hosted iframe との比較ではなく、harness 内で全 control を self-render する。
    expect(preview.querySelector('iframe')).toBeNull()
    expect(preview.querySelector('[src*="formaloo"]')).toBeNull()
  })

  it('既定の preview frame は 375px 幅で中央配置される', () => {
    render(<FormPreview title="スマホ確認" fields={[]} />)
    const frame = screen.getByTestId('preview-frame')
    expect(frame.style.maxWidth).toBe('375px')
    expect(frame.className).toContain('mx-auto')
  })
})

describe('FormPreview — header と装飾 (T-C2)', () => {
  it('タイトル・説明と、section の見出し＋本文、page_break の divider を入力なしで描画する', () => {
    const fields: HarnessField[] = [
      { id: 'section', type: 'section', label: 'ご利用前の案内', required: true, position: 0, config: { text: '注意事項をお読みください' } },
      { id: 'text', type: 'text', label: '確認項目', required: false, position: 1, config: {} },
      { id: 'page', type: 'page_break', label: '', required: true, position: 2, config: {} },
    ]
    render(<FormPreview title="予約フォーム" description="必要事項をご入力ください" fields={fields} />)

    const frame = screen.getByTestId('preview-frame')
    expect(within(frame).getByText('予約フォーム').tagName).toBe('H2')
    expect(within(frame).getByText('必要事項をご入力ください').tagName).toBe('P')

    const section = screen.getByTestId('preview-section')
    expect(within(section).getByText('ご利用前の案内')).toBeTruthy()
    expect(within(section).getByText('注意事項をお読みください')).toBeTruthy()
    expect(within(section).queryByText('必須')).toBeNull()
    expect(section.querySelector('input, textarea, select, button')).toBeNull()

    const pageBreak = screen.getByTestId('preview-page-break')
    expect(within(pageBreak).getByText('改ページ')).toBeTruthy()
    expect(within(pageBreak).queryByText('必須')).toBeNull()
    expect(pageBreak.querySelector('input, textarea, select, button')).toBeNull()

    const visibleOrder = frame.textContent ?? ''
    expect(visibleOrder.indexOf('ご利用前の案内')).toBeLessThan(visibleOrder.indexOf('確認項目'))
    expect(visibleOrder.indexOf('確認項目')).toBeLessThan(visibleOrder.indexOf('改ページ'))
  })

  it('空の説明は header に余分な paragraph を描画しない', () => {
    render(<FormPreview title="説明なし" description="" fields={[]} />)
    expect(screen.getByTestId('preview-frame').querySelector('header p')).toBeNull()
  })
})

describe('FormPreview — form-design 反映 (Batch D)', () => {
  const design: FormDesign = {
    themeColor: '#285C66',
    backgroundColor: '#EEF5F4',
    buttonColor: '#327682',
    textColor: '#183A40',
    submitTextColor: '#FFFFFF',
    logoUrl: 'https://s3/logo.png',
    backgroundImageUrl: 'https://s3/cover.png',
  }

  it('テーマ色を header/背景/送信ボタンに反映する', () => {
    render(<FormPreview title="ブランド" fields={[]} design={design} />)
    const frame = screen.getByTestId('preview-frame')
    const header = frame.querySelector('header') as HTMLElement
    expect(colorMatches(header.style.borderTopColor, '#285C66')).toBe(true)
    const send = within(frame).getByText('送信') as HTMLButtonElement
    expect(colorMatches(send.style.backgroundColor, '#327682')).toBe(true)
    expect(colorMatches(frame.style.backgroundColor, '#EEF5F4')).toBe(true)
  })

  it('ロゴとカバー画像を描画する', () => {
    render(<FormPreview title="ブランド" fields={[]} design={design} />)
    const logo = screen.getByTestId('preview-logo') as HTMLImageElement
    expect(logo.getAttribute('src')).toBe('https://s3/logo.png')
    const cover = screen.getByTestId('preview-cover')
    expect(cover.style.backgroundImage).toContain('https://s3/cover.png')
  })

  it('design 反映時は fidelity note を「反映しています」に更新する', () => {
    render(<FormPreview title="ブランド" fields={[]} design={design} />)
    const note = screen.getByTestId('preview-fidelity-note')
    expect(note.textContent).toContain('設定したテーマ色')
    expect(note.textContent).toContain('公開時に Formaloo')
  })

  it('design 無しは従来の note (後方互換)', () => {
    render(<FormPreview title="無地" fields={[]} />)
    const note = screen.getByTestId('preview-fidelity-note')
    expect(note.textContent).toContain('色・フォント・ロゴは公開時に Formaloo 側のテーマで決まります。')
    expect(screen.queryByTestId('preview-logo')).toBeNull()
  })
})

describe('FormPreview — 補足説明 + 最大文字数ヒント + 縮退カウンター注記 (field-help-charlimit T-A5)', () => {
  it('補足説明をラベルの直下に描画する', () => {
    const fields: HarnessField[] = [
      { id: 'phone', type: 'text', label: '電話番号', required: false, position: 0, config: { description: '例: 日中つながる番号をご記入ください' } },
    ]
    render(<FormPreview title="確認" fields={fields} />)
    const node = screen.getByTestId('preview-field')
    expect(within(node).getByText('例: 日中つながる番号をご記入ください')).toBeTruthy()
    // ラベル (電話番号) より後・control より前に位置する (ラベル直下)
    const text = node.textContent ?? ''
    expect(text.indexOf('電話番号')).toBeLessThan(text.indexOf('例: 日中つながる番号'))
  })

  it('補足説明が未設定の field には説明の段落を描画しない', () => {
    render(<FormPreview title="確認" fields={[{ id: 't', type: 'text', label: '名前', required: false, position: 0, config: {} }]} />)
    const node = screen.getByTestId('preview-field')
    expect(node.querySelector('[data-testid="preview-field-description"]')).toBeNull()
  })

  it('一行テキストに最大文字数を設定すると「最大 N 文字」の静的ヒントを入力欄下に描画する', () => {
    render(<FormPreview title="確認" fields={[{ id: 't', type: 'text', label: 'お名前', required: false, position: 0, config: { maxLength: 8 } }]} />)
    const node = screen.getByTestId('preview-field')
    expect(within(node).getByText(/最大\s*8\s*文字/)).toBeTruthy()
  })

  it('複数行テキストは最大文字数を設定してもヒントを出さない (OD-2: hosted 非対応)', () => {
    render(<FormPreview title="確認" fields={[{ id: 'ta', type: 'textarea', label: 'ご要望', required: false, position: 0, config: { maxLength: 8 } }]} />)
    const node = screen.getByTestId('preview-field')
    expect(within(node).queryByText(/最大\s*8\s*文字/)).toBeNull()
  })

  it('忠実性注記が公開フォームの実挙動 (静的注記+超過エラー / ライブカウンター無し) を正しく説明する', () => {
    render(<FormPreview title="確認" fields={[]} />)
    const note = screen.getByTestId('preview-fidelity-note')
    expect(note.textContent).toContain('残り文字数')
    expect(note.textContent).toContain('表示されません')
  })
})

describe('FormPreview — fidelity disclosure と read-only regression (T-C5/T-C7/R-4)', () => {
  it('公開フォームとの差分を 3 点とも正直に開示する', () => {
    render(<FormPreview title="確認" fields={[]} />)
    const note = screen.getByTestId('preview-fidelity-note')

    expect(note.textContent).toContain('見出しや説明文も公開フォームに表示されます。')
    expect(note.textContent).toContain('色・フォント・ロゴは公開時に Formaloo 側のテーマで決まります。')
    expect(note.textContent).toContain('これは見た目の確認用のプレビューです（read-only）。入力・条件分岐・送信などの実際の動作は公開フォームで動きます。')
  })

  it('form や submit control を作らず、すべての control を disabled に固定する', () => {
    render(<FormPreview title="確認" fields={inputFields} />)
    const preview = screen.getByTestId('form-preview')

    expect(preview.querySelector('form')).toBeNull()
    expect(preview.querySelector('button[type="submit"], input[type="submit"]')).toBeNull()
    const controls = Array.from(preview.querySelectorAll('input, textarea, select, button')) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>
    expect(controls.length).toBeGreaterThan(0)
    expect(controls.every((control) => control.disabled)).toBe(true)

    const send = within(preview).queryByText('送信') as HTMLButtonElement | null
    if (send) {
      expect(send.type).toBe('button')
      expect(send.disabled).toBe(true)
    }

    // disabled control は change しても値を受け付ける動作を component 側に持たない。
    const text = preview.querySelector('input[type="text"]') as HTMLInputElement
    fireEvent.change(text, { target: { value: '入力しても送信されない' } })
    expect(preview.querySelector('form')).toBeNull()
  })
})
