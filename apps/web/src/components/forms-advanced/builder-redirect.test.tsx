// @vitest-environment jsdom
/**
 * FormBuilder (route-terminal-phase2 T-C1) — 送信後リダイレクト設定セクション。
 *   - URL input +「LINE内で開く/外部ブラウザで開く」toggle が描画される。
 *   - 非 https URL 入力で inline error が出て保存を阻む (onSave 呼ばれない)。
 *   - 初期未編集は formRedirect を送らない (absent = 既存フォーム不干渉)。編集後は onSave payload に載る。
 *   - include-data toggle は描画されない (CI-1: MVP 非露出)。
 * builder-form-copy.test.tsx を写経元にした専用 harness。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
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

describe('FormBuilder — 送信後リダイレクトセクション (route-terminal-phase2 T-C1)', () => {
  it('URL input と 開き方 toggle が描画される', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.getByLabelText('送信後の飛び先 URL')).toBeTruthy()
    expect(screen.getByLabelText('飛び先の開き方')).toBeTruthy()
  })

  it('include-data toggle は描画されない (CI-1: MVP 非露出)', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.queryByText(/回答データを付与|回答内容を付与|include.data/i)).toBeNull()
  })

  it('非 https URL で inline error が出て保存を阻む (onSave 呼ばれない)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.change(screen.getByLabelText('送信後の飛び先 URL'), { target: { value: 'http://x.com' } })
    expect(screen.getByTestId('redirect-url-error')).toBeTruthy()
    fireEvent.click(screen.getByText('保存'))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('javascript: スキームも inline error で保存を阻む', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.change(screen.getByLabelText('送信後の飛び先 URL'), { target: { value: 'javascript:alert(1)' } })
    expect(screen.getByTestId('redirect-url-error')).toBeTruthy()
    fireEvent.click(screen.getByText('保存'))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('有効 https URL を入力して保存すると onSave payload に formRedirect が載る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.change(screen.getByLabelText('送信後の飛び先 URL'), { target: { value: 'https://example.com/lp' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { formRedirect?: Record<string, unknown> }
    expect(saved.formRedirect).toEqual({ url: 'https://example.com/lp', openExternalBrowser: false })
  })

  it('外部ブラウザ toggle を選ぶと openExternalBrowser=true が onSave に載る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.change(screen.getByLabelText('送信後の飛び先 URL'), { target: { value: 'https://example.com/lp' } })
    fireEvent.change(screen.getByLabelText('飛び先の開き方'), { target: { value: 'external' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { formRedirect?: Record<string, unknown> }
    expect(saved.formRedirect).toEqual({ url: 'https://example.com/lp', openExternalBrowser: true })
  })

  it('初期未編集 (redirect を触らない) の保存は formRedirect を送らない (absent)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { formRedirect?: unknown }
    expect('formRedirect' in saved).toBe(false)
  })

  it('initialFormRedirect があれば URL input に保存値が復元表示される (T-C3 load)', () => {
    render(<FormBuilder {...base({ initialFormRedirect: { url: 'https://saved.example.com/lp', openExternalBrowser: true } })} />)
    expect((screen.getByLabelText('送信後の飛び先 URL') as HTMLInputElement).value).toBe('https://saved.example.com/lp')
    expect((screen.getByLabelText('飛び先の開き方') as HTMLSelectElement).value).toBe('external')
  })

  it('復元済 redirect を空にして保存すると formRedirect(url 空)が載る = clear 意図 (T-C3)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave, initialFormRedirect: { url: 'https://saved.example.com/lp' } })} />)
    fireEvent.change(screen.getByLabelText('送信後の飛び先 URL'), { target: { value: '' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { formRedirect?: { url: string } }
    expect(saved.formRedirect).toEqual({ url: '', openExternalBrowser: false })
  })

  // fix round (defect 1 / T-C3 gap): reimport 後もリダイレクト URL が画面に残る回帰。
  it('Formaloo 再取り込み後は redirect state をリセットする (未保存編集の破棄・formCopy と同型)', async () => {
    const onSave = vi.fn()
    const onReimport = vi.fn().mockResolvedValue({ ok: true, fields: [], logic: [], note: '取り込みました' })
    render(<FormBuilder {...base({ onSave, onReimport, initialFormRedirect: { url: 'https://saved.example.com/lp', openExternalBrowser: true } })} />)
    // 復元済の redirect が表示されている。
    expect((screen.getByLabelText('送信後の飛び先 URL') as HTMLInputElement).value).toBe('https://saved.example.com/lp')
    // 再取り込み → 確認 → はい。
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    await act(async () => { fireEvent.click(screen.getByText('はい')) })
    // reimport 後は redirect が空 (完了ページ/文言と同じく未保存編集を破棄) = 画面にリダイレクト URL が残らない。
    expect((screen.getByLabelText('送信後の飛び先 URL') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('飛び先の開き方') as HTMLSelectElement).value).toBe('line')
    // reimport 後の未編集保存は formRedirect を送らない (touched=false = 既存 redirect を誤クリアしない)。
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { formRedirect?: unknown }
    expect('formRedirect' in saved).toBe(false)
  })
})
