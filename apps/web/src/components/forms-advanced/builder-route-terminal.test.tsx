// @vitest-environment jsdom
/**
 * route-terminal-submit (T-B1/T-B2/T-B3) — builder の「ここで送信」option + host 自動 required 化 +
 *   lint(c) 注記 + lint(a/b/d) 上部 surface + 誤警告なし回帰。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import FormBuilder from './builder'
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared'

afterEach(() => cleanup())

const choiceSrc: HarnessField = {
  id: 'q1', type: 'choice', label: 'ルート', required: false, position: 0,
  config: { choices: ['A', 'B', 'C'], choiceItems: [{ title: 'A', slug: 'ca' }, { title: 'B', slug: 'cb' }, { title: 'C', slug: 'cc' }] },
}
const pbA: HarnessField = { id: 'pbA', type: 'page_break', label: 'Aページ', required: false, position: 1, config: {} }
const A1: HarnessField = { id: 'A1', type: 'text', label: 'A1', required: false, position: 2, config: {} }
const A2: HarnessField = { id: 'A2', type: 'text', label: 'A2', required: false, position: 3, config: {} }
const pbB: HarnessField = { id: 'pbB', type: 'page_break', label: 'Bページ', required: false, position: 4, config: {} }
const B1: HarnessField = { id: 'B1', type: 'text', label: 'B1', required: false, position: 5, config: {} }
const B2: HarnessField = { id: 'B2', type: 'text', label: 'B2', required: false, position: 6, config: {} }
const abcFields = [choiceSrc, pbA, A1, A2, pbB, B1, B2]
const abcJumps: HarnessLogicRule[] = [
  { id: 'j1', sourceFieldId: 'q1', operator: 'equals', value: 'A', action: 'jump', targetFieldId: 'pbA' },
  { id: 'j2', sourceFieldId: 'q1', operator: 'equals', value: 'B', action: 'jump', targetFieldId: 'pbB' },
]

function base(overrides = {}) {
  return { formTitle: 'テスト', status: 'draft' as const, layoutMode: 'desktop' as const, initialFields: [], initialLogic: [], onSave: vi.fn(), ...overrides }
}
function selectField(label: string) {
  fireEvent.click(within(screen.getByTestId('canvas')).getByText(label))
}

describe('T-B1 — 「ここで送信」option + addRule affordance + multi_step 自動切替 + lint(c)', () => {
  it('分岐アクション select に「ここで送信（完了ページへ）」option が並ぶ', () => {
    render(<FormBuilder {...base({ initialFields: [choiceSrc, A1], initialLogic: [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'A', action: 'show', targetFieldId: 'A1' },
    ] })} />)
    selectField('ルート')
    const actionSel = screen.getByLabelText('分岐アクション') as HTMLSelectElement
    expect(Array.from(actionSel.options).map((o) => o.value)).toContain('submit')
    expect(within(actionSel).getByText('ここで送信（完了ページへ）')).toBeTruthy()
  })

  it('入力1項目のみでも「ここで送信」を追加できる (addRule/disabled 前提緩和)', () => {
    // A2 (入力1個) だけ選択 → 通常「分岐を追加」は disabled だが「ここで送信」は追加可
    render(<FormBuilder {...base({ initialFields: [A2], initialLogic: [], initialFormType: 'multi_step' })} />)
    selectField('A2')
    const addSubmit = screen.getByText('＋「ここで送信」を追加')
    fireEvent.click(addSubmit)
    // submit rule 行が現れる (アクション select が submit を選択状態)
    const actionSel = screen.getByLabelText('分岐アクション') as HTMLSelectElement
    expect(actionSel.value).toBe('submit')
  })

  it('simple で「ここで送信」を追加すると multi_step へ自動切替 + 可視通知', () => {
    render(<FormBuilder {...base({ initialFields: [A2], initialLogic: [], initialFormType: 'simple' })} />)
    selectField('A2')
    fireEvent.click(screen.getByText('＋「ここで送信」を追加'))
    expect(screen.getByTestId('formtype-notice')).toBeTruthy()
  })

  it('submit rule 行に lint(c) 注記 (必須スキップ) が描画される', () => {
    render(<FormBuilder {...base({ initialFields: [A2], initialLogic: [
      { id: 's1', sourceFieldId: 'A2', operator: 'equals', value: '', action: 'submit', targetFieldId: '', terminalTrigger: 'on_answered' },
    ], initialFormType: 'multi_step' })} />)
    selectField('A2')
    const note = screen.getByTestId('submit-lint-note')
    expect(note.textContent).toMatch(/必須/)
    expect(note.textContent).toMatch(/スキップ/)
  })
})

describe('T-B3 — submit 追加で host 自動 required 化 / 削除で復元', () => {
  it('submit 追加 → host required=true / 削除 → 元の required(false) に復元', () => {
    render(<FormBuilder {...base({ initialFields: [A2], initialLogic: [], initialFormType: 'multi_step' })} />)
    selectField('A2')
    // 追加前: 必須 off
    expect((screen.getByLabelText('必須') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByText('＋「ここで送信」を追加'))
    // 追加後: 自動 required 化
    expect((screen.getByLabelText('必須') as HTMLInputElement).checked).toBe(true)
    // 削除 → 元の false に復元
    fireEvent.click(screen.getByLabelText('分岐を削除'))
    expect((screen.getByLabelText('必須') as HTMLInputElement).checked).toBe(false)
  })
})

describe('F-MED-1 — submit 状態の一元化 (required 復元 / 有効 target / 重複 submit 禁止)', () => {
  it('submit → 表示 へ action 変更で required を復元し、有効 target を設定 (save filter で消えない)', () => {
    // submit で auto-required 化された状態を再現: host A2 は required=true・元値 terminalHostWasRequired=false。
    const A2req: HarnessField = { id: 'A2', type: 'text', label: 'A2', required: true, position: 0, config: {} }
    render(<FormBuilder {...base({ initialFields: [A2req, B2], initialLogic: [
      { id: 's1', sourceFieldId: 'A2', operator: 'equals', value: '', action: 'submit', targetFieldId: '', terminalTrigger: 'on_answered', terminalHostWasRequired: false },
    ], initialFormType: 'multi_step' })} />)
    selectField('A2')
    // submit 状態: host 必須 (auto=true)。
    expect((screen.getByLabelText('必須') as HTMLInputElement).checked).toBe(true)
    const actionSel = screen.getByLabelText('分岐アクション') as HTMLSelectElement
    // submit → 表示(show) へ変更
    fireEvent.change(actionSel, { target: { value: 'show' } })
    // required は元の false へ復元
    expect((screen.getByLabelText('必須') as HTMLInputElement).checked).toBe(false)
    // 分岐対象 (show の target) は有効 field (空でない = save filter で消えない)
    const tgt = screen.getByLabelText('分岐対象') as HTMLSelectElement
    expect(tgt.value).not.toBe('')
    expect(tgt.value).toBe('B2')
  })

  it('同一 host に 2 個目の submit を追加できない (先頭勝ち・重複禁止)', () => {
    render(<FormBuilder {...base({ initialFields: [A2], initialLogic: [
      { id: 's1', sourceFieldId: 'A2', operator: 'equals', value: '', action: 'submit', targetFieldId: '', terminalTrigger: 'on_answered', terminalHostWasRequired: false },
    ], initialFormType: 'multi_step' })} />)
    selectField('A2')
    // 既に submit が 1 個 → 追加ボタンを押しても 2 個目は増えない
    fireEvent.click(screen.getByText('＋「ここで送信」を追加'))
    const actionSels = screen.getAllByLabelText('分岐アクション') as HTMLSelectElement[]
    const submitRows = actionSels.filter((s) => s.value === 'submit')
    expect(submitRows.length).toBe(1)
  })
})

describe('T-B2 — lint(a/b/d) 上部 surface + 誤警告なし', () => {
  it('jump ルートを submit で閉じていない → なだれ込み警告が上部 notice に出る', () => {
    render(<FormBuilder {...base({ initialFields: abcFields, initialLogic: abcJumps, initialFormType: 'multi_step' })} />)
    const notice = screen.getByTestId('route-terminal-warnings')
    expect(notice.textContent).toMatch(/なだれ込み/)
  })

  it('純 show/hide フォームは route-terminal 警告 notice が 0 件 (誤警告なし)', () => {
    render(<FormBuilder {...base({ initialFields: [choiceSrc, A1], initialLogic: [
      { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'A', action: 'show', targetFieldId: 'A1' },
    ] })} />)
    expect(screen.queryByTestId('route-terminal-warnings')).toBeNull()
  })
})
