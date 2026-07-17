// @vitest-environment jsdom
/**
 * FormBuilder (route-terminal-phase2 T-F1/T-F2) — ルート別完了ページ (success-page) の UI。
 *   - 完了ページ管理パネル: 作成/命名/編集/削除。書式なし注記 (M5)。
 *   - submit rule 行の per-route 完了ページ select が successPages 候補で有効化される。
 *   - 触ったときだけ onSave payload に successPages が載る (初期未編集は absent)。initial 復元。
 * builder-form-copy.test.tsx / builder-redirect.test.tsx を写経元にした harness。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import FormBuilder from './builder'
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared'

afterEach(() => cleanup())

const NAME: HarnessField = { id: 'q1', type: 'text', label: '名前', required: false, position: 0, config: {} }
const submitRule: HarnessLogicRule = { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: '', action: 'submit', targetFieldId: '' }

function base(overrides = {}) {
  return {
    formTitle: 'テスト',
    status: 'draft' as const,
    initialFields: [NAME],
    initialLogic: [] as HarnessLogicRule[],
    onSave: vi.fn(),
    ...overrides,
  }
}

describe('FormBuilder — ルート別完了ページ管理 (T-F1)', () => {
  it('完了ページ管理パネルと書式なし注記 (M5) が描画される', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.getByTestId('success-page-section')).toBeTruthy()
    expect(screen.getByTestId('success-page-note').textContent).toMatch(/書式なし/)
  })

  it('「＋ 完了ページを追加」で SP を作成し、見出し/説明を編集して保存すると onSave に successPages が載る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByText('＋ 完了ページを追加'))
    fireEvent.change(screen.getByLabelText('完了ページの見出し'), { target: { value: 'Aルート完了' } })
    fireEvent.change(screen.getByLabelText('完了ページの説明'), { target: { value: 'ご回答ありがとう' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { successPages?: Array<{ title: string; description?: string }> }
    expect(saved.successPages).toHaveLength(1)
    expect(saved.successPages?.[0]).toMatchObject({ title: 'Aルート完了', description: 'ご回答ありがとう' })
  })

  it('初期未編集 (完了ページを触らない) は onSave に successPages を送らない (absent)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave, initialSuccessPages: [{ id: 'sp1', slug: 'SP_A', title: 'A完了' }] })} />)
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { successPages?: unknown }
    expect('successPages' in saved).toBe(false)
  })

  it('initialSuccessPages が管理パネルに復元表示される (T-E5 load)', () => {
    render(<FormBuilder {...base({ initialSuccessPages: [{ id: 'sp1', slug: 'SP_A', title: '既存完了ページ' }] })} />)
    expect((screen.getByLabelText('完了ページの見出し') as HTMLInputElement).value).toBe('既存完了ページ')
  })

  it('完了ページを削除すると onSave の successPages から消える', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave, initialSuccessPages: [{ id: 'sp1', slug: 'SP_A', title: 'A完了' }] })} />)
    fireEvent.click(screen.getByLabelText('完了ページを削除'))
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { successPages?: unknown[] }
    expect(saved.successPages).toEqual([])
  })
})

describe('FormBuilder — submit rule の per-route SP 選択 (T-F1)', () => {
  it('submit rule 行の完了ページ select が successPages 候補で有効化され選択が onSave に反映される', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave, initialLogic: [submitRule], initialSuccessPages: [{ id: 'sp1', slug: 'SP_A', title: 'Aルート完了' }] })} />)
    // q1 の設定パネルを開く (項目を選択)。初期選択は先頭 field = q1。
    const spSelect = screen.getByLabelText('送信先の完了ページ') as HTMLSelectElement
    expect(spSelect.disabled).toBe(false)
    // 候補に SP が並ぶ。
    expect(within(spSelect).getByText('Aルート完了')).toBeTruthy()
    fireEvent.change(spSelect, { target: { value: 'sp1' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { logic: HarnessLogicRule[] }
    const rule = saved.logic.find((r) => r.action === 'submit')
    expect(rule?.targetFieldId).toBe('sp1')
  })
})
