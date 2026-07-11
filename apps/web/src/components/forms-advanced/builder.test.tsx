// @vitest-environment jsdom
/**
 * FormBuilder (F-2 / T-B1) — D&D フォームビルダーの component test。
 *   - パレット → キャンバス追加 (click-to-add = 素人/375px 経路)
 *   - field 選択 → 設定 (ラベル/必須/文字数/選択肢/ファイル拡張子)
 *   - 削除は行内確認 (window.confirm 不使用 / M-16)
 *   - 保存が onSave に定義を渡す (position 再採番)
 *   - publish gate UI (in_review → 公開確認カード / draft → レビュー依頼)
 * (実 D&D drag は jsdom 非対応 → click-to-add で機能を担保。drag は browser-evaluator が実機確認。)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
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

describe('FormBuilder — パレット & 追加 (T-B1)', () => {
  it('パレットに日本語 field 種別を出す (英語 type 名を見せない)', () => {
    render(<FormBuilder {...base()} />)
    const palette = screen.getByTestId('palette')
    expect(within(palette).getByText('1行テキスト')).toBeTruthy()
    expect(within(palette).getByText('単一選択')).toBeTruthy()
    expect(within(palette).getByText('ファイル添付')).toBeTruthy()
    // MVP subset 外は無い
    expect(within(palette).queryByText('マトリクス')).toBeNull()
  })

  it('パレット項目をタップするとキャンバスに追加される', () => {
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    const canvas = screen.getByTestId('canvas')
    expect(within(canvas).getByText('1行テキスト')).toBeTruthy()
  })

  it('空状態のガイドが出る', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.getByText(/パレットから項目を/)).toBeTruthy()
  })
})

describe('FormBuilder — 設定パネル', () => {
  it('field 選択でラベルを編集するとカードに反映', () => {
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    // 追加時に自動選択 → 設定パネルのラベル入力を編集
    const labelInput = screen.getByLabelText('ラベル') as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: 'お名前' } })
    const canvas = screen.getByTestId('canvas')
    expect(within(canvas).getByText('お名前')).toBeTruthy()
  })

  it('必須チェックで必須バッジが出る', () => {
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    fireEvent.click(screen.getByLabelText('必須'))
    expect(screen.getByText('必須')).toBeTruthy()
  })

  it('テキストは最大文字数、選択は選択肢、ファイルは拡張子の設定が出る', () => {
    render(<FormBuilder {...base()} />)
    // text → maxLength
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    expect(screen.getByLabelText('最大文字数')).toBeTruthy()
    // choice → 選択肢
    fireEvent.click(screen.getByLabelText('単一選択を追加'))
    expect(screen.getByLabelText('選択肢1')).toBeTruthy()
    // file → 拡張子
    fireEvent.click(screen.getByLabelText('ファイル添付を追加'))
    expect(screen.getByLabelText('許可拡張子')).toBeTruthy()
    expect(screen.getByLabelText('複数ファイル許可')).toBeTruthy()
  })
})

describe('FormBuilder — 削除 (M-16 行内確認)', () => {
  it('削除は window.confirm でなく行内で はい/いいえ', () => {
    render(<FormBuilder {...base()} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    fireEvent.click(screen.getByLabelText('削除'))
    // 行内確認が出る (native confirm でない)
    expect(screen.getByText('削除しますか？')).toBeTruthy()
    fireEvent.click(screen.getByText('はい'))
    const canvas = screen.getByTestId('canvas')
    expect(within(canvas).queryByText('1行テキスト')).toBeNull()
  })
})

describe('FormBuilder — 保存', () => {
  it('保存で onSave に fields を渡す (position 採番)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByLabelText('1行テキストを追加'))
    fireEvent.click(screen.getByLabelText('数値を追加'))
    fireEvent.click(screen.getByText('保存'))
    expect(onSave).toHaveBeenCalledTimes(1)
    const def = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(def.fields.map((f) => f.type)).toEqual(['text', 'number'])
    expect(def.fields.map((f) => f.position)).toEqual([0, 1])
  })
})

describe('FormBuilder — publish gate UI (T-B3 / N-7)', () => {
  it('draft はレビュー依頼ボタン', () => {
    const onSubmitForReview = vi.fn()
    render(<FormBuilder {...base({ status: 'draft', onSubmitForReview })} />)
    fireEvent.click(screen.getByText('レビュー依頼'))
    expect(onSubmitForReview).toHaveBeenCalled()
  })

  it('in_review は公開ボタン → 確認カード → 公開する で onPublish', () => {
    const onPublish = vi.fn()
    render(<FormBuilder {...base({ status: 'in_review', onPublish })} />)
    fireEvent.click(screen.getByText('公開'))
    expect(screen.getByTestId('publish-confirm')).toBeTruthy()
    fireEvent.click(screen.getByText('公開する'))
    expect(onPublish).toHaveBeenCalled()
  })

  it('out_of_sync は未同期バッジ', () => {
    render(<FormBuilder {...base({ syncStatus: 'out_of_sync' })} />)
    expect(screen.getByTestId('sync-badge')).toBeTruthy()
  })
})

describe('FormBuilder — Formaloo 再取り込み (pull / N-8 / B2/B3)', () => {
  const existing: HarnessField = { id: 'ex1', type: 'text', label: '既存項目', required: false, position: 0, config: {} }

  it('再取り込み → 行内確認(M-16) → はい で ok:true 時 editor を置換', async () => {
    const onReimport = vi.fn(async () => ({
      ok: true,
      fields: [{ id: 'new1', type: 'text' as const, label: '新項目', required: false, position: 0, config: {} }],
      logic: [],
    }))
    render(<FormBuilder {...base({ initialFields: [existing], onReimport })} />)
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    // 行内確認 (window.confirm 不使用 / M-16)
    const confirm = screen.getByTestId('reimport-confirm')
    fireEvent.click(within(confirm).getByText('はい'))
    const canvas = screen.getByTestId('canvas')
    expect(await within(canvas).findByText('新項目')).toBeTruthy()
    expect(within(canvas).queryByText('既存項目')).toBeNull()
    expect(onReimport).toHaveBeenCalledTimes(1)
  })

  it('ok:false は editor を保持 (B2 = 失敗時に空へ潰さない)', async () => {
    const onReimport = vi.fn(async () => ({ ok: false, fields: [], logic: [], note: 'x' }))
    render(<FormBuilder {...base({ initialFields: [existing], onReimport })} />)
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    await screen.findByText('Formaloo から再取り込み') // reimporting 解除まで待つ
    expect(within(screen.getByTestId('canvas')).getByText('既存項目')).toBeTruthy()
  })

  it('null 返却でも editor を保持', async () => {
    const onReimport = vi.fn(async () => null)
    render(<FormBuilder {...base({ initialFields: [existing], onReimport })} />)
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    await screen.findByText('Formaloo から再取り込み')
    expect(within(screen.getByTestId('canvas')).getByText('既存項目')).toBeTruthy()
  })

  it('いいえ で no-op (onReimport 未呼び出し)', () => {
    const onReimport = vi.fn()
    render(<FormBuilder {...base({ initialFields: [existing], onReimport })} />)
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('いいえ'))
    expect(onReimport).not.toHaveBeenCalled()
    expect(screen.queryByTestId('reimport-confirm')).toBeNull()
  })

  it('実行中はボタン disabled (二重実行防止)', async () => {
    let resolveFn: (v: unknown) => void = () => {}
    const onReimport = vi.fn(() => new Promise((r) => { resolveFn = r }))
    render(<FormBuilder {...base({ initialFields: [existing], onReimport })} />)
    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    const btn = screen.getByText('取り込み中...') as HTMLButtonElement
    expect(btn.hasAttribute('disabled')).toBe(true)
    resolveFn({ ok: true, fields: [], logic: [] })
    await screen.findByText('Formaloo から再取り込み')
  })

  it('onReimport 未指定なら再取り込みボタンは出ない', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.queryByText('Formaloo から再取り込み')).toBeNull()
  })
})
