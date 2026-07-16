// @vitest-environment jsdom
/**
 * form-route-branching (T-D2) — FormPreview の multi_step 注記 + jump 注記 (Batch C 整合)。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import FormPreview from './form-preview'
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared'

afterEach(() => cleanup())

const fields: HarnessField[] = [
  { id: 'q1', type: 'choice', label: 'ルート', required: true, position: 0, config: { choices: ['A', 'C'] } },
  { id: 'pb', type: 'page_break', label: '2ページ目', required: false, position: 1, config: {} },
]
const jumpLogic: HarnessLogicRule[] = [
  { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'C', action: 'jump', targetFieldId: 'pb' },
]

describe('T-D2 — FormPreview 注記', () => {
  it('multi_step 時「1問ずつ表示」注記を出す', () => {
    render(<FormPreview title="t" fields={fields} formType="multi_step" />)
    expect(screen.getByTestId('preview-multistep-note')).toBeTruthy()
  })

  it('simple 時は multi_step 注記を出さない', () => {
    render(<FormPreview title="t" fields={fields} formType="simple" />)
    expect(screen.queryByTestId('preview-multistep-note')).toBeNull()
  })

  it('jump rule があれば jump 注記を出す', () => {
    render(<FormPreview title="t" fields={fields} formType="multi_step" logic={jumpLogic} />)
    expect(screen.getByTestId('preview-jump-note')).toBeTruthy()
    expect(screen.getByTestId('preview-jump-note').textContent).toMatch(/ページへ飛ぶ/)
  })

  it('jump rule 無しなら jump 注記を出さない (後方互換)', () => {
    render(<FormPreview title="t" fields={fields} formType="simple" logic={[]} />)
    expect(screen.queryByTestId('preview-jump-note')).toBeNull()
    expect(screen.queryByTestId('preview-multistep-note')).toBeNull()
  })

  it('formType/logic 未指定 (従来呼び出し) は注記なし (後方互換)', () => {
    render(<FormPreview title="t" fields={fields} />)
    expect(screen.queryByTestId('preview-multistep-note')).toBeNull()
    expect(screen.queryByTestId('preview-jump-note')).toBeNull()
  })
})
