// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import FormPreview from './form-preview'
import {
  INTERNAL_FORM_CHANNEL_SOURCE_ID,
  type HarnessField,
  type HarnessLogicRule,
} from '@line-crm/shared'

afterEach(() => cleanup())

const field = (
  id: string,
  label: string,
  position: number,
  type: HarnessField['type'] = 'text',
  choices?: string[],
): HarnessField => ({
  id,
  type,
  label,
  required: false,
  position,
  config: choices ? { choices } : {},
})

describe('FormPreview — internal renderer と共有する条件分岐', () => {
  it('opt-in した一覧形式では回答に応じて show/hide をその場で再現する', () => {
    const fields = [
      field('route', '希望する動物', 0, 'choice', ['猫', '犬']),
      field('cat-detail', '猫について教えてください', 1),
      field('contact', '連絡方法', 2),
    ]
    const logic: HarnessLogicRule[] = [
      { id: 'show-cat', sourceFieldId: 'route', operator: 'equals', value: '猫', action: 'show', targetFieldId: 'cat-detail' },
      { id: 'hide-contact', sourceFieldId: 'route', operator: 'equals', value: '犬', action: 'hide', targetFieldId: 'contact' },
    ]

    render(<FormPreview title="分岐" fields={fields} formType="simple" logic={logic} internalLogicPreview />)

    expect(screen.getByTestId('preview-fidelity-note').textContent).not.toContain('Formaloo')
    expect(screen.queryByText('猫について教えてください')).toBeNull()
    expect(screen.getByText('連絡方法')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('プレビュー 猫'))
    expect(screen.getByText('猫について教えてください')).toBeTruthy()
    expect(screen.getByText('連絡方法')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('プレビュー 犬'))
    expect(screen.queryByText('猫について教えてください')).toBeNull()
    expect(screen.queryByText('連絡方法')).toBeNull()
  })

  it('親が隠れると下位も隠れ、親の再表示時に保持回答で下位条件を再評価する', () => {
    const fields = [
      field('gate', '追加質問を表示しますか', 0, 'choice', ['はい', 'いいえ']),
      field('nested', '下位の選択', 1, 'choice', ['開く', '閉じる']),
      field('detail', '下位の詳細', 2),
    ]
    const logic: HarnessLogicRule[] = [
      { id: 'show-nested', sourceFieldId: 'gate', operator: 'equals', value: 'はい', action: 'show', targetFieldId: 'nested' },
      { id: 'show-detail', sourceFieldId: 'nested', operator: 'equals', value: '開く', action: 'show', targetFieldId: 'detail' },
    ]

    render(<FormPreview title="入れ子" fields={fields} logic={logic} internalLogicPreview />)
    expect(screen.queryByText('下位の選択')).toBeNull()
    expect(screen.queryByText('下位の詳細')).toBeNull()

    fireEvent.click(screen.getByLabelText('プレビュー はい'))
    expect(screen.getByText('下位の選択')).toBeTruthy()
    expect(screen.queryByText('下位の詳細')).toBeNull()

    fireEvent.click(screen.getByLabelText('プレビュー 開く'))
    expect(screen.getByText('下位の詳細')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('プレビュー いいえ'))
    expect(screen.queryByText('下位の選択')).toBeNull()
    expect(screen.queryByText('下位の詳細')).toBeNull()

    fireEvent.click(screen.getByLabelText('プレビュー はい'))
    expect(screen.getByText('下位の選択')).toBeTruthy()
    expect(screen.getByText('下位の詳細')).toBeTruthy()
  })

  it('選択肢の編集後は削除済みの回答で分岐し続けない', () => {
    const detail = field('detail', 'Bルートの質問', 1)
    const logic: HarnessLogicRule[] = [{
      id: 'show-b', sourceFieldId: 'route', operator: 'equals', value: 'B',
      action: 'show', targetFieldId: 'detail',
    }]
    const { rerender } = render(
      <FormPreview
        title="選択肢編集"
        fields={[field('route', 'ルート', 0, 'choice', ['A', 'B']), detail]}
        logic={logic}
        internalLogicPreview
      />,
    )

    fireEvent.click(screen.getByLabelText('プレビュー B'))
    expect(screen.getByText('Bルートの質問')).toBeTruthy()

    rerender(
      <FormPreview
        title="選択肢編集"
        fields={[field('route', 'ルート', 0, 'choice', ['A']), detail]}
        logic={logic}
        internalLogicPreview
      />,
    )

    expect(screen.queryByText('Bルートの質問')).toBeNull()

    rerender(
      <FormPreview
        title="選択肢編集"
        fields={[field('route', 'ルート', 0, 'choice', ['A', 'B']), detail]}
        logic={logic}
        internalLogicPreview
      />,
    )

    expect(screen.queryByText('Bルートの質問')).toBeNull()
  })

  it('経由チャネルを切り替えると LINE / 埋め込み・直リンク用の項目を切り替える', () => {
    const fields = [
      field('web-email', 'メールアドレス', 0, 'email'),
      field('line-note', 'LINEのお客様向け案内', 1),
    ]
    const logic: HarnessLogicRule[] = [
      { id: 'web-only', sourceFieldId: INTERNAL_FORM_CHANNEL_SOURCE_ID, operator: 'equals', value: 'web', action: 'show', targetFieldId: 'web-email' },
      { id: 'line-only', sourceFieldId: INTERNAL_FORM_CHANNEL_SOURCE_ID, operator: 'equals', value: 'line', action: 'show', targetFieldId: 'line-note' },
    ]

    render(<FormPreview title="チャネル" fields={fields} logic={logic} internalLogicPreview />)

    expect(screen.getByText('メールアドレス')).toBeTruthy()
    expect(screen.queryByText('LINEのお客様向け案内')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'LINE経由' }))
    expect(screen.queryByText('メールアドレス')).toBeNull()
    expect(screen.getByText('LINEのお客様向け案内')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '埋め込み・直リンク経由' }))
    expect(screen.getByText('メールアドレス')).toBeTruthy()
    expect(screen.queryByText('LINEのお客様向け案内')).toBeNull()
  })

  it('一覧形式でも ABC jump の選択ルートだけを表示する', () => {
    const fields = [
      field('route', 'ルート選択', 0, 'choice', ['A', 'B', 'C']),
      field('route-a', 'Aルート', 1, 'section'),
      field('a1', 'Aの質問', 2),
      field('route-b', 'Bルート', 3, 'section'),
      field('b1', 'Bの質問', 4),
      field('route-c', 'Cルート', 5, 'section'),
      field('c1', 'Cの質問', 6),
    ]
    const logic: HarnessLogicRule[] = ['A', 'B', 'C'].map((value) => ({
      id: `jump-${value}`,
      sourceFieldId: 'route',
      operator: 'equals',
      value,
      action: 'jump',
      targetFieldId: `route-${value.toLowerCase()}`,
    }))

    render(<FormPreview title="ABC" fields={fields} formType="simple" logic={logic} internalLogicPreview />)

    expect(screen.queryByText('Aの質問')).toBeNull()
    expect(screen.queryByText('Bの質問')).toBeNull()
    expect(screen.queryByText('Cの質問')).toBeNull()

    fireEvent.click(screen.getByLabelText('プレビュー B'))
    expect(screen.queryByText('Aの質問')).toBeNull()
    expect(screen.getByText('Bの質問')).toBeTruthy()
    expect(screen.queryByText('Cの質問')).toBeNull()
  })

  it('1問ずつ表示では jump 先へ進み、submit rule のルート別完了ページを示す', () => {
    const fields = [
      field('route', 'ルート選択', 0, 'choice', ['A', 'B']),
      field('route-a', 'Aルート', 1, 'section'),
      field('a1', 'Aの質問', 2),
      field('route-b', 'Bルート', 3, 'section'),
      field('b1', 'Bの質問', 4),
    ]
    const logic: HarnessLogicRule[] = [
      { id: 'jump-a', sourceFieldId: 'route', operator: 'equals', value: 'A', action: 'jump', targetFieldId: 'route-a' },
      { id: 'jump-b', sourceFieldId: 'route', operator: 'equals', value: 'B', action: 'jump', targetFieldId: 'route-b' },
      {
        id: 'finish-b',
        sourceFieldId: 'b1',
        operator: 'equals',
        value: '',
        action: 'submit',
        targetFieldId: 'thanks-b',
        terminalTrigger: 'on_answered',
      },
    ]

    render(
      <FormPreview
        title="ルート完了"
        fields={fields}
        formType="multi_step"
        logic={logic}
        successPages={[{ id: 'thanks-b', title: 'Bルート完了', description: 'Bを選んだ方への案内です' }]}
        internalLogicPreview
      />,
    )

    expect(screen.getByText('ルート選択')).toBeTruthy()
    expect(screen.queryByText('Bルート')).toBeNull()
    fireEvent.click(screen.getByLabelText('プレビュー B'))
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
    expect(screen.queryByText('Bルート')).toBeNull()
    expect(screen.getByText('Bの質問')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Bの質問'), { target: { value: '回答済み' } })

    expect(screen.queryByTestId('preview-route-completion')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))
    expect(screen.getByTestId('preview-route-completion').textContent).toContain('Bルート完了')
    expect(screen.getByTestId('preview-route-completion').textContent).toContain('Bを選んだ方への案内です')
    expect(screen.queryByRole('button', { name: '次へ' })).toBeNull()
  })

  it('1問ずつ表示では本番同様、現在の必須項目を回答するまで次へ進めない', () => {
    const requiredName = { ...field('name', 'お名前', 0), required: true }
    const next = field('next', '次の質問', 1)

    render(
      <FormPreview
        title="必須確認"
        fields={[requiredName, next]}
        formType="multi_step"
        internalLogicPreview
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
    expect(screen.getByText('お名前')).toBeTruthy()
    expect(screen.queryByText('次の質問')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('必須')

    fireEvent.change(screen.getByLabelText('お名前'), { target: { value: '佐藤' } })
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
    expect(screen.getByText('次の質問')).toBeTruthy()
  })

  it('本番と同じ和文フォントpresetと暗色themeをルート完了表示にも反映する', () => {
    const fields = [field('answer', '回答', 0)]
    const logic: HarnessLogicRule[] = [{
      id: 'finish', sourceFieldId: 'answer', operator: 'equals', value: '', action: 'submit',
      targetFieldId: 'dark-done', terminalTrigger: 'on_answered',
    }]
    render(
      <FormPreview
        title="暗色テーマ"
        fields={fields}
        logic={logic}
        design={{ presetId: 'dark-sumi', textColor: '#F5F5F5', fieldColor: '#202020' }}
        successPages={[{ id: 'dark-done', title: '送信できます', description: '確認してください' }]}
        internalLogicPreview
      />,
    )

    expect(screen.getByTestId('preview-frame').style.fontFamily).toContain('Noto Serif JP')
    fireEvent.change(screen.getByLabelText('回答'), { target: { value: '入力済み' } })
    expect(screen.queryByTestId('preview-route-completion')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))
    const completion = screen.getByTestId('preview-route-completion')
    expect((screen.getByText('送信できます') as HTMLElement).style.color).toBe('rgb(245, 245, 245)')
    expect(completion.textContent).toContain('確認してください')
  })

  it('通常送信でも保存したボタン文言と完了メッセージを再現する', () => {
    render(
      <FormPreview
        title="通常完了"
        fields={[field('answer', '回答', 0)]}
        logic={[]}
        design={{ themeColor: '#123456' }}
        formCopy={{ buttonText: '申し込む', successMessage: 'お申し込みを受け付けました' }}
        internalLogicPreview
      />,
    )

    const submit = screen.getByRole('button', { name: '申し込む' })
    expect((submit as HTMLButtonElement).style.backgroundColor).toBe('rgb(18, 52, 86)')
    fireEvent.click(submit)

    expect(screen.getByTestId('preview-route-completion').textContent)
      .toContain('お申し込みを受け付けました')
    expect(screen.queryByRole('button', { name: '申し込む' })).toBeNull()
    expect(screen.queryByText('通常完了')).toBeNull()
    expect(screen.queryByLabelText('回答')).toBeNull()
  })

  it('送信後リダイレクトは画面遷移せず、本番の飛び先と開き方を示す', () => {
    render(
      <FormPreview
        title="リダイレクト確認"
        fields={[field('answer', '回答', 0)]}
        formRedirect={{ url: 'https://example.test/complete?source=form#done', openExternalBrowser: true }}
        internalLogicPreview
      />,
    )

    fireEvent.change(screen.getByLabelText('回答'), { target: { value: '入力済み' } })
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))

    const redirect = screen.getByTestId('preview-redirect-completion')
    expect(redirect.textContent).toContain('https://example.test/complete?source=form&openExternalBrowser=1#done')
    expect(redirect.textContent).toContain('LINE外のブラウザ')
    expect(screen.queryByLabelText('回答')).toBeNull()
  })

  it('完了表示から回答を消して先頭ルートをもう一度試せる', () => {
    render(
      <FormPreview
        title="再試行"
        fields={[field('route', 'ルート', 0, 'choice', ['A', 'B'])]}
        internalLogicPreview
      />,
    )

    fireEvent.click(screen.getByLabelText('プレビュー B'))
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))
    expect(screen.getByTestId('preview-route-completion')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }))

    expect(screen.queryByTestId('preview-route-completion')).toBeNull()
    expect((screen.getByLabelText('プレビュー B') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('preview-channel-toggle')).toBeTruthy()
  })

  it('target が空の terminal でも保存した通常完了メッセージを示す', () => {
    const answer = field('answer', '回答', 0)
    const logic: HarnessLogicRule[] = [{
      id: 'finish-without-page',
      sourceFieldId: 'answer',
      operator: 'equals',
      value: '',
      action: 'submit',
      targetFieldId: '',
      terminalTrigger: 'on_answered',
    }]

    render(
      <FormPreview
        title="target なし完了"
        fields={[answer]}
        logic={logic}
        formCopy={{ successMessage: '個別ページなしで受け付けました' }}
        internalLogicPreview
      />,
    )

    fireEvent.change(screen.getByLabelText('回答'), { target: { value: '入力済み' } })
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))

    expect(screen.getByTestId('preview-route-completion').textContent)
      .toContain('個別ページなしで受け付けました')
  })

  it('target が空の terminal で完了文言未設定なら本番と同じ既定文言を示す', () => {
    const answer = field('answer', '回答', 0)
    const logic: HarnessLogicRule[] = [{
      id: 'finish-with-default',
      sourceFieldId: 'answer',
      operator: 'equals',
      value: '',
      action: 'submit',
      targetFieldId: '',
      terminalTrigger: 'on_answered',
    }]

    render(<FormPreview title="既定完了" fields={[answer]} logic={logic} internalLogicPreview />)

    fireEvent.change(screen.getByLabelText('回答'), { target: { value: '入力済み' } })
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))

    expect(screen.getByTestId('preview-route-completion').textContent).toContain('送信ありがとうございました')
  })

  it('一覧形式は表示中の2件目以降も required と HTML validity を確認する', () => {
    const name = { ...field('name', 'お名前', 0), required: true }
    const email = { ...field('email', 'メールアドレス', 1, 'email'), required: true }
    const hidden = { ...field('hidden', '非表示の必須項目', 2), required: true }
    const logic: HarnessLogicRule[] = [{
      id: 'never-show-hidden',
      sourceFieldId: 'name',
      operator: 'equals',
      value: '表示する',
      action: 'show',
      targetFieldId: 'hidden',
    }]

    render(
      <FormPreview
        title="一覧必須確認"
        fields={[name, email, hidden]}
        formType="simple"
        logic={logic}
        internalLogicPreview
      />,
    )

    fireEvent.change(screen.getByLabelText('お名前'), { target: { value: '佐藤' } })
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))
    expect(screen.getByRole('alert').textContent).toContain('メールアドレス は必須項目です')
    expect(screen.queryByTestId('preview-route-completion')).toBeNull()

    fireEvent.change(screen.getByLabelText('メールアドレス'), { target: { value: 'mail-address' } })
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))
    expect(screen.getByRole('alert').textContent).toContain('メールアドレス の入力内容を確認してください')
    expect(screen.queryByTestId('preview-route-completion')).toBeNull()

    fireEvent.change(screen.getByLabelText('メールアドレス'), { target: { value: 'sato@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))
    expect(screen.getByTestId('preview-route-completion').textContent).toContain('送信ありがとうございました')
  })

  it('背景全面と入力欄の3色を自前公開ページと同じ役割で描画する', () => {
    render(
      <FormPreview
        title="デザイン確認"
        fields={[field('name', 'お名前', 0)]}
        design={{
          backgroundColor: '#112233',
          backgroundImageUrl: 'https://img.example.test/background.png',
          fieldColor: '#223344',
          borderColor: '#556677',
          textColor: '#F1F2F3',
        }}
        internalLogicPreview
      />,
    )

    const frame = screen.getByTestId('preview-frame')
    expect(frame.style.backgroundImage).toContain('https://img.example.test/background.png')
    expect(frame.style.backgroundSize).toBe('cover')
    expect((frame.querySelector('header') as HTMLElement).style.backgroundImage).toBe('')

    const surface = screen.getByTestId('preview-surface')
    expect(surface.style.backgroundColor).toBe('rgb(34, 51, 68)')
    expect(surface.style.borderColor).toBe('rgb(85, 102, 119)')
    const input = screen.getByLabelText('お名前') as HTMLInputElement
    expect(input.style.backgroundColor).toBe('rgb(34, 51, 68)')
    expect(input.style.borderColor).toBe('rgb(85, 102, 119)')
    expect(input.style.color).toBe('rgb(241, 242, 243)')
  })

  it('opt-in しない従来プレビューは logic があっても全項目を表示しチャネル切替を出さない', () => {
    const fields = [field('route', '選択', 0, 'choice', ['表示']), field('detail', '従来どおり表示', 1)]
    const logic: HarnessLogicRule[] = [
      { id: 'show-detail', sourceFieldId: 'route', operator: 'equals', value: '表示', action: 'show', targetFieldId: 'detail' },
    ]

    render(
      <FormPreview
        title="従来"
        fields={fields}
        logic={logic}
        formCopy={{ buttonText: '内部専用ボタン', successMessage: '内部専用完了' }}
      />,
    )

    expect(screen.getByText('従来どおり表示')).toBeTruthy()
    expect(screen.queryByTestId('preview-channel-toggle')).toBeNull()
    expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '内部専用ボタン' })).toBeNull()
  })
})
