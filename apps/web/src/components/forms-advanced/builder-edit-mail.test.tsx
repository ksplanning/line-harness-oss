// @vitest-environment jsdom
/**
 * form-edit-mail-link (弾L / T-C1) — builder フォーム設定に「メールで編集 URL を送る」トグル。
 *   allow_post_edit=1 (後編集許可) のときだけ有効化 (=0 では disabled = 依存を UI で表現) /
 *   ON で保存すると PUT body allowEditMail=1 / 既定 (未操作) は allowEditMail=0 / initialAllowEditMail=1 で checked。
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

describe('form-edit-mail-link — メール編集 URL トグル (T-C1)', () => {
  it('トグルが表示され allow_post_edit=0 (既定) では disabled', () => {
    render(<FormBuilder {...base()} />)
    const box = screen.getByLabelText('メールで編集URLを送る') as HTMLInputElement
    expect(box).toBeTruthy()
    expect(box.disabled).toBe(true) // 後編集不許可の間は無効
  })

  it('後編集を許可する (allow_post_edit=1) と有効化される', () => {
    render(<FormBuilder {...base()} />)
    // 「後編集を許可しない」を外す = allow_post_edit=1
    fireEvent.click(screen.getByLabelText('後編集を許可しない'))
    const box = screen.getByLabelText('メールで編集URLを送る') as HTMLInputElement
    expect(box.disabled).toBe(false)
  })

  it('ON で保存すると PUT body allowEditMail=1 が載る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialAllowPostEdit: 1, onSave })} />)
    const box = screen.getByLabelText('メールで編集URLを送る') as HTMLInputElement
    expect(box.disabled).toBe(false) // allow_post_edit=1 で有効
    fireEvent.click(box) // OFF→ON
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { allowEditMail?: number }
    expect(saved.allowEditMail).toBe(1)
  })

  it('既定 (未操作) の保存では allowEditMail=0 が載る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialAllowPostEdit: 1, onSave })} />)
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { allowEditMail?: number }
    expect(saved.allowEditMail).toBe(0)
  })

  it('initialAllowEditMail=1 で初期化すると checkbox は checked', () => {
    render(<FormBuilder {...base({ initialAllowPostEdit: 1, initialAllowEditMail: 1 })} />)
    const box = screen.getByLabelText('メールで編集URLを送る') as HTMLInputElement
    expect(box.checked).toBe(true)
  })
})
