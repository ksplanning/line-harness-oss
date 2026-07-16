// @vitest-environment jsdom
/**
 * route-terminal-submit (T-E1) — preview 凡例に「ここで送信」+ page_break の「Continue のみ空画面」注記。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import FormPreview from './form-preview'
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared'

afterEach(() => cleanup())

const q1: HarnessField = { id: 'q1', type: 'choice', label: 'ルート', required: false, position: 0, config: { choices: ['A'] } }
const pbA: HarnessField = { id: 'pbA', type: 'page_break', label: 'Aページ', required: false, position: 1, config: {} }
const A1: HarnessField = { id: 'A1', type: 'text', label: 'A1', required: false, position: 2, config: {} }

const submitLogic: HarnessLogicRule[] = [
  { id: 's1', sourceFieldId: 'A1', operator: 'equals', value: '', action: 'submit', targetFieldId: '', terminalTrigger: 'on_answered' },
]

describe('T-E1 — preview 凡例 + page_break 注記', () => {
  it('submit rule があると「ここで送信」凡例が描画される', () => {
    render(<FormPreview title="t" fields={[q1, pbA, A1]} formType="multi_step" logic={submitLogic} />)
    expect(screen.getByTestId('preview-submit-note').textContent).toMatch(/ここで送信/)
  })

  it('page_break があると Continue のみの空画面注記が出る', () => {
    render(<FormPreview title="t" fields={[q1, pbA, A1]} formType="multi_step" logic={submitLogic} />)
    expect(screen.getByTestId('preview-pagebreak-note').textContent).toMatch(/Continue/)
  })

  it('submit rule も page_break も無いフォームは新規注記を出さない (回帰)', () => {
    render(<FormPreview title="t" fields={[q1, A1]} logic={[]} />)
    expect(screen.queryByTestId('preview-submit-note')).toBeNull()
    expect(screen.queryByTestId('preview-pagebreak-note')).toBeNull()
  })
})
