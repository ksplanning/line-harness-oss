// @vitest-environment jsdom
/**
 * form-media-limits (Batch B / T-B1〜T-B4) — file 設定 UI に「最大サイズ」+「動画を許可」を追加。
 *   T-B1 最大サイズ select: 表示 / 10MB→maxSizeKb=10240 / 2MB(標準)→undefined (既定=push しない)
 *   T-B2 動画 checkbox ON: curated 動画拡張子を allowedExtensions に union (既存拡張子保持) / 空=all は空のまま
 *   T-B3 動画 checkbox OFF: curated 動画拡張子のみ除去 (他保持) / checked 状態は現拡張子から都度計算 (手動 input 追随)
 *   T-B4 正直注記表示 + 既存 file UI (複数ファイル/拡張子 input) 非退行
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

function fileField(config: Record<string, unknown> = {}): HarnessField {
  return { id: 'file1', type: 'file', label: '添付', required: false, position: 0, config: config as HarnessField['config'] }
}

describe('form-media-limits — 最大サイズ select (T-B1)', () => {
  it('file field 選択時に「最大サイズ」select が表示される', () => {
    render(<FormBuilder {...base({ initialFields: [fileField()] })} />)
    expect(screen.getByLabelText('最大サイズ')).toBeTruthy()
  })

  it('10MB を選ぶと config.maxSizeKb=10240 が保存 payload に載る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fileField()], onSave })} />)
    fireEvent.change(screen.getByLabelText('最大サイズ'), { target: { value: '10240' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.maxSizeKb).toBe(10240)
  })

  it('2MB(標準) を選ぶと maxSizeKb は未設定 (既定=push しない)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fileField({ maxSizeKb: 10240 })], onSave })} />)
    fireEvent.change(screen.getByLabelText('最大サイズ'), { target: { value: '2048' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.maxSizeKb).toBeUndefined()
  })
})

describe('form-media-limits — 動画を許可 checkbox (T-B2/T-B3)', () => {
  it('ON で curated 動画拡張子を union し既存拡張子を保持する', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fileField({ allowedExtensions: ['pdf'] })], onSave })} />)
    const box = screen.getByLabelText('動画を許可') as HTMLInputElement
    expect(box.checked).toBe(false) // pdf のみ = 動画無し
    fireEvent.click(box)
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    const exts = saved.fields[0].config.allowedExtensions ?? []
    expect(exts).toContain('pdf')
    expect(exts).toContain('mp4')
    expect(exts).toContain('mov')
    expect(exts).toContain('m4v')
    expect(exts).toContain('webm')
  })

  it('allowedExtensions が空(=all) は既に動画許可 = checkbox は checked', () => {
    render(<FormBuilder {...base({ initialFields: [fileField({ allowedExtensions: [] })] })} />)
    const box = screen.getByLabelText('動画を許可') as HTMLInputElement
    expect(box.checked).toBe(true)
  })

  it('OFF で curated 動画拡張子のみ除去し他拡張子を保持する', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fileField({ allowedExtensions: ['pdf', 'mp4', 'mov'] })], onSave })} />)
    const box = screen.getByLabelText('動画を許可') as HTMLInputElement
    expect(box.checked).toBe(true) // mp4/mov を含む
    fireEvent.click(box)
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.allowedExtensions).toEqual(['pdf'])
  })

  it('checked 状態は現 allowedExtensions から都度計算 (手動 input 編集に追随)', () => {
    render(<FormBuilder {...base({ initialFields: [fileField({ allowedExtensions: ['pdf', 'mp4'] })] })} />)
    const box = screen.getByLabelText('動画を許可') as HTMLInputElement
    expect(box.checked).toBe(true)
    // 許可拡張子 input を手動編集して動画拡張子を外す → checkbox が unchecked に追随
    fireEvent.change(screen.getByLabelText('許可拡張子'), { target: { value: 'pdf' } })
    expect((screen.getByLabelText('動画を許可') as HTMLInputElement).checked).toBe(false)
  })
})

describe('form-media-limits — 正直注記 + 既存 file UI 非退行 (T-B4)', () => {
  it('動画設定に容量/実アップロード確認の正直注記が出る', () => {
    render(<FormBuilder {...base({ initialFields: [fileField()] })} />)
    expect(screen.getByText(/最大サイズ.*上げて/)).toBeTruthy()
    expect(screen.getByText(/公開フォームでの実アップロードで確認/)).toBeTruthy()
  })

  it('既存の「複数ファイルを許可」checkbox と「許可拡張子」input が従来どおり出る', () => {
    render(<FormBuilder {...base({ initialFields: [fileField()] })} />)
    expect(screen.getByLabelText('複数ファイル許可')).toBeTruthy()
    expect(screen.getByLabelText('許可拡張子')).toBeTruthy()
  })

  it('「複数ファイルを許可」に共有上限の最大10件が明記される', () => {
    render(<FormBuilder {...base({ initialFields: [fileField()] })} />)
    expect(screen.getByText('（最大10件）')).toBeTruthy()
  })
})

describe('edit-branch-editability — フォーム単位「回答後の編集を許可する」トグル (D-4)', () => {
  it('肯定表現のトグルが出て既定 OFF (allow_post_edit 0 = 編集不可)', () => {
    render(<FormBuilder {...base()} />)
    const box = screen.getByLabelText('回答後の編集を許可する') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(box.dataset.settingId).toBe('allow-post-edit')
  })

  it('回答者が編集リンクから修正できることを日常語で説明する', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.getByText(/編集リンクから回答を修正/)).toBeTruthy()
  })

  it('既定 (未操作) の保存では PUT body allowPostEdit=0 が載る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { allowPostEdit?: number }
    expect(saved.allowPostEdit).toBe(0)
  })

  it('トグルを入れると保存で allowPostEdit=1 が載る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByLabelText('回答後の編集を許可する'))
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { allowPostEdit?: number }
    expect(saved.allowPostEdit).toBe(1)
  })

  it('initialAllowPostEdit=1 で初期化するとトグルは ON (許可済) 表示', () => {
    render(<FormBuilder {...base({ initialAllowPostEdit: 1 })} />)
    const box = screen.getByLabelText('回答後の編集を許可する') as HTMLInputElement
    expect(box.checked).toBe(true)
  })
})
