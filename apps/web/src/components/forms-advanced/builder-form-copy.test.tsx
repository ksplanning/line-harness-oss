// @vitest-environment jsdom
/**
 * FormBuilder (form-jp-localization T-C1) — 公開ページ文言 (送信ボタン/完了/送信エラー) の設定セクション。
 *   - 3 input が描画され、入力すると onSave payload に formCopy(完全 object) が載る。
 *   - 初期未編集は formCopy を送らない (既存フォーム不干渉 = absent)。
 *   - ①制約注記 (文字数オーバー等は Formaloo 固定で変更不可) が表示される (AC-6 / できない事を見せる)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FormBuilder from './builder'
import type { HarnessField } from '@line-crm/shared'

afterEach(() => cleanup())

function base(overrides = {}) {
  return {
    formTitle: 'テスト',
    status: 'draft' as const,
    initialFields: [] as HarnessField[],
    initialLogic: [],
    onSave: vi.fn(),
    ...overrides,
  }
}

describe('FormBuilder — 公開ページ文言セクション (form-jp-localization T-C1)', () => {
  it('送信ボタン/完了/送信エラー の 3 input が描画される', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.getByLabelText('送信ボタンの文言')).toBeTruthy()
    expect(screen.getByLabelText('送信完了メッセージ')).toBeTruthy()
    expect(screen.getByLabelText('送信エラー時の文言')).toBeTruthy()
  })

  it('①制約注記 (文字数オーバー等は Formaloo 固定で変更不可) を表示する (AC-6)', () => {
    render(<FormBuilder {...base()} />)
    const note = screen.getByTestId('form-copy-constraint-note')
    expect(note.textContent).toMatch(/変更できません/)
    expect(note.textContent).toMatch(/less than/)
  })

  it('文言を入力して保存すると onSave payload に formCopy が完全 object で載る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.change(screen.getByLabelText('送信ボタンの文言'), { target: { value: '送信' } })
    fireEvent.change(screen.getByLabelText('送信完了メッセージ'), { target: { value: 'ありがとうございました' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { formCopy?: Record<string, string> }
    expect(saved.formCopy).toEqual({ buttonText: '送信', successMessage: 'ありがとうございました', errorMessage: '' })
  })

  it('初期未編集 (文言を触らない) の保存は formCopy を送らない (absent = 既存不干渉)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { formCopy?: unknown }
    expect('formCopy' in saved).toBe(false)
  })

  it('送信エラー文言だけ入力しても formCopy に完全 object (他キーは空文字) で載る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.change(screen.getByLabelText('送信エラー時の文言'), { target: { value: '送信に失敗しました' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { formCopy?: Record<string, string> }
    expect(saved.formCopy).toEqual({ buttonText: '', successMessage: '', errorMessage: '送信に失敗しました' })
  })
})
